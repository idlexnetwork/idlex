// Simulated ledger for the local prototype: node stakes (eligibility, slashing), builder credits (escrow,
// settlement), one sealed receipt root per epoch, and node rewards. Nothing here touches a real chain or
// real tokens.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Address, Hex } from "viem";
import { merkleRoot } from "./merkle.ts";
import { BPS, IDLEX, MIN_STAKE_USDG, drawReward, receiptLeaf, toJson, type Receipt } from "./protocol.ts";

/** Prototype reward settings: 100-1,000 $IDLEX per verified job, 10,000 $IDLEX per hour for the network. */
const REWARD_MIN = 100n * IDLEX;
const REWARD_MAX = 1_000n * IDLEX;
const REWARD_HOURLY_CAP = 10_000n * IDLEX;

export type NodeRec = {
  address: Address;
  gpu: string;
  benchmarkMs: number;
  stake: bigint; // $IDLEX wei
  slashed: bigint;
  rewardIdlex: bigint; // rewards credited
  jobsDone: number;
  checksDone: number;
  caught: number;
  lastSeen: number;
};
export type BuilderRec = { address: Address; credits: bigint; held: bigint; spent: bigint };
export type EpochRec = {
  epoch: number;
  root: Hex;
  /** Receipt leaves, so a node can build its Merkle proof against the sealed root. */
  leaves: Hex[];
  receipts: number;
  settledJobs: number;
  settledCredits: bigint;
  feeToVault: bigint;
  budget: bigint;
  rewards: { node: Address; work: bigint; gpuMs: number; jobs: number; idlex: bigint }[];
};

type State = {
  nodes: Record<string, NodeRec>;
  builders: Record<string, BuilderRec>;
  vault: { usdg: bigint; idlex: bigint };
  epochs: EpochRec[];
};

const BIG_KEYS = new Set(["work", "stake", "slashed", "rewardIdlex", "credits", "held", "spent", "usdg", "idlex", "settledCredits", "feeToVault", "budget"]);

export class Ledger {
  s: State;
  private file: string;
  /** $IDLEX price in USDG units per whole token 10_000 = 0.01 USDG. */
  idlexPrice: bigint;

  constructor(file: string, idlexPrice: bigint) {
    this.file = file;
    this.idlexPrice = idlexPrice;
    this.s = existsSync(file)
      ? JSON.parse(readFileSync(file, "utf8"), (k, v) => (BIG_KEYS.has(k) && typeof v === "string" ? BigInt(v) : v))
      : { nodes: {}, builders: {}, vault: { usdg: 0n, idlex: 0n }, epochs: [] };
  }

  save() {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, toJson(this.s, 1));
  }

  // ---- Stakes -----------------------------------------------------------------------------
  node(a: Address) {
    const k = a.toLowerCase();
    return (this.s.nodes[k] ??= {
      address: a, gpu: "", benchmarkMs: 0, stake: 0n, slashed: 0n, rewardIdlex: 0n,
      jobsDone: 0, checksDone: 0, caught: 0, lastSeen: 0,
    });
  }
  stakeValueUsdg(a: Address) {
    return (this.node(a).stake * this.idlexPrice) / IDLEX;
  }
  requiredStake() {
    return (MIN_STAKE_USDG * IDLEX + this.idlexPrice - 1n) / this.idlexPrice;
  }
  isEligible(a: Address) {
    return this.stakeValueUsdg(a) >= MIN_STAKE_USDG;
  }
  /** Dev faucet + stake in one step (no real tokens in the prototype). */
  stake(a: Address, amount: bigint) {
    this.node(a).stake += amount;
  }
  /** Slash: part of the stake goes to the Holder Vault. */
  slash(a: Address, bps: bigint) {
    const n = this.node(a);
    const amount = (n.stake * bps) / BPS;
    n.stake -= amount;
    n.slashed += amount;
    n.caught += 1;
    this.s.vault.idlex += amount;
    return amount;
  }

  // ---- Builder credits --------------------------------------------------------------------
  builder(a: Address) {
    return (this.s.builders[a.toLowerCase()] ??= { address: a, credits: 0n, held: 0n, spent: 0n });
  }
  depositUsdg(a: Address, usdg: bigint) {
    this.builder(a).credits += usdg;
  }
  /** Reserve credits for a submitted job. */
  hold(a: Address, credits: bigint) {
    const b = this.builder(a);
    if (b.credits - b.held < credits) throw new Error(`not enough credits: need ${credits}, free ${b.credits - b.held}`);
    b.held += credits;
  }
  release(a: Address, credits: bigint) {
    this.builder(a).held -= credits;
  }
  /** Settle one job: the whole price goes to the Holder Vault (nodes are not paid in USDG). */
  settleJob(builder: Address, node: Address, credits: bigint) {
    const b = this.builder(builder);
    b.held -= credits;
    if (!this.isEligible(node)) return { charged: false as const };
    b.credits -= credits;
    b.spent += credits;
    const fee = credits;
    this.s.vault.usdg += fee;
    return { charged: true as const, fee };
  }

  // ---- Epoch close ------------------------------------------------------------------------
  /**
   * Closes an epoch: seals the receipt root, then credits node rewards. Every verified
   * receipt draws a random reward between REWARD_MIN and REWARD_MAX from the sealed root and its job id
   * (the scheduler computes it, not the node, so a node can't inflate it). The epoch total fits the hourly
   * cap.
   */
  closeEpoch(epoch: number, items: { receipt: Receipt; work: bigint }[], settled: { jobs: number; credits: bigint; fee: bigint }) {
    const leaves = items.map((i) => receiptLeaf(i.receipt));
    const root = merkleRoot(leaves);
    const budget = REWARD_HOURLY_CAP * 6n; // one 6-hour epoch's worth
    const weights = new Map<string, { node: Address; work: bigint; gpuMs: number; jobs: number; drawn: bigint }>();
    for (const { receipt: r, work } of items) {
      const w = weights.get(r.node.toLowerCase()) ?? { node: r.node, work: 0n, gpuMs: 0, jobs: 0, drawn: 0n };
      w.work += work;
      w.gpuMs += Number(r.gpuMs);
      w.jobs += 1;
      w.drawn += drawReward(root, r.jobId, REWARD_MIN, REWARD_MAX);
      weights.set(r.node.toLowerCase(), w);
    }
    const eligible = [...weights.values()].filter((w) => this.isEligible(w.node) && w.jobs > 0);
    const total = eligible.reduce((a, w) => a + w.drawn, 0n);
    const rewards = eligible.map((w) => {
      const idlex = total > budget ? (w.drawn * budget) / total : w.drawn;
      this.node(w.node).rewardIdlex += idlex;
      return { node: w.node, work: w.work, gpuMs: w.gpuMs, jobs: w.jobs, idlex };
    });
    const receipts = items.map((i) => i.receipt);
    const rec: EpochRec = {
      epoch, root, leaves, receipts: receipts.length, settledJobs: settled.jobs, settledCredits: settled.credits,
      feeToVault: settled.fee, budget, rewards,
    };
    this.s.epochs.push(rec);
    return rec;
  }
}
