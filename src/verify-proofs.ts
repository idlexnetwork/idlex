// Checks Idlex's proofs yourself: recomputes every receipt leaf, each epoch's Merkle root and each hour's reward
// draws from the published receipts, and compares them with what the contracts hold on Robinhood Chain. It reads
// the chain directly with the contract addresses below, so it doesn't have to trust the Idlex server.
//
//   node src/verify-proofs.ts                       the latest sealed epoch and the latest credited hour
//   node src/verify-proofs.ts --epoch 1             one epoch seal
//   node src/verify-proofs.ts --hour 37             one hour of node rewards
//   node src/verify-proofs.ts --payout 13           one epoch's NVDA payout to holders
//   node src/verify-proofs.ts --payout 13 --deep    ...and recompute every holding from $IDLEX transfers (slower)
//   node src/verify-proofs.ts --network URL --rpc URL
//
// Exit code 1 if any check fails.
import { createPublicClient, decodeEventLog, decodeFunctionData, http, parseAbi, type Address, type Hex } from "viem";
import {
  IDLEX_FROM, checkEpoch, checkHour, checkPayout, drawOf, holdingsOver, leafOf, rootOf, splitOf,
  type Check, type EpochProof, type HourProof, type PayoutCall, type PayoutProof,
} from "./proof-math.ts";
import { merkleRoot } from "./merkle.ts";
import { drawReward, receiptLeaf } from "./protocol.ts";

// The proof and reward contracts on Robinhood Chain (chain id 4663).
const LEDGER: Address = "0x0D03D80729837fbCFE720Bd70879254fA4771cFb";
const REWARDS_V2: Address = "0xF5304d4a2Aa557D535BA671A81695A7f5D8a18e5";
const VAULT: Address = "0x7EF6C1C8e60E93dBb7332572FA912d32Ef551c8c";
const STAKING: Address = "0xD095eAd563eb3424c7a371a71c0526dc8FAc30A0";
const IDLEX: Address = "0x524988ccc8D7A23566E2ffFb24B1B07E5Aa2f134";
const CREDITS: Address = "0xB1037657e9bD6A589eC5743f93E4AF39DA26A67e";
const REWARDS: Address = "0xe240e137Bf2df344C66431D46da5f780F8B625d9";
const LOG_SPAN = 5_000_000n;

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
  vault: parseAbi([
    "function distribute(uint64 epoch, address[] holders, uint256[] amounts)",
    "function distributed(uint64 epoch) view returns (bool)",
    "event Distributed(uint64 indexed epoch, uint256 holders, uint256 nvda)",
  ]),
  staking: parseAbi([
    "event WhitelistSet(address indexed node, bool allowed)",
    "event Slashed(address indexed node, uint256 amount, bytes32 indexed reason)",
    "event MinHoldingIdlexSet(uint256 minHoldingIdlex)",
    "event BanSet(address indexed node, bool banned, bytes32 indexed reason)",
  ]),
  erc20: parseAbi(["event Transfer(address indexed from, address indexed to, uint256 value)"]),
};

/** All logs of one event from `from` to `to`, in spans the RPC accepts. */
async function logsOf<E>(address: Address, event: E, from: bigint, to: bigint) {
  const out: any[] = [];
  for (let b = from; b <= to; b += LOG_SPAN) {
    const hi = b + LOG_SPAN - 1n > to ? to : b + LOG_SPAN - 1n;
    out.push(...(await pub.getLogs({ address, event: event as any, fromBlock: b, toBlock: hi })));
  }
  return out;
}
const nvda = (wei: bigint) => `${(Number(wei / 10n ** 12n) / 1e6).toFixed(6)} NVDA`;

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

/** Team devices as of a block: whitelisted and not banned, from the staking contract's WhitelistSet and BanSet events. */
async function teamAt(block: bigint) {
  const ev = (name: string) => ABI.staking.find((x) => x.type === "event" && x.name === name);
  const [wl, bans] = await Promise.all([logsOf(STAKING, ev("WhitelistSet"), IDLEX_FROM, block), logsOf(STAKING, ev("BanSet"), IDLEX_FROM, block)]);
  const order = (a: any, b: any) => (a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1);
  const listed = new Set<string>();
  const banned = new Set<string>();
  for (const l of wl.sort(order)) (l.args.allowed ? listed.add(l.args.node.toLowerCase()) : listed.delete(l.args.node.toLowerCase()));
  for (const l of bans.sort(order)) (l.args.banned ? banned.add(l.args.node.toLowerCase()) : banned.delete(l.args.node.toLowerCase()));
  return new Set([...listed].filter((w) => !banned.has(w)));
}

