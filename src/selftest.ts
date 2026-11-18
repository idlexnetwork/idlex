// Self-test: proves the prototype behaves, including every failure path. Runs a scheduler in-process
// on a test port and drives it with scripted nodes (CPU reference kernel) plus the real GPU runner.
//
//   npm test
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import type { Address, Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { GpuRunner } from "./gpu-runner.ts";
import { cpuKernel, toKernel } from "./kernel.ts";
import { merkleProof, merkleRoot, verifyProof } from "./merkle.ts";
import { encodePng } from "./png.ts";
import { CONFIG, startScheduler } from "./scheduler.ts";
import {
  IDLEX, requestMessage, sha256Hex, signReceipt, signedHeaders, type JuliaParams,
} from "./protocol.ts";

const PORT = Number(process.env.TEST_PORT ?? 8795);
const BASE = `http://localhost:${PORT}`;
let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.log(`  FAIL ${name}\n       ${(e as Error).message}`);
    process.exitCode = 1;
  }
}

const SMALL: JuliaParams = { width: 64, height: 48, maxIter: 300, cRe: -0.8, cIm: 0.156, centerRe: 0, centerIm: 0, span: 3.2 };
const job = (i: number): JuliaParams => ({ ...SMALL, cRe: [-0.8, 0.285, -0.4, -0.7269, 0.355][i % 5], cIm: [0.156, 0.01, 0.6, 0.1889, 0.355][i % 5] });

// ---- 1. Kernel correctness: GPU == CPU reference, on both GPUs -----------------------------
console.log("kernel");
const cases: JuliaParams[] = [
  SMALL,
  { width: 96, height: 64, maxIter: 2000, cRe: -0.70176, cIm: -0.3842, centerRe: 0.1, centerIm: -0.05, span: 0.4 }, // zoom
  { width: 80, height: 60, maxIter: 500, cRe: 2, cIm: -2, centerRe: -2, centerIm: 2, span: 4 }, // extremes, escapes fast
  { width: 33, height: 17, maxIter: 16, cRe: 0, cIm: 0, centerRe: 0, centerIm: 0, span: 1e-5 }, // tiny span, odd sizes
];
for (const gpu of ["high", "low"] as const) {
  const r = new GpuRunner(gpu);
  const info = await r.start();
  for (const [i, p] of cases.entries()) {
    await test(`${info.vendor || gpu} GPU matches CPU reference, case ${i + 1}`, async () => {
      const k = toKernel(p);
      const g = await r.run(k);
      assert.equal(sha256Hex(g.rgba), sha256Hex(cpuKernel(k)));
    });
  }
  await r.stop();
}

// ---- 2. Merkle ------------------------------------------------------------------------------
console.log("merkle");
await test("proofs verify for every leaf, odd and even trees", async () => {
  for (const n of [1, 2, 3, 7, 16]) {
    const leaves = Array.from({ length: n }, (_, i) => sha256Hex(`leaf-${n}-${i}`));
    const root = merkleRoot(leaves);
    for (const l of leaves) assert.ok(verifyProof(merkleProof(leaves, l), root, l), `n=${n}`);
    assert.ok(!verifyProof(merkleProof(leaves, leaves[0]), root, sha256Hex("not a leaf")));
  }
});

// ---- 3. Scheduler API -----------------------------------------------------------------------
console.log("scheduler");
const dataDir = "data/selftest";
rmSync(dataDir, { recursive: true, force: true });
const sched = startScheduler({
  ...CONFIG, port: PORT, dataDir, epochSeconds: 30, closeGrace: 4, taskTimeout: 3, probationJobs: 1, spotRate: 0, slashBps: 5000n, dev: true,
});
await new Promise((r) => setTimeout(r, 300));

