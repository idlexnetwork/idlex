// Idlex node client (prototype). Runs on the PC with the GPU: benchmarks the card, registers its
// wallet with the scheduler, then long-polls for jobs, renders them on the GPU and returns the
// output with a signed receipt.
//
//   node src/node-client.ts init  [--key-file path]                 create a local test wallet
//   node src/node-client.ts start [--scheduler url] [--gpu high|low] [--stake 15000] [--cheat]
//
// --stake uses the scheduler's dev faucet (no real tokens). --cheat returns wrong pixels on
// purpose so you can watch a spot-check catch it and slash the stake.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import type { Hex } from "viem";
import { GpuRunner } from "./gpu-runner.ts";
import { toKernel } from "./kernel.ts";
import { encodePng } from "./png.ts";
import { sha256Hex, signReceipt, signedHeaders, validateParams, type JuliaParams } from "./protocol.ts";

const BENCH: JuliaParams = { width: 512, height: 512, maxIter: 1000, cRe: -0.8, cIm: 0.156, centerRe: 0, centerIm: 0, span: 3.2 };

function arg(name: string, fallback?: string) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

export function loadOrCreateKey(file: string) {
  if (existsSync(file)) return privateKeyToAccount(JSON.parse(readFileSync(file, "utf8")).privateKey as Hex);
  mkdirSync(dirname(file), { recursive: true });
  const privateKey = generatePrivateKey();
  writeFileSync(file, JSON.stringify({ privateKey, note: "Idlex prototype test wallet. Never send real funds to it." }, null, 2), { mode: 0o600 });
  return privateKeyToAccount(privateKey);
}

async function call(account: PrivateKeyAccount, base: string, path: string, body: unknown) {
  const text = JSON.stringify(body ?? {});
  const res = await fetch(base + path, { method: "POST", headers: await signedHeaders(account, "POST", path, text), body: text });
  const out = res.status === 204 ? null : await res.json().catch(() => null);
  return { status: res.status, data: out as any };
}

export async function runNode(opts: { scheduler: string; keyFile: string; gpu: "high" | "low"; stake?: number; cheat?: boolean; label?: string; signal?: AbortSignal }) {
  const account = loadOrCreateKey(opts.keyFile);
  const tag = opts.label ?? account.address.slice(0, 8);
  const say = (m: string) => console.log(`[node ${tag}] ${m}`);
  const runner = new GpuRunner(opts.gpu);
  const info = await runner.start();
  const gpuName = `${info.vendor} ${info.architecture}`.trim() || "unknown GPU";
  await runner.run(toKernel(BENCH)); // warm-up (shader compile)
  const bench = await runner.run(toKernel(BENCH));
  say(`wallet ${account.address}, GPU ${gpuName}, benchmark ${bench.gpuMs.toFixed(1)} ms${opts.cheat ? ", CHEAT MODE" : ""}`);

  const reg = await call(account, opts.scheduler, "/api/nodes/register", { gpu: gpuName, benchmarkMs: bench.gpuMs, version: "0.1.0" });
  if (reg.status !== 200) throw new Error(`register failed: ${reg.data?.error}`);
  if (opts.stake) {
    const st = await call(account, opts.scheduler, "/api/dev/stake", { idlex: opts.stake });
    say(st.status === 200 ? `staked ${opts.stake} $IDLEX (dev faucet), eligible: ${st.data.eligible}` : `stake failed: ${st.data?.error}`);
  }

  while (!opts.signal?.aborted) {
    let task;
    try {
      task = await call(account, opts.scheduler, "/api/nodes/poll", {});
    } catch (e) {
      say(`scheduler unreachable (${(e as Error).message}); retrying in 3 s`);
      await new Promise((r) => setTimeout(r, 3000));
      continue;
    }
    if (task.status === 204) continue;
    if (task.status === 403) {
      say(`not eligible: ${task.data?.error}. Stake at least ${BigInt(task.data?.requiredStake ?? 0) / 10n ** 18n} $IDLEX. Waiting.`);
      await new Promise((r) => setTimeout(r, 10_000));
      continue;
    }
    if (task.status !== 200) {
      say(`poll error ${task.status}: ${task.data?.error}`);
      await new Promise((r) => setTimeout(r, 3000));
      continue;
    }
    const { taskId, jobId, role, epoch } = task.data;
    const params = validateParams(task.data.params);
    const { rgba, gpuMs } = await runner.run(toKernel(params));
    if (opts.cheat) {
      // A lazy node: skips the real work and fills in noise.
      for (let i = 0; i < rgba.length; i += 97) rgba[i] ^= 0x5a;
    }
    const outputHash = sha256Hex(rgba);
    const receipt = { jobId: jobId as Hex, node: account.address, outputHash, gpuMs: BigInt(Math.round(gpuMs)), epoch: BigInt(epoch) };
    const signature = await signReceipt(account, receipt);
    const png = encodePng(params.width, params.height, rgba).toString("base64");
    const done = await call(account, opts.scheduler, `/api/tasks/${taskId}/result`, { outputHash, gpuMs, epoch, signature, png });
    say(`${role.padEnd(8)} job ${jobId.slice(0, 10)} ${params.width}x${params.height} in ${gpuMs.toFixed(1)} ms -> ${done.status === 200 ? done.data.status : done.data?.error}`);
  }
  await runner.stop();
}

if (import.meta.main) {
  const cmd = process.argv[2];
  const keyFile = arg("key-file", join(homedir(), ".idlex-node", "key.json"))!;
  if (cmd === "init") {
    const a = loadOrCreateKey(keyFile);
    console.log(`Test wallet ${a.address}\nKey file ${keyFile}\nThis is a prototype key: never send real funds to it.`);
  } else if (cmd === "start") {
    const gpu = arg("gpu", "high") === "low" ? "low" : "high";
    const stake = arg("stake");
    await runNode({ scheduler: arg("scheduler", "http://localhost:8787")!, keyFile, gpu, stake: stake ? Number(stake) : undefined, cheat: flag("cheat") });
  } else {
    console.log("usage: node src/node-client.ts init | start [--scheduler url] [--gpu high|low] [--stake n] [--cheat] [--key-file path]");
  }
}