/** Last block at or before time t. */
async function blockAt(t: number) {
  let lo = IDLEX_FROM;
  let hi = await pub.getBlockNumber();
  while (lo < hi) {
    const mid = (lo + hi + 1n) / 2n;
    if (Number((await pub.getBlock({ blockNumber: mid })).timestamp) <= t) lo = mid;
    else hi = mid - 1n;
  }
  return lo;
}

async function payout(n: number, deep: boolean) {
  const p = (await get(`/api/network/proofs/payouts/${n}`)) as PayoutProof;
  console.log(`\npayout for epoch ${n} · ${p.tx ?? "no transaction"}`);
  let call: PayoutCall | null = null;
  let block = 0n;
  if (p.tx) {
    const [tx, rc] = await Promise.all([pub.getTransaction({ hash: p.tx }), pub.getTransactionReceipt({ hash: p.tx })]);
    const d = decodeFunctionData({ abi: ABI.vault, data: tx.input });
    const [epochArg, holders, amounts] = d.args as [bigint, Address[], bigint[]];
    const event = rc.logs.some((l) => {
      if (l.address.toLowerCase() !== VAULT.toLowerCase()) return false;
      try {
        const e = decodeEventLog({ abi: ABI.vault, data: l.data, topics: l.topics });
        return e.eventName === "Distributed" && e.args.epoch === BigInt(n);
      } catch {
        return false;
      }
    });
    call = { to: tx.to, success: rc.status === "success" && event, epoch: epochArg, holders: [...holders], amounts: [...amounts] };
    block = rc.blockNumber;
  }
  if (p.vault && p.vault.toLowerCase() !== VAULT.toLowerCase()) show([{ ok: false, label: "the server names another Holder Vault", detail: p.vault }]);
  const team = await teamAt(block || (await pub.getBlockNumber()));
  const { checks, rows } = checkPayout({ ...p, vault: VAULT }, call, team);
  show(checks);
  for (const r of rows.slice(0, 40)) {
    console.log(`      ${r.wallet}  ${nvda(r.amount)}  ${(r.bps / 100).toFixed(2).padStart(6)}%${r.team ? "  team device" : ""}`);
  }
  if (rows.length > 40) console.log(`      … and ${rows.length - 40} more`);
  if (deep && call) await deepCheck(p, call, team, block);
}

/**
 * Recomputes the whole split from the chain: every $IDLEX transfer (moves into and out of staking don't count,
 * slashes do), each wallet's balance x seconds and lowest balance over the epoch, the holding minimum, contracts left
 * out, the top 500, team devices at multiplier x minimum x epoch length, and the amounts. The budget, the multiplier
 * and, before it was recorded, the minimum are the published values; everything else comes from the chain.
 */
