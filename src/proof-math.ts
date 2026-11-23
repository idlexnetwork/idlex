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

// ---- Holder Vault payouts --------------------------------------------------------------------------------------
// Each epoch the vault splits its NVDA budget over qualifying $IDLEX holders by balance x seconds held, plus up to
// 10 whitelisted team devices, each weighted as `multiplier` minimum holders for the whole epoch (a team device that
// also qualifies as a holder gets the larger of the two). Amounts are budget x share / all shares, rounded down;
// wallets that would get 0 are left out. The scheduler sends the result in one distribute(epoch, holders, amounts).

/** The first $IDLEX transfer (the mint) on Robinhood Chain: every balance starts there. */
export const IDLEX_FROM = 116_295_000n;

export type PayoutProof = {
  epoch: number;
  start: number;
  end: number;
  epochSeconds: number;
  tx: Hex | null;
  vault: Address | null;
  budget: string | null;
  multiplier: number | null;
  teamBps: number | null;
  holders: number | null;
  teamDevices: number | null;
  /** Recorded with each payout from the release of payout checks on; null for earlier epochs. */
  minimum: string | null;
  shares: [string, string, number][] | null;
};

/** The distribute call as decoded from the chain. */
export type PayoutCall = { to: Address | null; success: boolean; epoch: bigint; holders: Address[]; amounts: bigint[] };

export type PayoutRow = { wallet: Address; amount: bigint; bps: number; team: boolean; expected: bigint | null };

/** The split as the scheduler computes it from the recorded shares. */
export function splitOf(budget: bigint, shares: [string, bigint][]): Map<string, bigint> {
  const total = shares.reduce((a, [, s]) => a + s, 0n);
  const out = new Map<string, bigint>();
  if (total === 0n) return out;
  for (const [w, s] of shares) {
    const amount = (budget * s) / total;
    if (amount > 0n) out.set(w.toLowerCase(), amount);
  }
  return out;
}

/**
 * Checks one payout: the call itself, its total against the published budget, the team devices' share (team = the
 * wallets whitelisted onchain), and, where the split's inputs were recorded, that they recompute to exactly the
 * amounts sent with every team weight at multiplier x minimum x epoch length.
 */
