// Idlex node agent: the program a GPU owner runs to join the network.
//
//   node src/agent.ts init                                     create the node key (~/.idlex-node/key.json)
//   node src/agent.ts link-message --owner 0xWALLET            print the message the owner wallet signs
//   node src/agent.ts start [--network URL] [--owner 0x.. --owner-sig 0x..] [--hours 0-24] [--ask 0.9] [--rent 0.25] [--stake N] [--no-image] [--no-text] [--no-embed]
//   node src/agent.ts model list | model add qwen2.5-7b      see and download models (models.ts)
//
// Text models: the node offers each one on disk that fits its VRAM next to the image model (one text model is loaded
// at a time). Qwen2.5 7B needs about 6.5 GB on its own, so an 8 GB card offers it with --no-image, and a card with
// 12 GB or more offers it next to images.
//
// --ask sets your price on the open market, as a multiple of the listed price (0.5 to 2): "--ask 0.9" for every
// model, or per model: "--ask sd15=0.8,qwen2.5-7b=1.2". Lower asks win more jobs; without it you ask 1×.
//
// --rent puts this GPU up for rent at that many USDG an hour (0.05 to 5). A builder can then book it for 1 to 24
// hours; meanwhile it runs only their jobs. The renter pays in USDG like a job payment; you keep earning $IDLEX
// per verified job. Without it the node is not for rent.
//
// The node key only signs requests and receipts. The owner wallet (linked once with a signature,
// no gas) holds the stake and receives the rewards, so this program never needs it.
// --stake uses the dev faucet and only works on a local / sim scheduler.
import { execFile } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";
import { promisify } from "node:util";
import type { Hex } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import { loadOrCreateKey } from "./node-client.ts";
import { EmbedRunner, ImageRunner, PATHS, TextRunner } from "./ai-runners.ts";
import { DOWNLOADS, addModel, onDisk } from "./models.ts";
import { MODELS, linkMessage, sha256Hex, signReceipt, signedHeaders, validateSpec, type JobSpec, type TextModel } from "./protocol.ts";

const run = promisify(execFile);
const arg = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const flag = (name: string) => process.argv.includes(`--${name}`);
const API = "/api/network";

type Gpu = { name: string; uuid: string; vramMb: number };

/** GPU name, UUID and VRAM from nvidia-smi. */
export async function probeGpu(): Promise<Gpu> {
  const { stdout } = await run("nvidia-smi", ["--query-gpu=name,uuid,memory.total", "--format=csv,noheader,nounits"]);
  const [name, uuid, mem] = stdout.trim().split("\n")[0].split(",").map((s) => s.trim());
  // IDLEX_GPU_UUID: local testing only (two test nodes on one GPU). The scheduler still allows one wallet per GPU.
  return { name, uuid: process.env.IDLEX_GPU_UUID ?? uuid, vramMb: Number(mem) };
}

/** Pause when another program uses the GPU (a game, a render) or the GPU runs hot. */
async function gpuBusyOrHot(ownPids: Set<number>): Promise<string | null> {
  if (process.env.IDLEX_NO_BUSY_CHECK === "1") return null;
  try {
    const t = await run("nvidia-smi", ["--query-gpu=temperature.gpu", "--format=csv,noheader,nounits"]);
    if (Number(t.stdout.trim()) >= 83) return `GPU at ${t.stdout.trim()}°C`;
    const p = await run("nvidia-smi", ["--query-compute-apps=pid,used_memory", "--format=csv,noheader,nounits"]);
    const others = p.stdout.trim().split("\n").filter(Boolean).map((l) => l.split(",").map((s) => s.trim()))
      .filter(([pid, mem]) => !ownPids.has(Number(pid)) && Number(mem) > 500);
    if (others.length) return `another program is using ${others[0][1]} MB of VRAM`;
  } catch {
    /* no nvidia-smi: don't block */
  }
  return null;
}

/** Text models this GPU can hold: one text model at a time, next to the image model when images are on. */
export function textModelsThatFit(vramMb: number, models: TextModel[], withImage: boolean) {
  const room = vramMb - (withImage ? MODELS.sd15.vramMb : 0);
  return { fit: models.filter((m) => MODELS[m].vramMb <= room), tooBig: models.filter((m) => MODELS[m].vramMb > room) };
}

/** --hours "1-8,9-17": local hours when the node may work. */
function inHours(spec: string | undefined) {
  if (!spec) return true;
  const h = new Date().getHours();
  return spec.split(",").some((r) => {
    const [a, b] = r.split("-").map(Number);
    return a <= b ? h >= a && h < b : h >= a || h < b;
  });
}

/** --ask "0.9" or "sd15=0.8,qwen2.5-3b=1.1": the open-market ask per model, as a multiple of the listed price. */
export function parseAsk(spec: string | undefined, caps: string[]): Record<string, number> {
  if (!spec) return {};
  const models = caps.map((c) => c.split(":")[1]).filter(Boolean);
  const out: Record<string, number> = {};
  for (const part of spec.split(",").map((p) => p.trim()).filter(Boolean)) {
    const [k, v] = part.includes("=") ? part.split("=") : ["*", part];
    const x = Number(v);
    if (!Number.isFinite(x) || x < 0.5 || x > 2) throw new Error(`--ask ${part}: the ask must be between 0.5 and 2 (times the listed price)`);
    for (const m of k === "*" ? models : [k.trim()]) out[m] = x;
  }
  return out;
}