async function deepCheck(p: PayoutProof, call: PayoutCall, team: Set<string>, runBlock: bigint) {
  console.log("  deep check: replaying $IDLEX transfers (this takes a while)");
  const to = await blockAt(p.end);
  const transfer = ABI.erc20[0];
  const slash = ABI.staking.find((x) => x.type === "event" && x.name === "Slashed");
  const [moves, slashes] = await Promise.all([logsOf(IDLEX, transfer, IDLEX_FROM, to), logsOf(STAKING, slash, IDLEX_FROM, to)]);
  const all = [...moves.map((l) => ({ l, kind: "t" })), ...slashes.map((l) => ({ l, kind: "s" }))];
  all.sort((a, b) => (a.l.blockNumber === b.l.blockNumber ? a.l.logIndex - b.l.logIndex : a.l.blockNumber < b.l.blockNumber ? -1 : 1));
  const times = new Map<bigint, number>();
  const blocks = [...new Set(all.map((x) => x.l.blockNumber as bigint))];
  for (let i = 0; i < blocks.length; i += 16) {
    await Promise.all(blocks.slice(i, i + 16).map(async (b) => times.set(b, Number((await pub.getBlock({ blockNumber: b })).timestamp))));
  }
  const zero = "0x0000000000000000000000000000000000000000";
  const st = STAKING.toLowerCase();
  const changes: { t: number; wallet: string; delta: bigint }[] = [];
  for (const { l, kind } of all) {
    const t = times.get(l.blockNumber)!;
    if (kind === "s") {
      changes.push({ t, wallet: l.args.node, delta: -(l.args.amount as bigint) });
      continue;
    }
    const { from, to: dst, value } = l.args as { from: string; to: string; value: bigint };
    if (from.toLowerCase() === st || dst.toLowerCase() === st) continue;
    if (from.toLowerCase() !== zero) changes.push({ t, wallet: from, delta: -value });
    changes.push({ t, wallet: dst, delta: value });
  }
  const held = holdingsOver(changes, p.start, p.end);
  // Before it was recorded: the minimum in force when the payout was computed, from MinHoldingIdlexSet events (no
  // price oracle is set, so the minimum is that token amount; this RPC can't read old state directly).
  let minimum = p.minimum ? BigInt(p.minimum) : 0n;
  if (!p.minimum) {
    const sets = await logsOf(STAKING, ABI.staking.find((x) => x.type === "event" && x.name === "MinHoldingIdlexSet"), IDLEX_FROM, runBlock);
    sets.sort((a, b) => (a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1));
    minimum = sets.length ? (sets[sets.length - 1].args.minHoldingIdlex as bigint) : 0n;
  }
  const skip = new Set([zero, "0x000000000000000000000000000000000000dead", VAULT, STAKING, CREDITS, REWARDS, REWARDS_V2].map((a) => a.toLowerCase()));
  const candidates = [...held].filter(([w, h]) => h.accum > 0n && h.min >= minimum && !skip.has(w)).sort((a, b) => (a[1].accum > b[1].accum ? -1 : 1));
  const shares: [string, bigint][] = [];
  for (const [w, h] of candidates) {
    const code = await pub.getCode({ address: w as Address });
    if (code && code !== "0x" && !code.toLowerCase().startsWith("0xef0100")) continue; // contracts and pools don't count
    shares.push([w, h.accum]);
    if (shares.length === 500) break;
  }
  const weight = minimum * BigInt(p.epochSeconds) * BigInt(p.multiplier ?? 0);
  for (const d of p.multiplier ? team : []) {
    const i = shares.findIndex(([w]) => w === d);
    if (i >= 0) shares[i] = [d, shares[i][1] > weight ? shares[i][1] : weight];
    else shares.push([d, weight]);
  }
  shares.sort((a, b) => (a[1] > b[1] ? -1 : a[1] < b[1] ? 1 : 0));
  const expected = splitOf(BigInt(p.budget ?? "0"), shares.slice(0, 500));
  const sent = new Map(call.holders.map((w, i) => [w.toLowerCase(), call.amounts[i]] as const));
  const missing = [...expected.keys()].filter((w) => !sent.has(w));
  const extra = [...sent.keys()].filter((w) => !expected.has(w));
  const wrong = [...expected].filter(([w, a]) => sent.has(w) && sent.get(w) !== a);
  show([
    { ok: null, label: `${moves.length} transfers and ${slashes.length} slashes replayed up to block ${to}; minimum ${Number(minimum / 10n ** 18n).toLocaleString("en-US")} $IDLEX${p.minimum ? " (recorded)" : " (from the staking contract's events)"}` },
    { ok: missing.length === 0 && extra.length === 0, label: `the same ${expected.size} wallets qualify as were paid`, detail: `${missing.length} missing, ${extra.length} not expected: ${[...missing, ...extra].slice(0, 4).join(", ")}` },
    { ok: wrong.length === 0, label: "every amount sent is the recomputed amount", detail: `${wrong.length} differ, e.g. ${wrong.slice(0, 2).map(([w, a]) => `${w} expected ${a} sent ${sent.get(w)}`).join("; ")}` },
  ]);
}

async function main() {
  console.log(`Idlex proof check · data from ${NETWORK} · chain via ${RPC}`);
  show([{ ok: selfCheck(), label: "this tool's math matches protocol.ts and merkle.ts (leaf, root, draw)" }]);
  const e = arg("--epoch");
  const h = arg("--hour");
  const po = arg("--payout");
  if (e || h || po) {
    if (e) await epoch(Number(e));
    if (h) await hour(Number(h));
    if (po) await payout(Number(po), process.argv.includes("--deep"));
  } else {
    const idx = await get("/api/network/proofs");
    const lastEpoch = idx.epochs.find((x: any) => x.receipts > 0);
    const lastHour = idx.hours.find((x: any) => x.receipts > 0);
    if (lastEpoch) await epoch(lastEpoch.epoch);
    if (lastHour) await hour(lastHour.round);
    const pays = await get("/api/network/proofs/payouts");
    const lastPay = pays.epochs.find((x: any) => x.tx);
    if (lastPay) await payout(lastPay.epoch, false);
  }
  console.log(failed ? `\n${failed} check(s) FAILED` : "\nall checks passed");
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