const wallet = () => privateKeyToAccount(generatePrivateKey());
async function post(a: PrivateKeyAccount, path: string, body: unknown, tamper?: (h: Record<string, string>, b: string) => [Record<string, string>, string]) {
  let text = JSON.stringify(body ?? {});
  let headers: Record<string, string> = await signedHeaders(a, "POST", path, text);
  if (tamper) [headers, text] = tamper(headers, text);
  const res = await fetch(BASE + path, { method: "POST", headers, body: text });
  return { status: res.status, data: res.status === 204 ? null : ((await res.json().catch(() => null)) as any) };
}
type Mode = "honest" | "noiseA" | "noiseB" | "lie-png";
/** A scripted node: renders with the CPU reference and can misbehave on purpose. */
async function work(a: PrivateKeyAccount, mode: Mode = "honest", opts: { skipResult?: boolean; gpuMs?: number } = {}) {
  const t = await post(a, "/api/nodes/poll", {});
  if (t.status !== 200) return t;
  if (opts.skipResult) return t;
  const { taskId, jobId, epoch, params } = t.data;
  const rgba = cpuKernel(toKernel(params));
  const signed = new Uint8Array(rgba);
  if (mode === "noiseA") for (let i = 0; i < rgba.length; i += 7) { rgba[i] ^= 1; signed[i] ^= 1; }
  if (mode === "noiseB") for (let i = 3; i < rgba.length; i += 11) { rgba[i] ^= 2; signed[i] ^= 2; }
  if (mode === "lie-png") rgba[0] ^= 0xff; // signs the honest hash, ships different pixels
  const outputHash = sha256Hex(signed);
  const gpuMs = opts.gpuMs ?? 5;
  const receipt = { jobId: jobId as Hex, node: a.address, outputHash, gpuMs: BigInt(gpuMs), epoch: BigInt(epoch) };
  const signature = await signReceipt(a, receipt);
  const png = encodePng(params.width, params.height, rgba).toString("base64");
  const r = await post(a, `/api/tasks/${taskId}/result`, { outputHash, gpuMs, epoch, signature, png });
  return { ...r, task: t.data };
}
const jobState = async (id: string) => (await (await fetch(`${BASE}/api/jobs/${id}`)).json()) as any;

const builder = wallet();
const [n1, n2, n3, n4, n5] = [wallet(), wallet(), wallet(), wallet(), wallet()];

await test("register works and reports the 100 USD requirement", async () => {
  const r = await post(n1, "/api/nodes/register", { gpu: "test", benchmarkMs: 1 });
  assert.equal(r.status, 200);
  assert.equal(r.data.eligible, false);
  assert.equal(BigInt(r.data.requiredStake), 10_000n * IDLEX); // 100 USD at 0.01 USDG
});
await test("a node without stake can't take jobs (403)", async () => {
  const r = await post(n1, "/api/nodes/poll", {});
  assert.equal(r.status, 403);
});
await test("9,999 $IDLEX (99.99 USD) is still not enough", async () => {
  await post(n5, "/api/dev/stake", { idlex: 9_999 });
  assert.equal((await post(n5, "/api/nodes/poll", {})).status, 403);
});
await test("a body changed after signing is rejected", async () => {
  const r = await post(n1, "/api/dev/stake", { idlex: 1 }, (h) => [h, JSON.stringify({ idlex: 1_000_000 })]);
  assert.equal(r.status, 400);
  assert.match(r.data.error, /bad signature/);
});
await test("a request signed for another address is rejected", async () => {
  const r = await post(n1, "/api/dev/stake", { idlex: 1 }, (h, b) => [{ ...h, "x-idlex-from": n2.address }, b]);
  assert.equal(r.status, 400);
});
await test("an old (replayed) request is rejected", async () => {
  const path = "/api/dev/stake";
  const text = JSON.stringify({ idlex: 1 });
  const ts = String(Math.floor(Date.now() / 1000) - 120);
  const sig = await n1.signMessage({ message: requestMessage("POST", path, ts, text) });
  const res = await fetch(BASE + path, { method: "POST", body: text, headers: { "x-idlex-from": n1.address, "x-idlex-ts": ts, "x-idlex-sig": sig } });
  assert.equal(res.status, 400);
  assert.match(((await res.json()) as any).error, /stale/);
});

for (const n of [n1, n2, n3, n4]) await post(n, "/api/dev/stake", { idlex: 15_000 });
await post(n5, "/api/dev/stake", { idlex: 5_001 }); // now 15,000 total

