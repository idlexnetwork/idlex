// Model files a node can download, pinned by SHA-256, and the `model` command that fetches them:
//
//   node src/agent.ts model list               what is on disk, and what fits this GPU
//   node src/agent.ts model add qwen2.5-7b     download a model (resumes after a dropped connection)
//
// The installers fetch the default models; bigger ones are added here, so a node that is already running can take
// them on without reinstalling. Qwen ships its 7B GGUF in two parts; llama.cpp loads it from the first part as long
// as the second sits next to it.
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, renameSync, statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { TextModel } from "./protocol.ts";

export type ModelFile = { file: string; url: string; sha256: string; bytes: number };

const HF = "https://huggingface.co";
export const DOWNLOADS: Record<TextModel | "nomic-embed-v1.5", ModelFile[]> = {
  "qwen2.5-3b": [
    {
      file: "qwen2.5-3b-instruct-q4_k_m.gguf",
      url: `${HF}/Qwen/Qwen2.5-3B-Instruct-GGUF/resolve/main/qwen2.5-3b-instruct-q4_k_m.gguf`,
      sha256: "626b4a6678b86442240e33df819e00132d3ba7dddfe1cdc4fbb18e0a9615c62d",
      bytes: 2_104_932_768,
    },
  ],
  "qwen2.5-7b": [
    {
      file: "qwen2.5-7b-instruct-q4_k_m-00001-of-00002.gguf",
      url: `${HF}/Qwen/Qwen2.5-7B-Instruct-GGUF/resolve/main/qwen2.5-7b-instruct-q4_k_m-00001-of-00002.gguf`,
      sha256: "dfce12e3862a5283ccfb88221b48480e58745165de856439950d0f22590580db",
      bytes: 3_993_201_344,
    },
    {
      file: "qwen2.5-7b-instruct-q4_k_m-00002-of-00002.gguf",
      url: `${HF}/Qwen/Qwen2.5-7B-Instruct-GGUF/resolve/main/qwen2.5-7b-instruct-q4_k_m-00002-of-00002.gguf`,
      sha256: "539cf93f78e887edea1c04e2d7d8cdaca9d01dae9c9025bcb8accbe29df3d72a",
      bytes: 689_872_288,
    },
  ],
  "nomic-embed-v1.5": [
    {
      file: "nomic-embed-text-v1.5.Q8_0.gguf",
      url: `${HF}/nomic-ai/nomic-embed-text-v1.5-GGUF/resolve/main/nomic-embed-text-v1.5.Q8_0.gguf`,
      sha256: "3e24342164b3d94991ba9692fdc0dd08e3fd7362e0aacc396a9a5c54a544c3b7",
      bytes: 0,
    },
  ],
};

/** True when every part of the model is on disk (size checked; the hash is checked when it is downloaded). */
export function onDisk(dir: string, model: keyof typeof DOWNLOADS) {
  return DOWNLOADS[model].every((p) => existsSync(join(dir, p.file)) && (!p.bytes || statSync(join(dir, p.file)).size === p.bytes));
}

async function sha256File(path: string) {
  const h = createHash("sha256");
  await pipeline(createReadStream(path), h);
  return h.digest("hex");
}

/** Downloads one file into dir, resuming a partial download (<file>.part), and checks its SHA-256 before keeping it. */
async function fetchFile(dir: string, p: ModelFile, log: (m: string) => void) {
  const dest = join(dir, p.file);
  if (existsSync(dest) && (!p.bytes || statSync(dest).size === p.bytes)) {
    log(`${p.file}: already here`);
    return;
  }
  const part = `${dest}.part`;
  for (let attempt = 1; ; attempt++) {
    const have = existsSync(part) ? statSync(part).size : 0;
    try {
      if (p.bytes && have >= p.bytes) break;
      const res = await fetch(p.url, { headers: have ? { range: `bytes=${have}-` } : {} });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      const append = have > 0 && res.status === 206;
      log(`${p.file}: ${append ? `resuming at ${(have / 1e9).toFixed(2)} GB` : "downloading"}${p.bytes ? ` of ${(p.bytes / 1e9).toFixed(2)} GB` : ""}`);
      await pipeline(Readable.fromWeb(res.body as import("node:stream/web").ReadableStream), createWriteStream(part, { flags: append ? "a" : "w" }));
      break;
    } catch (e) {
      if (attempt >= 8) throw new Error(`${p.file}: download failed (${(e as Error).message}); run the command again to resume`);
      log(`${p.file}: ${(e as Error).message}, retrying`);
      await new Promise((r) => setTimeout(r, 3000 * attempt));
    }
  }
  log(`${p.file}: checking SHA-256`);
  const got = await sha256File(part);
  if (got !== p.sha256) throw new Error(`${p.file}: SHA-256 mismatch (got ${got}); delete ${part} and try again`);
  renameSync(part, dest);
  log(`${p.file}: ok`);
}

export async function addModel(dir: string, model: string, log: (m: string) => void) {
  if (!(model in DOWNLOADS)) throw new Error(`unknown model ${model}; one of: ${Object.keys(DOWNLOADS).join(", ")}`);
  await mkdir(dir, { recursive: true });
  for (const p of DOWNLOADS[model as keyof typeof DOWNLOADS]) await fetchFile(dir, p, log);
}