export function checkPayout(p: PayoutProof, call: PayoutCall | null, team: Set<string>): { checks: Check[]; rows: PayoutRow[] } {
  const checks: Check[] = [];
  if (!call) {
    checks.push({ ok: p.tx ? false : null, label: p.tx ? "the payout transaction could not be read" : "no NVDA was sent for this epoch" });
    return { checks, rows: [] };
  }
  checks.push({
    ok: call.success && Boolean(p.vault) && call.to?.toLowerCase() === p.vault?.toLowerCase() && call.epoch === BigInt(p.epoch),
    label: `the payout is a successful distribute call to the Holder Vault for epoch ${p.epoch}`,
    detail: !call.success ? "the transaction reverted" : call.epoch !== BigInt(p.epoch) ? `it is for epoch ${call.epoch}` : "it was sent to another contract",
  });
  const paid = call.amounts.reduce((a, x) => a + x, 0n);
  const teamPaid = call.holders.reduce((a, w, i) => a + (team.has(w.toLowerCase()) ? call.amounts[i] : 0n), 0n);
  const isTeam = (w: string) => team.has(w.toLowerCase());
  const budget = p.budget ? BigInt(p.budget) : null;
  checks.push({
    ok: budget === null ? null : paid <= budget,
    label: budget === null ? "no budget was published for this epoch (before team weights)" : "the total sent is within the published budget",
    detail: budget === null ? undefined : `${paid} sent, budget ${budget}`,
  });
  const teamN = call.holders.filter(isTeam).length;
  const bps = paid > 0n ? Number((teamPaid * 10_000n) / paid) : 0;
  if (p.teamBps !== null) {
    checks.push({
      ok: Math.abs(bps - p.teamBps) <= 1,
      label: `team devices received ${(bps / 100).toFixed(2)}% of it, as published on the Rewards page`,
      detail: `published ${(p.teamBps / 100).toFixed(2)}%`,
    });
    checks.push({
      ok: teamN === p.teamDevices && call.holders.length - teamN === p.holders,
      label: `${call.holders.length - teamN} holders and ${teamN} team devices were paid, as published`,
      detail: `published ${p.holders} holders and ${p.teamDevices} team devices`,
    });
  }

  let expected: Map<string, bigint> | null = null;
  if (p.shares && p.minimum && budget !== null && p.multiplier !== null) {
    const shares = p.shares.map(([w, s, t]) => ({ w: w.toLowerCase(), s: BigInt(s), t: t === 1 }));
    expected = splitOf(budget, shares.map((x) => [x.w, x.s]));
    const sent = new Map(call.holders.map((w, i) => [w.toLowerCase(), call.amounts[i]] as const));
    const same = expected.size === sent.size && [...expected].every(([w, a]) => sent.get(w) === a);
    checks.push({ ok: same, label: `the recorded shares recompute to exactly the ${sent.size} amounts sent`, detail: same ? undefined : "amounts differ" });
    const weight = BigInt(p.minimum) * BigInt(p.epochSeconds) * BigInt(p.multiplier);
    const teamShares = shares.filter((x) => x.t);
    checks.push({
      ok: teamShares.every((x) => x.s >= weight),
      detail: `weight ${weight}`,
      label: `each team device counts as ${p.multiplier} minimum holders for the whole epoch (or its own holding, if larger)`,
    });
    const flags = shares.every((x) => x.t === team.has(x.w));
    checks.push({ ok: flags, label: "the wallets marked as team devices are exactly the ones whitelisted onchain" });
  } else {
    checks.push({ ok: null, label: "the split's inputs were not recorded for this epoch (recorded from Nov 2026 on), so only the call is checked" });
  }

  const rows = call.holders
    .map((w, i) => ({
      wallet: w,
      amount: call.amounts[i],
      bps: paid > 0n ? Number((call.amounts[i] * 10_000n) / paid) : 0,
      team: isTeam(w),
      expected: expected ? (expected.get(w.toLowerCase()) ?? 0n) : null,
    }))
    .sort((a, b) => (a.amount > b.amount ? -1 : a.amount < b.amount ? 1 : 0));
  return { checks, rows };
}

/**
 * Independent recompute of holdings from $IDLEX transfers (the deep check in verify-proofs.ts): replays every change
 * in order and returns each wallet's balance x seconds and lowest balance over [start, end]. A change is a transfer
 * leg (or a slash) with its block time; moves into and out of the staking contract must be dropped by the caller.
 */
export function holdingsOver(changes: { t: number; wallet: string; delta: bigint }[], start: number, end: number) {
  const bal = new Map<string, bigint>();
  const out = new Map<string, { accum: bigint; min: bigint }>();
  const since = new Map<string, number>();
  const touch = (w: string) => {
    if (!out.has(w)) out.set(w, { accum: 0n, min: bal.get(w) ?? 0n });
    if (!since.has(w)) since.set(w, start);
  };
  for (const c of changes) {
    if (c.t > end) break;
    const w = c.wallet.toLowerCase();
    if (c.t <= start) {
      bal.set(w, (bal.get(w) ?? 0n) + c.delta);
      continue;
    }
    touch(w);
    const o = out.get(w)!;
    o.accum += (bal.get(w) ?? 0n) * BigInt(c.t - since.get(w)!);
    bal.set(w, (bal.get(w) ?? 0n) + c.delta);
    since.set(w, c.t);
    if (bal.get(w)! < o.min) o.min = bal.get(w)!;
  }
  for (const [w, b] of bal) {
    touch(w);
    const o = out.get(w)!;
    o.accum += b * BigInt(end - since.get(w)!);
  }
  return out;
}