await test("a builder without credits can't submit", async () => {
  const r = await post(builder, "/api/jobs", { params: SMALL, nonce: "x" });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /not enough credits/);
});
await post(builder, "/api/dev/credits", { usdg: 1 });
await test("invalid params are rejected", async () => {
  const r = await post(builder, "/api/jobs", { params: { ...SMALL, width: 5 }, nonce: "bad" });
  assert.equal(r.status, 400);
  const r2 = await post(builder, "/api/jobs", { params: { ...SMALL, maxIter: 1e9 }, nonce: "bad2" });
  assert.equal(r2.status, 400);
});

// Job 1: node 1 ships pixels that don't match its signed hash -> caught and slashed.
const j1 = (await post(builder, "/api/jobs", { params: job(0), nonce: "j1" })).data.jobId as string;
await test("the same job nonce can't be submitted twice", async () => {
  assert.equal((await post(builder, "/api/jobs", { params: job(0), nonce: "j1" })).status, 409);
});
await test("a node can't return a task assigned to someone else", async () => {
  const t = await post(n1, "/api/nodes/poll", {});
  assert.equal(t.status, 200);
  const stolen = await post(n2, `/api/tasks/${t.data.taskId}/result`, { outputHash: "0x00", gpuMs: 1, epoch: t.data.epoch, signature: "0x00", png: "" });
  assert.equal(stolen.status, 409);
  // node 1 now lies: honest hash, wrong pixels
  const params = t.data.params;
  const rgba = cpuKernel(toKernel(params));
  const outputHash = sha256Hex(rgba);
  rgba[0] ^= 0xff;
  const signature = await signReceipt(n1, { jobId: t.data.jobId, node: n1.address, outputHash, gpuMs: 5n, epoch: BigInt(t.data.epoch) });
  const r = await post(n1, `/api/tasks/${t.data.taskId}/result`, { outputHash, gpuMs: 5, epoch: t.data.epoch, signature, png: encodePng(params.width, params.height, rgba).toString("base64") });
  assert.equal(r.status, 200);
  const again = await post(n1, `/api/tasks/${t.data.taskId}/result`, { outputHash, gpuMs: 5, epoch: t.data.epoch, signature, png: "" });
  assert.equal(again.status, 409, "a task can't be answered twice");
});
await test("pixels that don't match the signed hash get the node slashed below 100 USD", async () => {
  assert.equal((await work(n2)).status, 200); // check: honest, disagrees
  assert.equal((await work(n3, "honest", { gpuMs: 9_000_000 })).status, 200); // tiebreak: honest, agrees with n2, claims a huge gpuMs
  const j = await jobState(j1);
  assert.equal(j.status, "verified");
  assert.equal(j.payNode.toLowerCase(), n2.address.toLowerCase());
  assert.equal(sched.ledger.node(n1.address).stake, 7_500n * IDLEX);
  assert.equal((await post(n1, "/api/nodes/poll", {})).status, 403);
});

// Job 2: node takes it and goes silent -> handed to another node.
const j2 = (await post(builder, "/api/jobs", { params: job(1), nonce: "j2" })).data.jobId as string;
await test("a task from a node that went quiet is handed to another node", async () => {
  const t = await work(n4, "honest", { skipResult: true });
  assert.equal(t.status, 200);
  await new Promise((r) => setTimeout(r, 5000)); // taskTimeout 3 s
  const r = await work(n3); // n3 is past probation and spotRate is 0 -> verified at once
  assert.equal(r.status, 200);
  assert.equal((await jobState(j2)).status, "verified");
});

