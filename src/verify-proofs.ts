// Checks Idlex's proofs yourself: recomputes every receipt leaf, each epoch's Merkle root and each hour's reward
// draws from the published receipts, and compares them with what the contracts hold on Robinhood Chain. It reads
// the chain directly with the contract addresses below, so it doesn't have to trust the Idlex server.
//
//   node src/verify-proofs.ts                       the latest sealed epoch and the latest credited hour
//   node src/verify-proofs.ts --epoch 1             one epoch seal
//   node src/verify-proofs.ts --hour 37             one hour of node rewards
//   node src/verify-proofs.ts --network URL --rpc URL
//
// Exit code 1 if any check fails.
import { createPublicClient, decodeEventLog, http, parseAbi, type Address, type Hex } from "viem";
import { checkEpoch, checkHour, drawOf, leafOf, rootOf, type Check, type EpochProof, type HourProof } from "./proof-math.ts";
import { merkleRoot } from "./merkle.ts";
import { drawReward, receiptLeaf } from "./protocol.ts";

// The proof and reward contracts on Robinhood Chain (chain id 4663).
const LEDGER: Address = "0x0D03D80729837fbCFE720Bd70879254fA4771cFb";
const REWARDS_V2: Address = "0xF5304d4a2Aa557D535BA671A81695A7f5D8a18e5";

const arg = (k: string) => {
  const i = process.argv.indexOf(k);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const NETWORK = (arg("--network") ?? "https://www.idlex.network").replace(/\/$/, "");
const RPC = arg("--rpc") ?? "https://rpc.mainnet.chain.robinhood.com";
const chain = { id: 4663, name: "Robinhood Chain", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } } as const;
const pub = createPublicClient({ chain, transport: http(RPC) });

const ABI = {
  ledger: parseAbi(["function seals(uint64 epoch) view returns (bytes32 root, uint32 count, uint64 sealedAt)"]),
  v2: parseAbi([
    "function rulesAt(uint64 round) view returns (uint256 minReward, uint256 maxReward, uint256 hourlyCap)",
    "function credited(uint64 round) view returns (bool)",
    "event Credited(uint64 indexed round, bytes32 seed, uint256 owners, uint256 jobs, uint256 amount)",
  ]),
};

let failed = 0;
function show(checks: Check[]) {
  for (const c of checks) {
    if (c.ok === false) failed++;
    console.log(`  ${c.ok === null ? "--" : c.ok ? "ok" : "XX"}  ${c.label}${c.detail && c.ok === false ? ` (${c.detail})` : ""}`);
  }
}
const get = async (path: string) => {
  const r = await fetch(NETWORK + path);
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json() as Promise<any>;
};
const idlex = (wei: bigint) => `${(Number(wei / 10n ** 16n) / 100).toLocaleString("en-US")} $IDLEX`;

/** proof-math.ts must agree with protocol.ts and merkle.ts. */
function selfCheck() {
  const r = { jobId: `0x${"ab".repeat(32)}` as Hex, node: "0x0000000000000000000000000000000000000001" as Address, outputHash: `0x${"cd".repeat(32)}` as Hex, gpuMs: 1234n, epoch: 7n };
  const leaves = [leafOf(r), leafOf({ ...r, epoch: 8n }), leafOf({ ...r, gpuMs: 1n })];
  const W = 10n ** 18n;
  return (
    leafOf(r) === receiptLeaf(r) &&
    rootOf(leaves) === merkleRoot(leaves) &&
    drawOf(leaves[0], r.jobId, 100n * W, 200n * W) === drawReward(leaves[0], r.jobId, 100n * W, 200n * W)
  );
}

async function epoch(n: number) {
  const p = (await get(`/api/network/proofs/epochs/${n}`)) as EpochProof;
  console.log(`\nepoch ${n} · ${p.receipts.length} receipts · root ${p.root}`);
  show(checkEpoch(p));
  const [root, count] = await pub.readContract({ address: LEDGER, abi: ABI.ledger, functionName: "seals", args: [BigInt(n)] });
  const sealed = root !== `0x${"00".repeat(32)}`;
  show([
    { ok: sealed ? true : null, label: sealed ? `the proof contract has a seal for epoch ${n}` : `no onchain seal for epoch ${n} (not sent, or nothing to seal)` },
    ...(sealed
      ? [
          { ok: root.toLowerCase() === p.root.toLowerCase(), label: "the onchain root is the published root", detail: root },
          { ok: count === p.count, label: `the onchain count (${count}) is the published count` },
        ]
      : []),
  ]);
}

async function hour(n: number) {
  const p = (await get(`/api/network/proofs/hours/${n}`)) as HourProof;
  console.log(`\nhour ${n} · ${p.receipts.length} receipts · seed ${p.seed}`);
  const [min, max, cap] = await pub.readContract({ address: REWARDS_V2, abi: ABI.v2, functionName: "rulesAt", args: [BigInt(n)] });
  console.log(`  rules from the contract: ${idlex(min)} to ${idlex(max)} per job, cap ${idlex(cap)} per hour`);
  const { checks, owners } = checkHour(p, { min, max, cap });
  show(checks);
  for (const o of owners) {
    console.log(`      ${o.owner}  drew ${idlex(o.drawn)}  ${o.credited === null ? "not credited (below the minimum at close)" : `credited ${idlex(o.credited)}`}`);
  }
  const done = await pub.readContract({ address: REWARDS_V2, abi: ABI.v2, functionName: "credited", args: [BigInt(n)] });
  if (!p.creditTx) return show([{ ok: done ? false : null, label: done ? "credited onchain, but no credit transaction published" : "not credited onchain yet" }]);
  const rc = await pub.getTransactionReceipt({ hash: p.creditTx });
  const log = rc.logs
    .filter((l) => l.address.toLowerCase() === REWARDS_V2.toLowerCase())
    .map((l) => {
      try {
        return decodeEventLog({ abi: ABI.v2, data: l.data, topics: l.topics });
      } catch {
        return null;
      }
    })
    .find((e) => e?.eventName === "Credited" && e.args.round === BigInt(n));
  const total = p.rewards.reduce((a, x) => a + BigInt(x.idlex), 0n);
  show([
    { ok: done, label: "the reward contract marks this hour credited" },
    { ok: Boolean(log), label: "the credit transaction emitted Credited for this hour", detail: p.creditTx },
    ...(log && log.eventName === "Credited"
      ? [
          { ok: log.args.seed.toLowerCase() === p.seed.toLowerCase(), label: "the onchain seed is the recomputed seed" },
          { ok: log.args.amount === total, label: `the onchain amount (${idlex(log.args.amount)}) is the published total` },
        ]
      : []),
  ]);
}

async function main() {
  console.log(`Idlex proof check · data from ${NETWORK} · chain via ${RPC}`);
  show([{ ok: selfCheck(), label: "this tool's math matches protocol.ts and merkle.ts (leaf, root, draw)" }]);
  const e = arg("--epoch");
  const h = arg("--hour");
  if (e || h) {
    if (e) await epoch(Number(e));
    if (h) await hour(Number(h));
  } else {
    const idx = await get("/api/network/proofs");
    const lastEpoch = idx.epochs.find((x: any) => x.receipts > 0);
    const lastHour = idx.hours.find((x: any) => x.receipts > 0);
    if (lastEpoch) await epoch(lastEpoch.epoch);
    if (lastHour) await hour(lastHour.round);
  }
  console.log(failed ? `\n${failed} check(s) FAILED` : "\nall checks passed");
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
