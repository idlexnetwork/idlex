// Builder CLI for the online network: submit AI jobs and fetch their results.
//
//   node src/net-builder.ts credits --usdg 5                         dev faucet (sim scheduler only)
//   node src/net-builder.ts image --prompt "a rig glowing at night" [--seed 42] [--steps 20] [--size 512]
//   node src/net-builder.ts text  --prompt "Explain GPUs in one line" [--model qwen2.5-3b] [--max 128]
//   ... [--network http://localhost:3130] [--key-file ~/.idlex-node/builder.json]
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { loadOrCreateKey } from "./node-client.ts";
import { signedHeaders, type JobSpec } from "./protocol.ts";

const arg = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const base = arg("network", "https://www.idlex.network")!;
const account = loadOrCreateKey(arg("key-file", join(homedir(), ".idlex-node", "builder.json"))!);

async function post(path: string, body: unknown) {
  const text = JSON.stringify(body);
  const res = await fetch(base + path, { method: "POST", headers: await signedHeaders(account, "POST", path, text), body: text });
  return { status: res.status, data: (await res.json().catch(() => null)) as any };
}

async function waitFor(jobId: string) {
  for (let i = 0; i < 400; i++) {
    const j = await fetch(`${base}/api/network/jobs/${jobId}`).then((r) => r.json());
    if (["verified", "disputed", "refunded", "failed"].includes(j.status)) return j;
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error("timed out waiting for the job");
}

const cmd = process.argv[2];
if (cmd === "credits") {
  console.log((await post("/api/network/dev/credits", { usdg: Number(arg("usdg", "5")) })).data);
} else if (cmd === "image" || cmd === "text") {
  const size = Number(arg("size", "512"));
  const spec: JobSpec =
    cmd === "image"
      ? { kind: "image", params: { model: "sd15", prompt: arg("prompt", "a gaming PC glowing at night, cinematic")!, negative: "", width: size, height: size, steps: Number(arg("steps", "20")), guidance: 7, seed: Number(arg("seed", String(Math.floor(Math.random() * 2 ** 32)))) } }
      : { kind: "text", params: { model: (arg("model", "qwen2.5-3b") as "qwen2.5-3b"), prompt: arg("prompt", "In one sentence, what is a GPU?")!, system: "", maxTokens: Number(arg("max", "128")) } };
  const sub = await post("/api/network/jobs", { spec });
  if (sub.status !== 200) throw new Error(`submit failed: ${sub.data?.error}`);
  console.log(`builder ${account.address} submitted ${cmd} job ${sub.data.jobId} for ${Number(sub.data.credits) / 1e6} USDG`);
  const j = await waitFor(sub.data.jobId);
  console.log(`status ${j.status}${j.checked ? " (spot-checked)" : ""}${j.note ? ` · ${j.note}` : ""}`);
  if (j.output_text) console.log(`\n${j.output_text}\n`);
  if (j.output_url) {
    const url = j.output_url.startsWith("http") ? j.output_url : base + j.output_url;
    const png = Buffer.from(await (await fetch(url)).arrayBuffer());
    const file = `job-${j.id.slice(2, 10)}.png`;
    writeFileSync(file, png);
    console.log(`image saved to ${file} (${url})`);
  }
} else {
  console.log("usage: node src/net-builder.ts credits --usdg 5 | image --prompt ... | text --prompt ... [--network url]");
}
