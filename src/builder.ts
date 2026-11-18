// Builder CLI (prototype): top up credits from the dev faucet, submit Julia-tile jobs, wait for
// them to be verified and save the images.
//
//   node src/builder.ts submit [--count 4] [--size 1024] [--iter 2000] [--credits 5] [--scheduler url]
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { loadOrCreateKey } from "./node-client.ts";
import { signedHeaders, type JuliaParams } from "./protocol.ts";

const arg = (n: string, d: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : d;
};

/** A few good-looking Julia constants. */
const SEEDS: [number, number][] = [[-0.8, 0.156], [-0.7269, 0.1889], [0.285, 0.01], [-0.4, 0.6], [-0.835, -0.2321], [0.355, 0.355], [-0.70176, -0.3842], [-0.75, 0.11]];

export async function submitJobs(opts: { scheduler: string; keyFile: string; count: number; size: number; iter: number; credits: number; outDir: string; label?: string }) {
  const account = loadOrCreateKey(opts.keyFile);
  const say = (m: string) => console.log(`[builder ${opts.label ?? account.address.slice(0, 8)}] ${m}`);
  const post = async (path: string, body: unknown) => {
    const text = JSON.stringify(body);
    const r = await fetch(opts.scheduler + path, { method: "POST", headers: await signedHeaders(account, "POST", path, text), body: text });
    return { status: r.status, data: (await r.json()) as any };
  };
  if (opts.credits > 0) {
    const t = await post("/api/dev/credits", { usdg: opts.credits });
    say(`topped up ${opts.credits} USDG of credits (dev faucet): ${t.status === 200 ? "ok" : t.data.error}`);
  }
  const ids: string[] = [];
  for (let i = 0; i < opts.count; i++) {
    const [cRe, cIm] = SEEDS[i % SEEDS.length];
    const params: JuliaParams = { width: opts.size, height: Math.round((opts.size * 3) / 4), maxIter: opts.iter, cRe, cIm, centerRe: 0, centerIm: 0, span: 3.2 };
    const r = await post("/api/jobs", { params, nonce: `${Date.now()}-${i}` });
    if (r.status !== 200) throw new Error(`submit failed: ${r.data.error}`);
    ids.push(r.data.jobId);
    say(`submitted ${r.data.jobId.slice(0, 10)} for ${(Number(r.data.credits) / 1e6).toFixed(4)} USDG`);
  }
  mkdirSync(opts.outDir, { recursive: true });
  const done = new Set<string>();
  const deadline = Date.now() + 10 * 60_000;
  while (done.size < ids.length && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000));
    for (const id of ids) {
      if (done.has(id)) continue;
      const j = (await (await fetch(`${opts.scheduler}/api/jobs/${id}`)).json()) as any;
      if (j.status === "verified") {
        const png = Buffer.from(await (await fetch(`${opts.scheduler}/api/jobs/${id}/output.png`)).arrayBuffer());
        writeFileSync(join(opts.outDir, `${id.slice(0, 10)}.png`), png);
        done.add(id);
        say(`${id.slice(0, 10)} verified${j.checked ? " (spot-checked)" : ""}, saved ${join(opts.outDir, id.slice(0, 10) + ".png")}`);
      } else if (j.status === "disputed" || j.status === "refunded") {
        done.add(id);
        say(`${id.slice(0, 10)} ${j.status}: ${j.note}`);
      }
    }
  }
  return ids;
}

if (import.meta.main) {
  if (process.argv[2] !== "submit") {
    console.log("usage: node src/builder.ts submit [--count 4] [--size 1024] [--iter 2000] [--credits 5] [--scheduler url]");
  } else {
    await submitJobs({
      scheduler: arg("scheduler", "http://localhost:8787"),
      keyFile: arg("key-file", join(homedir(), ".idlex-node", "builder.json")),
      count: Number(arg("count", "4")),
      size: Number(arg("size", "1024")),
      iter: Number(arg("iter", "2000")),
      credits: Number(arg("credits", "5")),
      outDir: arg("out", "out/jobs"),
    });
  }
}