// Job 3: a receipt signed by someone else's key.
const j3 = (await post(builder, "/api/jobs", { params: job(2), nonce: "j3" })).data.jobId as string;
await test("a receipt signed by another key is rejected and the task stays open", async () => {
  const t = await post(n2, "/api/nodes/poll", {});
  const params = t.data.params;
  const rgba = cpuKernel(toKernel(params));
  const outputHash = sha256Hex(rgba);
  const signature = await signReceipt(n3, { jobId: t.data.jobId, node: n2.address, outputHash, gpuMs: 5n, epoch: BigInt(t.data.epoch) });
  const r = await post(n2, `/api/tasks/${t.data.taskId}/result`, { outputHash, gpuMs: 5, epoch: t.data.epoch, signature, png: encodePng(params.width, params.height, rgba).toString("base64") });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /receipt/);
  // now answer properly
  const ok = await signReceipt(n2, { jobId: t.data.jobId, node: n2.address, outputHash, gpuMs: 5n, epoch: BigInt(t.data.epoch) });
  const r2 = await post(n2, `/api/tasks/${t.data.taskId}/result`, { outputHash, gpuMs: 5, epoch: t.data.epoch, signature: ok, png: encodePng(params.width, params.height, rgba).toString("base64") });
  assert.equal(r2.status, 200);
  assert.equal((await jobState(j3)).status, "verified");
});

// Job 4: three different answers -> disputed, builder refunded, nobody slashed.
const j4 = (await post(builder, "/api/jobs", { params: job(3), nonce: "j4" })).data.jobId as string;
await test("three different results: disputed, builder refunded, no slash", async () => {
  const before = sched.ledger.node(n5.address).stake;
  await work(n5, "noiseA"); // new node -> probation -> checked
  await work(n4, "noiseB"); // check disagrees
  await work(n2, "honest"); // tiebreak matches neither
  const j = await jobState(j4);
  assert.equal(j.status, "disputed");
  assert.equal(sched.ledger.node(n5.address).stake, before);
});

// ---- 4. Epoch close: settlement, seal, rewards -----------------------------------------------
await test("epoch close: money adds up, root verifies, rewards follow the rules", async () => {
  const workEpochs = [...sched.jobs.values()].flatMap((j) => j.results.map((r) => r.epoch));
  const last = Math.max(...workEpochs);
  const t0 = Date.now();
  while (!sched.ledger.s.epochs.some((e) => e.epoch >= last)) {
    if (Date.now() - t0 > 70_000) throw new Error("epoch never closed");
    await new Promise((r) => setTimeout(r, 500));
  }
  const s = sched.ledger.s;
  const b = sched.ledger.builder(builder.address);
  assert.equal(b.held, 0n, "nothing left on hold");
  assert.equal(b.spent, s.vault.usdg, "builder paid = what reached the Holder Vault (nodes get no USDG)");
  const verified = [...sched.jobs.values()].filter((j) => j.status === "verified");
  assert.equal(b.spent, verified.reduce((a, j) => a + j.credits, 0n), "only verified jobs are charged");
  assert.equal(b.credits, 1_000_000n - b.spent, "disputed job was refunded");
  for (const e of s.epochs.filter((e) => e.receipts > 0)) {
    assert.equal(merkleRoot(e.leaves), e.root);
    for (const l of e.leaves) assert.ok(verifyProof(merkleProof(e.leaves, l), e.root, l));
    const paid = e.rewards.reduce((a, r) => a + r.idlex, 0n);
    assert.ok(paid <= 60_000n * IDLEX, "epoch total within the hourly cap (10,000 $IDLEX x 6 h)");
    for (const r of e.rewards) assert.ok(r.idlex >= BigInt(r.jobs) * 100n * IDLEX && r.idlex <= BigInt(r.jobs) * 1_000n * IDLEX, "100-1,000 $IDLEX per verified job");
    for (const r of e.rewards) assert.ok(sched.ledger.isEligible(r.node as Address), "only eligible nodes earn");
  }
  assert.equal(sched.ledger.node(n1.address).rewardIdlex, 0n, "slashed node earns nothing");
  // n3 claimed 9,000,000 gpuMs once; rewards are drawn per job by the scheduler, so it still gets 100-1,000 per job.
  const r3 = sched.ledger.node(n3.address).rewardIdlex;
  assert.ok(r3 >= 2n * 100n * IDLEX && r3 <= 2n * 1_000n * IDLEX, "inflated gpuMs earns nothing extra");
  assert.equal(s.vault.idlex, 7_500n * IDLEX, "slashed stake went to the vault");
});

await sched.close();
console.log(`\n${passed} passed${process.exitCode ? ", some FAILED" : ", all good"}`);
process.exit(process.exitCode ?? 0);
