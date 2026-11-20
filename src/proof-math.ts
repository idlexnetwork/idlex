// The math anyone needs to check Idlex's proofs, with nothing but viem: receipt leaves, the Merkle root over them
// (the root sealed onchain for each epoch, and the seed of each hour of node rewards), and each job's reward draw.
// Same results as receiptLeaf/drawReward in protocol.ts and merkleRoot in merkle.ts, without Node-only imports, so
// it can also run in a browser. verify-proofs.ts checks both copies agree.
import { concat, encodeAbiParameters, keccak256, type Address, type Hex } from "viem";

export type ProofReceipt = { jobId: Hex; node: Address; outputHash: Hex; gpuMs: bigint; epoch: bigint };

/** Receipt leaf: keccak256(keccak256(abi.encode(jobId, node, outputHash, gpuMs, epoch))). */
export function leafOf(r: ProofReceipt): Hex {
  const inner = keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "address" }, { type: "bytes32" }, { type: "uint64" }, { type: "uint64" }],
      [r.jobId, r.node, r.outputHash, r.gpuMs, r.epoch],
    ),
  );
  return keccak256(inner);
}

const hashPair = (a: Hex, b: Hex): Hex => (BigInt(a) < BigInt(b) ? keccak256(concat([a, b])) : keccak256(concat([b, a])));

/** Merkle root over sorted leaves, hashing sorted pairs with keccak256; zero for no leaves. */
export function rootOf(leaves: Hex[]): Hex {
  if (leaves.length === 0) return `0x${"00".repeat(32)}`;
  let level = [...leaves].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
  while (level.length > 1) {
    const next: Hex[] = [];
    for (let i = 0; i < level.length; i += 2) next.push(i + 1 < level.length ? hashPair(level[i], level[i + 1]) : level[i]);
    level = next;
  }
  return level[0];
}

const IDLEX = 10n ** 18n;

/** A job's reward in an hour seeded by `seed`: whole $IDLEX between min and max, from keccak256(seed, jobId). */
export function drawOf(seed: Hex, jobId: Hex, min: bigint, max: bigint): bigint {
  const lo = min / IDLEX;
  const hi = max / IDLEX;
  const h = BigInt(keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }], [seed, jobId])));
  return (lo + (h % (hi - lo + 1n))) * IDLEX;
}

export type Check = { ok: boolean | null; label: string; detail?: string };

export type EpochProof = {
  epoch: number;
  root: Hex;
  count: number;
  sealTx: Hex | null;
  ledger: Address | null;
  receipts: { jobId: Hex; node: Address; outputHash: Hex; gpuMs: string; receiptEpoch: number; leaf: Hex }[];
};

/** Everything about an epoch seal that can be checked offline: every leaf, and the root over them. */
export function checkEpoch(p: EpochProof): Check[] {
  const bad = p.receipts.filter(
    (r) => leafOf({ jobId: r.jobId, node: r.node, outputHash: r.outputHash, gpuMs: BigInt(r.gpuMs), epoch: BigInt(r.receiptEpoch) }).toLowerCase() !== r.leaf.toLowerCase(),
  );
  const root = rootOf(p.receipts.map((r) => r.leaf));
  return [
    { ok: p.receipts.length === p.count, label: `${p.receipts.length} receipts published, ${p.count} sealed` },
    { ok: bad.length === 0, label: "every receipt hashes to its leaf", detail: bad.length ? `${bad.length} leaf mismatch(es), first job ${bad[0].jobId}` : undefined },
    { ok: root.toLowerCase() === p.root.toLowerCase(), label: "the leaves give the published root", detail: root },
  ];
}

export type HourProof = {
  round: number;
  seed: Hex;
  budget: string;
  rules: { min: string; max: string; cap: string } | null;
  receipts: { jobId: Hex; node: Address; owner: Address; outputHash: Hex; gpuMs: string; receiptEpoch: number; leaf: Hex }[];
  rewards: { owner: Address; jobs: number; idlex: string }[];
  creditTx: Hex | null;
  rewardsV2: Address | null;
};

/**
 * Everything about an hour's credit that can be checked offline, given its rules (read them from the contract):
 * the leaves, the seed, each owner's draws, and the credited amounts (scaled evenly when the hour went over budget).
 * Owners left out are those that did not hold the minimum at close; that part needs the chain at that time.
 */
export function checkHour(p: HourProof, rules: { min: bigint; max: bigint; cap: bigint }): { checks: Check[]; owners: { owner: Address; drawn: bigint; credited: bigint | null; expected: bigint | null }[] } {
  const bad = p.receipts.filter(
    (r) => leafOf({ jobId: r.jobId, node: r.node, outputHash: r.outputHash, gpuMs: BigInt(r.gpuMs), epoch: BigInt(r.receiptEpoch) }).toLowerCase() !== r.leaf.toLowerCase(),
  );
  const seed = rootOf(p.receipts.map((r) => r.leaf));
  const drawn = new Map<string, bigint>();
  for (const r of p.receipts) drawn.set(r.owner.toLowerCase(), (drawn.get(r.owner.toLowerCase()) ?? 0n) + drawOf(p.seed, r.jobId, rules.min, rules.max));
  const credited = new Map(p.rewards.map((x) => [x.owner.toLowerCase(), BigInt(x.idlex)]));
  const eligibleTotal = [...credited.keys()].reduce((a, o) => a + (drawn.get(o) ?? 0n), 0n);
  const budget = BigInt(p.budget);
  const scaled = eligibleTotal > budget;
  const expect = (d: bigint) => (scaled ? (d * budget) / eligibleTotal : d);
  const owners = [...drawn.entries()].map(([owner, d]) => ({
    owner: owner as Address,
    drawn: d,
    credited: credited.get(owner) ?? null,
    expected: credited.has(owner) ? expect(d) : null,
  }));
  const wrong = owners.filter((o) => o.credited !== null && o.credited !== o.expected);
  const creditedTotal = [...credited.values()].reduce((a, b) => a + b, 0n);
  return {
    owners,
    checks: [
      { ok: bad.length === 0, label: "every receipt hashes to its leaf", detail: bad.length ? `${bad.length} mismatch(es)` : undefined },
      { ok: seed.toLowerCase() === p.seed.toLowerCase(), label: "the hour's seed is the Merkle root of its receipts", detail: seed },
      { ok: [...credited.keys()].every((o) => drawn.has(o)), label: "every credited owner ran jobs in this hour" },
      {
        ok: wrong.length === 0,
        label: scaled ? "each credit is its draws, scaled evenly to the budget" : "each credit is the sum of its draws",
        detail: wrong.length ? `${wrong.length} owner(s) differ, first ${wrong[0].owner}` : undefined,
      },
      { ok: creditedTotal <= rules.cap, label: "the hour stays within its hourly cap" },
    ],
  };
}
