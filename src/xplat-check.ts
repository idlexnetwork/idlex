// Cross-platform output check. Nodes re-run each other's jobs and a node that disagrees is slashed, so before
// a new platform or build goes live (Linux, a new llama.cpp, a new driver), run the same fixed jobs on both
// machines and compare them with the scheduler's own tolerance (src/verify.ts: dHash within 12 bits,
// text similarity ≥ 0.9). Uses the agent's runners, so the llama-server args and request body are a real job's.
//
//   node src/xplat-check.ts run out.json [--no-image] [--no-text]   run the fixed jobs here (needs the GPU)
//   node src/xplat-check.ts compare a.json b.json                   MATCH / MISMATCH per job, exit 1 on a mismatch
// Run it while the node agent is stopped: it loads both models on the GPU.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { ImageRunner, PATHS, TextRunner } from "./ai-runners.ts";
import { sha256Hex, type ImageParams, type TextParams } from "./protocol.ts";
import { decodeImage, fingerprintsMatch, hammingHex, imageFingerprint, textFingerprint, textSimilarity } from "./verify.ts";

const IMAGE_JOB: ImageParams = {
  model: "sd15", prompt: "a lighthouse on a rocky coast at sunset, oil painting", negative: "blurry, text",
  width: 512, height: 512, steps: 20, guidance: 7, seed: 42,
};
const TEXT_JOB: TextParams = {
  model: "qwen2.5-3b", system: "You are a concise assistant.", maxTokens: 256,
  prompt: "Explain in one short paragraph why the sky is blue, then list three everyday examples of light scattering.",
};

type Report = {
  platform: string; gpu: string; llama: string;
  image?: { fingerprint: string; sha256: string; gpuMs: number };
  text?: { output: string; sha256: string; gpuMs: number };
};

/** stdout + stderr of a command (llama-server prints its version on stderr). */
const tryRun = (cmd: string, args: string[]) => {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  return r.error ? `unavailable (${r.error.message})` : `${r.stdout}\n${r.stderr}`.trim();
};

async function run(out: string, image: boolean, text: boolean) {
  const log = (m: string) => console.log(m);
  const rep: Report = {
    platform: `${process.platform}-${process.arch}`,
    gpu: tryRun("nvidia-smi", ["--query-gpu=name,driver_version", "--format=csv,noheader"]).split("\n")[0],
    llama: tryRun(PATHS.llamaServer, ["--version"]).split("\n").find((l) => l.startsWith("version:")) ?? "unknown",
  };
  if (image) {
    const r = new ImageRunner();
    try {
      await r.start(log);
      const { png, gpuMs } = await r.run(IMAGE_JOB);
      const img = decodeImage(png, IMAGE_JOB.width, IMAGE_JOB.height);
      if (!img) throw new Error("image worker returned a bad PNG");
      writeFileSync(out.replace(/\.json$/, "") + ".png", png);
      rep.image = { fingerprint: imageFingerprint(img), sha256: sha256Hex(png), gpuMs };
    } finally {
      r.stop();
    }
  }
  if (text) {
    const r = new TextRunner();
    try {
      const { text: output, gpuMs } = await r.run(TEXT_JOB, log);
      rep.text = { output, sha256: sha256Hex(output), gpuMs };
    } finally {
      r.stop();
    }
  }
  writeFileSync(out, JSON.stringify(rep, null, 2));
  console.log(JSON.stringify(rep, null, 2));
}

function compare(a: Report, b: Report) {
  let ok = true;
  console.log(`A: ${a.platform} · ${a.gpu} · llama ${a.llama}\nB: ${b.platform} · ${b.gpu} · llama ${b.llama}`);
  if (a.image && b.image) {
    const bits = hammingHex(a.image.fingerprint, b.image.fingerprint);
    const match = fingerprintsMatch("image", a.image.fingerprint, b.image.fingerprint);
    ok &&= match;
    console.log(`image: ${match ? "MATCH" : "MISMATCH"} (${bits} of 64 bits differ, limit 12; identical PNG: ${a.image.sha256 === b.image.sha256})`);
  }
  if (a.text && b.text) {
    const fa = textFingerprint(a.text.output), fb = textFingerprint(b.text.output);
    const match = fingerprintsMatch("text", fa, fb);
    ok &&= match;
    console.log(`text: ${match ? "MATCH" : "MISMATCH"} (similarity ${textSimilarity(fa, fb).toFixed(4)}, need 0.9; identical: ${a.text.sha256 === b.text.sha256})`);
  }
  process.exit(ok ? 0 : 1);
}

const [cmd, x, y] = process.argv.slice(2);
if (cmd === "run" && x) await run(x, !process.argv.includes("--no-image"), !process.argv.includes("--no-text"));
else if (cmd === "compare" && x && y) compare(JSON.parse(readFileSync(x, "utf8")), JSON.parse(readFileSync(y, "utf8")));
else console.log("usage: node src/xplat-check.ts run out.json [--no-image] [--no-text] | compare a.json b.json");
