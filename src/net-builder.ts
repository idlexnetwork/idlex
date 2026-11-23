// Builder CLI for the online network: submit AI jobs and fetch their results.
//
//   node src/net-builder.ts credits --usdg 5                         dev faucet (sim scheduler only)
//   node src/net-builder.ts image --prompt "a rig glowing at night" [--seed 42] [--steps 20] [--size 512]
//   node src/net-builder.ts text  --prompt "Explain GPUs in one line" [--model qwen2.5-3b] [--max 128]
//   node src/net-builder.ts gpus                                     GPUs for rent, with their hourly rate
//   node src/net-builder.ts rent --node 0x… --hours 2                book a GPU; your image/text jobs then run on it
//   node src/net-builder.ts rental --id r_…  |  end-rental --id r_…   status, or end a booking early
//   node src/net-builder.ts extend-rental --id r_… --hours 2         add hours to a running booking, at its rate
//   ... [--network http://localhost:3130] [--key-file ~/.idlex-node/builder.json] [--api-key idx_… | IDLEX_API_KEY=idx_…]
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

// An API key from idlex.network/build sends jobs instead of signing them; everything else is signed by the key file.
const apiKey = arg("api-key", process.env.IDLEX_API_KEY);

async function post(path: string, body: unknown) {
  const text = JSON.stringify(body);
  const headers = apiKey && path === "/api/network/jobs"
    ? { "content-type": "application/json", authorization: `Bearer ${apiKey}` }
    : await signedHeaders(account, "POST", path, text);
  const res = await fetch(base + path, { method: "POST", headers, body: text });
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
  console.log(`builder ${apiKey ? "(API key)" : account.address} submitted ${cmd} job ${sub.data.jobId}${sub.data.rental ? ` on your rented GPU (${sub.data.matchedNode})` : ` for ${Number(sub.data.credits) / 1e6} USDG`}`);
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
} else if (cmd === "gpus") {
  const r = await fetch(`${base}/api/network/rentals/nodes`).then((x) => x.json() as Promise<any>);
  for (const n of r.nodes) {
    console.log(`${n.node}  ${n.gpu}  ${Math.round(n.vramMb / 1024)} GB  ${Number(n.ratePerHour) / 1e6} USDG/h  ${n.online ? (n.bookedUntil ? `booked until ${n.bookedUntil}` : "available") : "offline"}`);
  }
  if (!r.nodes.length) console.log("no GPU is for rent right now");
} else if (cmd === "rent") {
  const b = await post("/api/network/rentals", { node: arg("node"), hours: Number(arg("hours", "1")) });
  if (b.status !== 200) throw new Error(`rent failed: ${b.data?.error}`);
  console.log(`booked ${b.data.id}: node ${b.data.node} for ${b.data.hours} h at ${Number(b.data.ratePerHour) / 1e6} USDG/h, until ${b.data.endsAt}`);
  console.log(`${Number(b.data.held) / 1e6} USDG held; you pay only for the time the node is online. Submit jobs as usual: they run on it.`);
} else if (cmd === "rental") {
  console.log(await fetch(`${base}/api/network/rentals/${arg("id")}`).then((x) => x.json()));
} else if (cmd === "end-rental") {
  console.log((await post(`/api/network/rentals/${arg("id")}/end`, {})).data);
} else if (cmd === "extend-rental") {
  const x = await post(`/api/network/rentals/${arg("id")}/extend`, { hours: Number(arg("hours", "1")) });
  if (x.status !== 200) throw new Error(`extend failed: ${x.data?.error}`);
  console.log(`extended ${x.data.id}: ${x.data.hours} h booked in all, now until ${x.data.endsAt}; ${Number(x.data.held) / 1e6} USDG held in all`);
} else {
  console.log("usage: node src/net-builder.ts credits --usdg 5 | image --prompt ... | text --prompt ... | gpus | rent --node 0x.. --hours 2 | rental --id r_.. | extend-rental --id r_.. --hours 2 | end-rental --id r_.. [--network url]");
}