async function call(account: PrivateKeyAccount, base: string, path: string, body: unknown) {
  const text = JSON.stringify(body ?? {});
  const res = await fetch(base + path, { method: "POST", headers: await signedHeaders(account, "POST", path, text), body: text });
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  return { status: res.status, data: data as any };
}

export async function startAgent(opts: {
  network: string; keyFile: string; owner?: string; ownerSig?: Hex; hours?: string; ask?: string; rent?: string; stake?: number; image: boolean; text: boolean; embed: boolean;
}) {
  const account = loadOrCreateKey(opts.keyFile);
  const say = (m: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${m}`);
  const gpu = await probeGpu();
  say(`node key ${account.address} · ${gpu.name} · ${gpu.vramMb} MB`);

  const image = new ImageRunner();
  const text = new TextRunner();
  const embed = new EmbedRunner();
  // Never leave llama-server or the image worker holding VRAM after the agent exits (error, second signal).
  process.on("exit", () => {
    image.stop();
    text.stop();
    embed.stop();
  });
  const caps: string[] = [];
  if (opts.image && image.available() && gpu.vramMb >= MODELS.sd15.vramMb) {
    say("starting the image model (first run downloads it)…");
    await image.start(say);
    caps.push(MODELS.sd15.tag);
  }
  if (opts.text && text.available()) {
    const { fit, tooBig } = textModelsThatFit(gpu.vramMb, TextRunner.modelsOnDisk(), caps.includes(MODELS.sd15.tag));
    for (const m of fit) caps.push(MODELS[m].tag);
    for (const m of tooBig) {
      const alone = MODELS[m].vramMb <= gpu.vramMb;
      say(`${m} is on disk but needs ${MODELS[m].vramMb} MB${caps.includes(MODELS.sd15.tag) ? " next to the image model" : ""}${alone ? ": start with --no-image to offer it" : ": this GPU is too small for it"}`);
    }
  }
  if (opts.embed && embed.available() && gpu.vramMb >= MODELS["nomic-embed-v1.5"].vramMb) caps.push(MODELS["nomic-embed-v1.5"].tag);
  if (!caps.length) throw new Error("no AI runtime available: install the image model (Python env) or a text model (llama.cpp + GGUF)");
  say(`capabilities: ${caps.join(", ")}`);
  const asks = parseAsk(opts.ask, caps);
  if (Object.keys(asks).length) say(`open market asks: ${Object.entries(asks).map(([m, x]) => `${m} ${x}×`).join(", ")}`);

  const reg = await call(account, opts.network, `${API}/nodes/register`, {
    gpu: gpu.name, gpuUuid: gpu.uuid, vramMb: gpu.vramMb, caps, benchmarkMs: 0, owner: opts.owner, ownerSig: opts.ownerSig, asks, rent: opts.rent ? Number(opts.rent) : undefined,
  });
  if (reg.status !== 200) throw new Error(`register failed: ${reg.data?.error}`);
  say(`registered · owner ${reg.data.owner} · can work: ${reg.data.canWork} · earns $IDLEX: ${reg.data.earnsIdlex} · mode ${reg.data.chainMode}`);
  if (reg.data.rentRate) say(`for rent at ${Number(reg.data.rentRate) / 1e6} USDG an hour${reg.data.rental ? ` · booked until ${reg.data.rental.ends_at}` : ""}`);
  const tier = reg.data.tier as { name: string; verified: number; next: { name: string; needs: string[] } | null } | undefined;
  if (tier) {
    say(`reputation tier: ${tier.name} (${tier.verified} verified)${tier.next ? ` · ${tier.next.name} needs ${tier.next.needs.join(", ") || "a little more time"}` : " · top tier"}`);
  }
  if (opts.stake) {
    const st = await call(account, opts.network, `${API}/dev/stake`, { idlex: opts.stake });
    say(st.status === 200 ? `dev stake ${opts.stake} $IDLEX · can work: ${st.data.canWork}` : `stake failed: ${st.data?.error}`);
  }

  const own = new Set<number>([process.pid]);
  let stopping = false;
  // Ctrl+C, or SIGTERM from systemd / kill on Linux: finish the current job, then stop. A second signal stops now.
  const onSignal = () => {
    if (stopping) process.exit(130);
    stopping = true;
    say("stopping…");
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  while (!stopping) {
    if (!inHours(opts.hours)) {
      await new Promise((r) => setTimeout(r, 60_000));
      continue;
    }
    for (const pid of [image.pid, text.pid]) if (pid) own.add(pid); // our own workers don't count
    const busy = await gpuBusyOrHot(own);
    if (busy) {
      say(`paused: ${busy}`);
      await new Promise((r) => setTimeout(r, 30_000));
      continue;
    }
    let task;
    try {
      task = await call(account, opts.network, `${API}/nodes/poll`, {});
    } catch (e) {
      say(`network unreachable (${(e as Error).message}); retrying`);
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }
    if (task.status === 204) continue;
    if (task.status !== 200) {
      say(`poll ${task.status}: ${task.data?.error}`);
      await new Promise((r) => setTimeout(r, task.status === 403 ? 30_000 : 5000));
      continue;
    }
    const { taskId, jobId, role, epoch } = task.data;
    let spec: JobSpec;
    try {
      spec = validateSpec(task.data.spec);
    } catch (e) {
      say(`bad job spec: ${(e as Error).message}`);
      continue;
    }
    try {
      let body: Record<string, unknown>;
      let outputHash: Hex, gpuMs: number;
      if (spec.kind === "image") {
        const r = await image.run(spec.params);
        outputHash = sha256Hex(r.png);
        gpuMs = r.gpuMs;
        body = { png: r.png.toString("base64") };
      } else if (spec.kind === "text") {
        const r = await text.run(spec.params, say);
        outputHash = sha256Hex(r.text);
        gpuMs = r.gpuMs;
        body = { text: r.text };
      } else if (spec.kind === "embed") {
        const r = await embed.run(spec.params, say);
        outputHash = sha256Hex(r.json);
        gpuMs = r.gpuMs;
        body = { vectors: r.json };
      } else {
        say(`skipping ${spec.kind} job: not supported by this agent`);
        continue;
      }
      const receipt = { jobId: jobId as Hex, node: account.address, outputHash, gpuMs: BigInt(Math.round(gpuMs)), epoch: BigInt(epoch) };
      const signature = await signReceipt(account, receipt);
      const done = await call(account, opts.network, `${API}/tasks/${taskId}/result`, { ...body, outputHash, gpuMs, epoch, signature });
      say(`${role.padEnd(8)} ${spec.kind} ${jobId.slice(0, 10)} in ${(gpuMs / 1000).toFixed(1)} s -> ${done.status === 200 ? done.data.status : done.data?.error}`);
    } catch (e) {
      say(`job ${jobId.slice(0, 10)} failed: ${(e as Error).message}`);
    }
  }
  image.stop();
  embed.stop();
  text.stop();
}

if (import.meta.main) {
  const cmd = process.argv[2];
  const keyFile = arg("key-file", join(homedir(), ".idlex-node", "key.json"))!;
  if (cmd === "init") {
    const a = loadOrCreateKey(keyFile);
    console.log(`Node key ${a.address}\nKey file ${keyFile}\nThis key only signs for the node. Never send funds to it.`);
  } else if (cmd === "link-message") {
    const a = loadOrCreateKey(keyFile);
    const owner = arg("owner");
    if (!owner) throw new Error("--owner 0xYOUR_WALLET is required");
    console.log(`Sign this message with ${owner} (personal_sign, no gas), then pass it as --owner-sig:\n\n${linkMessage(a.address, owner)}`);
  } else if (cmd === "start") {
    const stake = arg("stake");
    await startAgent({
      network: arg("network", "https://www.idlex.network")!, keyFile, owner: arg("owner"), ownerSig: arg("owner-sig") as Hex | undefined,
      hours: arg("hours"), ask: arg("ask"), rent: arg("rent"), stake: stake ? Number(stake) : undefined, image: !flag("no-image"), text: !flag("no-text"), embed: !flag("no-embed"),
    });
  } else if (cmd === "model" && process.argv[3] === "add") {
    const model = process.argv[4];
    if (!model) throw new Error(`usage: node src/agent.ts model add <${Object.keys(DOWNLOADS).join(" | ")}>`);
    await addModel(PATHS.models, model, (m) => console.log(m));
    console.log(`${model} is ready. Restart the node to offer it.`);
  } else if (cmd === "model") {
    const gpu = await probeGpu().catch(() => null);
    const text = (Object.keys(MODELS) as (keyof typeof MODELS)[]).filter((m) => MODELS[m].kind === "text") as TextModel[];
    const here = text.filter((m) => onDisk(PATHS.models, m));
    const withImage = textModelsThatFit(gpu?.vramMb ?? 0, here, true).fit;
    const alone = textModelsThatFit(gpu?.vramMb ?? 0, here, false).fit;
    console.log(gpu ? `${gpu.name} · ${gpu.vramMb} MB` : "no NVIDIA GPU found");
    for (const m of text) {
      const gb = DOWNLOADS[m].reduce((s, p) => s + p.bytes, 0) / 1e9;
      const state = !here.includes(m)
        ? `not downloaded (${gb.toFixed(1)} GB): node src/agent.ts model add ${m}`
        : withImage.includes(m) ? "offered" : alone.includes(m) ? "offered with --no-image" : "too big for this GPU";
      console.log(`  ${m.padEnd(12)} needs ${MODELS[m].vramMb} MB · ${state}`);
    }
  } else {
    console.log("usage: node src/agent.ts init | link-message --owner 0x.. | start [--network url] [--owner 0x.. --owner-sig 0x..] [--hours 1-8,9-17] [--ask 0.9] [--rent 0.25] [--stake n] [--no-image] [--no-text] [--no-embed] | model list | model add <model>");
  }
}
