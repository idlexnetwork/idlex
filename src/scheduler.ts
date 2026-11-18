// Idlex scheduler (prototype). Hands jobs to eligible nodes, spot-checks results on a second
// node, slashes nodes caught with a wrong result, and closes 6-hour epochs: settle jobs,
// seal the receipt root, split the epoch's $IDLEX budget by verified work.
//
//   node src/scheduler.ts            (PORT=8787, EPOCH_SECONDS=21600, see CONFIG below)
//
// Everything lives in memory plus data/*.json. There is no chain: Ledger simulates stakes, credits and rewards.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { inflateSync } from "node:zlib";
import type { Address, Hex } from "viem";
import { Ledger } from "./ledger.ts";
import {
  EPOCH_SECONDS_DEFAULT, IDLEX, MAX_JOB_CREDITS, USDG, fmtUnits, jobIdOf, priceCredits, sha256Hex, toJson,
  validateParams, verifyReceipt, verifyRequest, type JuliaParams, type Receipt,
} from "./protocol.ts";
import { DASHBOARD_HTML } from "./dashboard.ts";

const env = (k: string, d: string) => process.env[k] ?? d;
export const CONFIG = {
  port: Number(env("PORT", "8787")),
  dataDir: env("DATA_DIR", "data"),
  epochSeconds: Number(env("EPOCH_SECONDS", String(EPOCH_SECONDS_DEFAULT))),
  /** Share of jobs re-run on a second node after a node's probation. */
  spotRate: Number(env("SPOT_RATE", "0.2")),
  /** A node's first N jobs are always spot-checked. */
  probationJobs: Number(env("PROBATION_JOBS", "3")),
  /** Stake share slashed for a wrong result (basis points). */
  slashBps: BigInt(env("SLASH_BPS", "5000")),
  /** $IDLEX price in USDG for the stake check. */
  idlexPriceUsdg: Number(env("IDLEX_PRICE_USDG", "0.01")),
  /** Seconds a node has to return a task before it is handed to someone else. */
  taskTimeout: Number(env("TASK_TIMEOUT", "90")),
  /** How long an epoch waits for in-flight spot-checks before it closes anyway. */
  closeGrace: Number(env("CLOSE_GRACE", "60")),
  /** Dev faucet endpoints for stake and credits. Off in anything public. */
  dev: env("DEV", "1") === "1",
};

type Role = "primary" | "check" | "tiebreak";
type Task = { id: string; jobId: Hex; role: Role; exclude: Set<string>; node?: Address; assignedAt?: number };
type Result = { node: Address; role: Role; outputHash: Hex; gpuMs: number; epoch: number; signature: Hex; at: number };
type JobStatus = "queued" | "running" | "verifying" | "verified" | "disputed" | "refunded";
type Job = {
  id: Hex;
  builder: Address;
  params: JuliaParams;
  credits: bigint;
  status: JobStatus;
  createdAt: number;
  results: Result[];
  checked: boolean;
  finalHash?: Hex;
  payNode?: Address;
  verifiedEpoch?: number;
  settled: boolean;
  note?: string;
};

export function startScheduler(cfg = CONFIG) {
  mkdirSync(`${cfg.dataDir}/outputs`, { recursive: true });
  const metaFile = `${cfg.dataDir}/meta.json`;
  const meta: { genesis: number; lastClosed: number } = existsSync(metaFile)
    ? JSON.parse(readFileSync(metaFile, "utf8"))
    : { genesis: Math.floor(Date.now() / 1000), lastClosed: -1 };
  const saveMeta = () => writeFileSync(metaFile, JSON.stringify(meta));
  saveMeta();

  const ledger = new Ledger(`${cfg.dataDir}/ledger.json`, BigInt(Math.round(cfg.idlexPriceUsdg * 1e6)));
  const jobs = new Map<string, Job>();
  const queue: Task[] = [];
  const running = new Map<string, Task>();
  const waiters: { node: Address; resolve: (t: Task | null) => void }[] = [];
  // verified receipts by epoch, with the job size the scheduler computed (the reward weight)
  const receipts = new Map<number, { receipt: Receipt; work: bigint }[]>();
  const log: string[] = [];
  const say = (m: string) => {
    const line = `${new Date().toISOString().slice(11, 19)} ${m}`;
    log.push(line);
    if (log.length > 200) log.shift();
    console.log(line);
  };

  const epochNow = () => Math.floor((Date.now() / 1000 - meta.genesis) / cfg.epochSeconds);
  const epochEnd = (e: number) => meta.genesis + (e + 1) * cfg.epochSeconds;
  const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

  // ---- queue -------------------------------------------------------------------------------
  function canTake(t: Task, node: Address) {
    return !t.exclude.has(node.toLowerCase()) && ledger.isEligible(node);
  }
  function assign(t: Task, node: Address) {
    t.node = node;
    t.assignedAt = Date.now();
    running.set(t.id, t);
    const job = jobs.get(t.jobId)!;
    if (job.status === "queued") job.status = "running";
    return t;
  }
  function enqueue(t: Task) {
    const w = waiters.findIndex((w) => canTake(t, w.node));
    if (w >= 0) {
      const [waiter] = waiters.splice(w, 1);
      waiter.resolve(assign(t, waiter.node));
    } else queue.push(t);
  }
  function nextFor(node: Address) {
    const i = queue.findIndex((t) => canTake(t, node));
    return i >= 0 ? assign(queue.splice(i, 1)[0], node) : null;
  }

  // Hand back tasks whose node went quiet.
  setInterval(() => {
    for (const [id, t] of running) {
      if (Date.now() - (t.assignedAt ?? 0) > cfg.taskTimeout * 1000) {
        running.delete(id);
        say(`task ${t.role} for job ${t.jobId.slice(0, 10)} timed out on ${short(t.node!)}; requeued`);
        t.node = undefined;
        enqueue(t);
      }
    }
  }, 2000).unref();

  // ---- verification ------------------------------------------------------------------------
  function finalize(job: Job, hash: Hex, epochNowValue: number) {
    job.finalHash = hash;
    job.status = "verified";
    job.verifiedEpoch = epochNowValue;
    const winners = job.results.filter((r) => r.outputHash === hash);
    job.payNode = (winners.find((r) => r.role === "primary") ?? winners[0]).node;
    for (const r of winners) {
      const list = receipts.get(r.epoch) ?? [];
      list.push({
        receipt: { jobId: job.id, node: r.node, outputHash: r.outputHash, gpuMs: BigInt(Math.round(r.gpuMs)), epoch: BigInt(r.epoch) },
        work: BigInt(job.params.width) * BigInt(job.params.height) * BigInt(job.params.maxIter),
      });
      receipts.set(r.epoch, list);
      const n = ledger.node(r.node);
      if (r.role === "primary") n.jobsDone += 1;
      else n.checksDone += 1;
    }
    for (const r of job.results.filter((r) => r.outputHash !== hash)) {
      const amount = ledger.slash(r.node, cfg.slashBps);
      say(`SLASH ${short(r.node)}: wrong result on job ${job.id.slice(0, 10)}, ${fmtUnits(amount, 18, 0)} $IDLEX to the Holder Vault`);
    }
    // Keep the winning output as the job's image.
    const src = `${cfg.dataDir}/outputs/${job.id}-${winners[0].role}.png`;
    if (existsSync(src)) writeFileSync(`${cfg.dataDir}/outputs/${job.id}.png`, readFileSync(src));
    say(`job ${job.id.slice(0, 10)} verified${job.checked ? " by spot-check" : " (not sampled)"}; pays ${short(job.payNode)}`);
    ledger.save();
  }

  function onResult(task: Task, r: Result) {
    const job = jobs.get(task.jobId)!;
    job.results.push(r);
    if (r.role === "primary") {
      const n = ledger.node(r.node);
      const sample = n.jobsDone + n.checksDone < cfg.probationJobs || Math.random() < cfg.spotRate;
      if (sample) {
        job.checked = true;
        job.status = "verifying";
        enqueue({ id: randomUUID(), jobId: job.id, role: "check", exclude: new Set([r.node.toLowerCase()]) });
        say(`job ${job.id.slice(0, 10)} done by ${short(r.node)} in ${r.gpuMs.toFixed(1)} ms; spot-check queued`);
      } else finalize(job, r.outputHash, epochNow());
      return;
    }
    const primary = job.results.find((x) => x.role === "primary")!;
    if (r.role === "check") {
      if (r.outputHash === primary.outputHash) return finalize(job, r.outputHash, epochNow());
      say(`job ${job.id.slice(0, 10)}: check by ${short(r.node)} disagrees with ${short(primary.node)}; tiebreak queued`);
      job.status = "verifying";
      enqueue({ id: randomUUID(), jobId: job.id, role: "tiebreak", exclude: new Set(job.results.map((x) => x.node.toLowerCase())) });
      return;
    }
    // tiebreak: majority of three
    const match = job.results.find((x) => x.role !== "tiebreak" && x.outputHash === r.outputHash);
    if (match) return finalize(job, r.outputHash, epochNow());
    job.status = "disputed";
    job.note = "three different results; held for review, builder refunded";
    ledger.release(job.builder, job.credits);
    say(`job ${job.id.slice(0, 10)} disputed: no two nodes agree`);
  }

  // ---- epochs ------------------------------------------------------------------------------
  setInterval(() => {
    const e = meta.lastClosed + 1;
    const now = Date.now() / 1000;
    if (now < epochEnd(e)) return;
    const pending = [...jobs.values()].some(
      (j) => (j.status === "verifying" || j.status === "running") && j.results.some((r) => r.epoch <= e),
    );
    if (pending && now < epochEnd(e) + cfg.closeGrace) return;
    let settledJobs = 0, credits = 0n, fee = 0n;
    for (const j of jobs.values()) {
      if (j.status !== "verified" || j.settled || (j.verifiedEpoch ?? 0) > e) continue;
      const res = ledger.settleJob(j.builder, j.payNode!, j.credits);
      j.settled = true;
      if (res.charged) {
        settledJobs++;
        credits += j.credits;
        fee += res.fee;
      } else {
        j.status = "refunded";
        j.note = "node lost eligibility before settlement; builder not charged";
      }
    }
    const rec = ledger.closeEpoch(e, receipts.get(e) ?? [], { jobs: settledJobs, credits, fee });
    receipts.delete(e);
    meta.lastClosed = e;
    saveMeta();
    ledger.save();
    say(
      `EPOCH ${e} closed: ${settledJobs} jobs settled (${fmtUnits(credits, 6)} USDG to the Holder Vault), ` +
        `${rec.receipts} receipts sealed ${rec.root.slice(0, 12)}…, ${fmtUnits(rec.budget, 18, 0)} $IDLEX to ${rec.rewards.length} node(s)`,
    );
  }, 1000).unref();

  // ---- HTTP --------------------------------------------------------------------------------
  const readBody = (req: IncomingMessage, limit = 24 * 1024 * 1024) =>
    new Promise<string>((ok, fail) => {
      let size = 0;
      const parts: Buffer[] = [];
      req.on("data", (c: Buffer) => {
        size += c.length;
        if (size > limit) {
          fail(new Error("body too large"));
          req.destroy();
        } else parts.push(c);
      });
      req.on("end", () => ok(Buffer.concat(parts).toString("utf8")));
      req.on("error", fail);
    });
  const send = (res: ServerResponse, code: number, body: unknown, type = "application/json") => {
    res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
    res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : toJson(body));
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const path = url.pathname;
    try {
      if (req.method === "GET" && path === "/") return send(res, 200, DASHBOARD_HTML, "text/html; charset=utf-8");
      if (req.method === "GET" && path === "/api/state") return send(res, 200, publicState());
      const out = path.match(/^\/api\/jobs\/(0x[0-9a-f]{64})\/output\.png$/);
      if (req.method === "GET" && out) {
        const f = `${cfg.dataDir}/outputs/${out[1]}.png`;
        return existsSync(f) ? send(res, 200, readFileSync(f), "image/png") : send(res, 404, { error: "not ready" });
      }
      const jobGet = path.match(/^\/api\/jobs\/(0x[0-9a-f]{64})$/);
      if (req.method === "GET" && jobGet) {
        const j = jobs.get(jobGet[1]);
        return j ? send(res, 200, jobView(j)) : send(res, 404, { error: "no such job" });
      }
      if (req.method !== "POST") return send(res, 404, { error: "not found" });

      const body = await readBody(req);
      const from = await verifyRequest(req.headers, "POST", path, body);
      const data = body ? JSON.parse(body) : {};

      if (path === "/api/nodes/register") {
        const n = ledger.node(from);
        n.gpu = String(data.gpu ?? "").slice(0, 80);
        n.benchmarkMs = Number(data.benchmarkMs) || 0;
        n.lastSeen = Date.now();
        ledger.save();
        say(`node ${short(from)} registered: ${n.gpu}, benchmark ${n.benchmarkMs.toFixed(1)} ms`);
        return send(res, 200, { eligible: ledger.isEligible(from), stake: n.stake, requiredStake: ledger.requiredStake(), epochSeconds: cfg.epochSeconds });
      }
      if (path === "/api/dev/stake") {
        if (!cfg.dev) return send(res, 403, { error: "dev faucet disabled" });
        const amount = BigInt(Math.round(Number(data.idlex) * 1e6)) * (IDLEX / 1_000_000n);
        ledger.stake(from, amount);
        ledger.save();
        say(`node ${short(from)} staked ${fmtUnits(amount, 18, 0)} $IDLEX (worth ${fmtUnits(ledger.stakeValueUsdg(from), 6, 2)} USDG)`);
        return send(res, 200, { stake: ledger.node(from).stake, eligible: ledger.isEligible(from) });
      }
      if (path === "/api/dev/credits") {
        if (!cfg.dev) return send(res, 403, { error: "dev faucet disabled" });
        const usdg = BigInt(Math.round(Number(data.usdg) * 1e6));
        ledger.depositUsdg(from, usdg);
        ledger.save();
        return send(res, 200, { credits: ledger.builder(from).credits });
      }
      if (path === "/api/nodes/poll") {
        const n = ledger.node(from);
        n.lastSeen = Date.now();
        if (!ledger.isEligible(from)) {
          return send(res, 403, { error: "stake below 100 USD", stakeUsdg: ledger.stakeValueUsdg(from), requiredStake: ledger.requiredStake() });
        }
        const t =
          nextFor(from) ??
          (await new Promise<Task | null>((resolve) => {
            const w = { node: from, resolve };
            waiters.push(w);
            setTimeout(() => {
              const i = waiters.indexOf(w);
              if (i >= 0) {
                waiters.splice(i, 1);
                resolve(null);
              }
            }, 20_000);
            req.on("close", () => {
              const i = waiters.indexOf(w);
              if (i >= 0) waiters.splice(i, 1);
            });
          }));
        if (!t) return send(res, 204, "");
        const job = jobs.get(t.jobId)!;
        return send(res, 200, { taskId: t.id, jobId: job.id, role: t.role, params: job.params, epoch: epochNow() });
      }
      const resultPath = path.match(/^\/api\/tasks\/([0-9a-f-]{36})\/result$/);
      if (resultPath) {
        const task = running.get(resultPath[1]);
        if (!task || task.node?.toLowerCase() !== from.toLowerCase()) return send(res, 409, { error: "task not assigned to you" });
        const job = jobs.get(task.jobId)!;
        const epoch = Number(data.epoch);
        const assignedEpoch = Math.floor((task.assignedAt! / 1000 - meta.genesis) / cfg.epochSeconds);
        if (epoch !== assignedEpoch && epoch !== epochNow()) return send(res, 400, { error: "receipt epoch out of range" });
        const receipt: Receipt = { jobId: job.id, node: from, outputHash: data.outputHash, gpuMs: BigInt(Math.round(Number(data.gpuMs))), epoch: BigInt(epoch) };
        if (!(await verifyReceipt(receipt, data.signature))) return send(res, 400, { error: "bad receipt signature" });
        running.delete(task.id);
        // The PNG must decode to exactly the pixels the node signed for.
        const png = Buffer.from(String(data.png ?? ""), "base64");
        const rgba = decodePng(png, job.params.width, job.params.height);
        const actual = rgba ? sha256Hex(rgba) : null;
        writeFileSync(`${cfg.dataDir}/outputs/${job.id}-${task.role}.png`, png);
        const r: Result = { node: from, role: task.role, outputHash: actual === data.outputHash ? data.outputHash : (actual ?? "0x00"), gpuMs: Number(data.gpuMs), epoch, signature: data.signature, at: Date.now() };
        if (actual !== data.outputHash) say(`node ${short(from)} sent pixels that do not match its signed hash`);
        onResult(task, r);
        return send(res, 200, { ok: true, status: job.status });
      }
      if (path === "/api/jobs") {
        const params = validateParams(data.params);
        const nonce = String(data.nonce ?? randomUUID());
        const id = jobIdOf(from, nonce, params);
        if (jobs.has(id)) return send(res, 409, { error: "duplicate job" });
        const credits = priceCredits(params);
        if (credits > MAX_JOB_CREDITS) return send(res, 400, { error: "job too large" });
        ledger.hold(from, credits);
        const job: Job = { id, builder: from, params, credits, status: "queued", createdAt: Date.now(), results: [], checked: false, settled: false };
        jobs.set(id, job);
        enqueue({ id: randomUUID(), jobId: id, role: "primary", exclude: new Set() });
        say(`builder ${short(from)} submitted job ${id.slice(0, 10)} (${params.width}x${params.height}, ${params.maxIter} it) for ${fmtUnits(credits, 6)} USDG`);
        return send(res, 200, { jobId: id, credits, status: job.status });
      }
      return send(res, 404, { error: "not found" });
    } catch (e) {
      return send(res, 400, { error: e instanceof Error ? e.message : String(e) });
    }
  });

  function jobView(j: Job) {
    return {
      id: j.id, builder: j.builder, params: j.params, credits: j.credits, status: j.status, checked: j.checked,
      finalHash: j.finalHash, payNode: j.payNode, settled: j.settled, note: j.note,
      results: j.results.map((r) => ({ node: r.node, role: r.role, outputHash: r.outputHash, gpuMs: r.gpuMs, epoch: r.epoch })),
    };
  }
  function publicState() {
    const e = epochNow();
    return {
      epoch: e,
      epochEndsIn: Math.max(0, Math.round(epochEnd(e) - Date.now() / 1000)),
      epochSeconds: cfg.epochSeconds,
      idlexPriceUsdg: cfg.idlexPriceUsdg,
      requiredStake: ledger.requiredStake(),
      vault: ledger.s.vault,
      nodes: Object.values(ledger.s.nodes).map((n) => ({
        ...n, eligible: ledger.isEligible(n.address), stakeUsdg: ledger.stakeValueUsdg(n.address),
        online: Date.now() - n.lastSeen < 30_000,
      })),
      builders: Object.values(ledger.s.builders),
      jobs: [...jobs.values()].slice(-40).reverse().map(jobView),
      queue: queue.length,
      running: running.size,
      epochs: ledger.s.epochs.slice(-10).reverse(),
      log: log.slice(-40).reverse(),
      usdgUnit: Number(USDG),
    };
  }

  server.listen(cfg.port, () => {
    say(`scheduler on http://localhost:${cfg.port}  (epoch ${cfg.epochSeconds}s, spot-check ${cfg.spotRate * 100}%, slash ${Number(cfg.slashBps) / 100}%${cfg.dev ? ", DEV faucet on" : ""})`);
    say(`min stake: 100 USD = ${fmtUnits(ledger.requiredStake(), 18, 0)} $IDLEX at ${cfg.idlexPriceUsdg} USDG`);
  });
  return { server, ledger, jobs, close: () => new Promise<void>((ok) => server.close(() => ok())) };
}

/** Decodes the PNGs our nodes produce (RGBA8, filter 0). Returns null for anything else. */
function decodePng(buf: Buffer, width: number, height: number): Uint8Array | null {
  try {
    if (buf.readUInt32BE(0) !== 0x89504e47) return null;
    let o = 8;
    const idat: Buffer[] = [];
    let w = 0, h = 0;
    while (o < buf.length) {
      const len = buf.readUInt32BE(o);
      const type = buf.toString("ascii", o + 4, o + 8);
      const data = buf.subarray(o + 8, o + 8 + len);
      if (type === "IHDR") {
        w = data.readUInt32BE(0);
        h = data.readUInt32BE(4);
        if (data[8] !== 8 || data[9] !== 6) return null;
      } else if (type === "IDAT") idat.push(data);
      o += 12 + len;
    }
    if (w !== width || h !== height) return null;
    const raw = inflateSync(Buffer.concat(idat));
    const out = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) {
      const row = y * (w * 4 + 1);
      if (raw[row] !== 0) return null;
      out.set(raw.subarray(row + 1, row + 1 + w * 4), y * w * 4);
    }
    return out;
  } catch {
    return null;
  }
}

if (import.meta.main) startScheduler();
