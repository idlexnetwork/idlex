// AI runners for the node client.
// - ImageRunner: a long-lived Python process (python/image_worker.py) running Stable Diffusion 1.5.
// - TextRunner:  llama.cpp's llama-server with a Qwen2.5 GGUF model, greedy decoding.
// - EmbedRunner: a second llama-server in embedding mode with nomic-embed-text-v1.5 (768 dims, mean pooling).
// Both report the GPU time of each job. Paths come from env so an installer can place them anywhere:
//   IDLEX_PYTHON (default node/.venv python), IDLEX_LLAMA_SERVER (node/bin/llama/llama-server),
//   IDLEX_MODELS_DIR (node/models), HF_HOME (node/models/hf).
// Windows (install.ps1) and Linux (install.sh) use the same layout: .venv/Scripts/python.exe vs .venv/bin/python,
// bin/llama/llama-server.exe vs bin/llama/llama-server.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { onDisk } from "./models.ts";
import { EMBED_DIMS, type EmbedParams, type ImageParams, type TextParams, type TextModel } from "./protocol.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const isWin = process.platform === "win32";
export const PATHS = {
  python: process.env.IDLEX_PYTHON ?? join(ROOT, ".venv", isWin ? "Scripts/python.exe" : "bin/python"),
  llamaServer: process.env.IDLEX_LLAMA_SERVER ?? join(ROOT, "bin", "llama", isWin ? "llama-server.exe" : "llama-server"),
  models: process.env.IDLEX_MODELS_DIR ?? join(ROOT, "models"),
};
/** The file llama-server loads for each text model (7B comes in two parts: llama.cpp finds the second one itself). */
export const TEXT_MODEL_FILES: Record<TextModel, string> = {
  "qwen2.5-3b": "qwen2.5-3b-instruct-q4_k_m.gguf",
  "qwen2.5-7b": "qwen2.5-7b-instruct-q4_k_m-00001-of-00002.gguf",
};
export const EMBED_MODEL_FILE = "nomic-embed-text-v1.5.Q8_0.gguf";

export class ImageRunner {
  private proc?: ChildProcess;
  private waiting = new Map<string, (r: { png?: string; gpu_ms?: number; nsfw?: boolean; error?: string }) => void>();
  private seq = 0;

  available() {
    return existsSync(PATHS.python) && existsSync(join(ROOT, "python", "image_worker.py"));
  }

  async start(log: (m: string) => void) {
    this.proc = spawn(PATHS.python, [join(ROOT, "python", "image_worker.py")], {
      env: { ...process.env, HF_HOME: process.env.HF_HOME ?? join(PATHS.models, "hf"), PYTHONUNBUFFERED: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    createInterface({ input: this.proc.stderr! }).on("line", (l) => log(`image worker: ${l}`));
    const lines = createInterface({ input: this.proc.stdout! });
    const ready = new Promise<{ ready: boolean; gpu?: string; error?: string }>((ok, fail) => {
      this.proc!.once("exit", (code) => fail(new Error(`image worker exited (${code})`)));
      lines.once("line", (l) => ok(JSON.parse(l)));
    });
    const r = await ready;
    if (!r.ready) throw new Error(r.error ?? "image worker failed to start");
    lines.on("line", (l) => {
      const msg = JSON.parse(l);
      this.waiting.get(msg.id)?.(msg);
      this.waiting.delete(msg.id);
    });
    return r.gpu ?? "";
  }

  run(p: ImageParams) {
    const id = String(++this.seq);
    return new Promise<{ png: Buffer; gpuMs: number }>((ok, fail) => {
      this.waiting.set(id, (r) => (r.error || !r.png ? fail(new Error(r.error ?? "no image")) : ok({ png: Buffer.from(r.png, "base64"), gpuMs: r.gpu_ms ?? 0 })));
      this.proc!.stdin!.write(JSON.stringify({ id, ...p }) + "\n");
    });
  }

  get pid() {
    return this.proc?.pid;
  }

  stop() {
    this.proc?.kill();
  }
}

export class TextRunner {
  private proc?: ChildProcess;
  private port = 8791 + Math.floor(Math.random() * 100);
  model?: TextModel;

  static modelsOnDisk(): TextModel[] {
    return (Object.keys(TEXT_MODEL_FILES) as TextModel[]).filter((m) => onDisk(PATHS.models, m));
  }

  available() {
    return existsSync(PATHS.llamaServer) && TextRunner.modelsOnDisk().length > 0;
  }

  /** Starts llama-server with one model (switching models restarts it). */
  async start(model: TextModel, log: (m: string) => void) {
    if (this.model === model && this.proc) return;
    this.stop();
    const file = join(PATHS.models, TEXT_MODEL_FILES[model]);
    // Linux: the CUDA runtime and cuBLAS that ship with llama.cpp sit next to llama-server. Its RUNPATH ($ORIGIN)
    // ranks below LD_LIBRARY_PATH, so put that folder first: a CUDA toolkit on LD_LIBRARY_PATH can't swap them.
    // (Windows already loads DLLs from the program's folder first.)
    const dir = dirname(PATHS.llamaServer);
    const env = isWin ? process.env : { ...process.env, LD_LIBRARY_PATH: [dir, process.env.LD_LIBRARY_PATH].filter(Boolean).join(":") };
    this.proc = spawn(PATHS.llamaServer, ["-m", file, "--port", String(this.port), "--host", "127.0.0.1", "-ngl", "99", "-c", "8192", "--no-webui"], {
      env,
      stdio: ["ignore", "ignore", "pipe"],
    });
    createInterface({ input: this.proc.stderr! }).on("line", (l) => {
      if (/error|failed/i.test(l)) log(`llama-server: ${l}`);
    });
    for (let i = 0; i < 120; i++) {
      const ok = await fetch(`http://127.0.0.1:${this.port}/health`).then((r) => r.ok).catch(() => false);
      if (ok) {
        this.model = model;
        return;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error("llama-server did not start");
  }

  async run(p: TextParams, log: (m: string) => void) {
    await this.start(p.model, log);
    const messages = [...(p.system ? [{ role: "system", content: p.system }] : []), { role: "user", content: p.prompt }];
    const t0 = performance.now();
    const res = await fetch(`http://127.0.0.1:${this.port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // Greedy decoding with a fixed seed so a spot-check on another GPU gives (nearly) the same text.
      body: JSON.stringify({ messages, max_tokens: p.maxTokens, temperature: 0, top_k: 1, seed: 0, cache_prompt: false }),
    });
    if (!res.ok) throw new Error(`llama-server ${res.status}`);
    const out = (await res.json()) as { choices: { message: { content: string } }[]; timings?: { predicted_ms?: number; prompt_ms?: number } };
    const gpuMs = out.timings ? (out.timings.predicted_ms ?? 0) + (out.timings.prompt_ms ?? 0) : performance.now() - t0;
    return { text: out.choices[0]?.message?.content ?? "", gpuMs };
  }

  get pid() {
    return this.proc?.pid;
  }

  stop() {
    this.proc?.kill();
    this.proc = undefined;
    this.model = undefined;
  }
}

/**
 * Embeddings with llama.cpp: its own llama-server in embedding mode (it can't share the chat server), started on
 * the first embed job and kept running. Each text gets nomic's task prefix ("search_document: " or
 * "search_query: "), and each vector is L2-normalized and rounded to 6 decimals, so the JSON the node hashes and
 * sends is stable.
 */
export class EmbedRunner {
  private proc?: ChildProcess;
  private port = 8901 + Math.floor(Math.random() * 90);
  private ready = false;

  available() {
    return existsSync(PATHS.llamaServer) && existsSync(join(PATHS.models, EMBED_MODEL_FILE));
  }

  async start(log: (m: string) => void) {
    if (this.ready && this.proc) return;
    const dir = dirname(PATHS.llamaServer);
    const env = isWin ? process.env : { ...process.env, LD_LIBRARY_PATH: [dir, process.env.LD_LIBRARY_PATH].filter(Boolean).join(":") };
    this.proc = spawn(
      PATHS.llamaServer,
      ["-m", join(PATHS.models, EMBED_MODEL_FILE), "--embedding", "--pooling", "mean", "--port", String(this.port), "--host", "127.0.0.1",
        "-ngl", "99", "-c", "8192", "-b", "8192", "-ub", "8192", "--no-webui"],
      { env, stdio: ["ignore", "ignore", "pipe"] },
    );
    createInterface({ input: this.proc.stderr! }).on("line", (l) => {
      if (/error|failed/i.test(l)) log(`llama-server (embed): ${l}`);
    });
    for (let i = 0; i < 120; i++) {
      const ok = await fetch(`http://127.0.0.1:${this.port}/health`).then((r) => r.ok).catch(() => false);
      if (ok) {
        this.ready = true;
        return;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error("llama-server (embed) did not start");
  }

  async run(p: EmbedParams, log: (m: string) => void) {
    await this.start(log);
    const prefix = p.mode === "query" ? "search_query: " : "search_document: ";
    const t0 = performance.now();
    const res = await fetch(`http://127.0.0.1:${this.port}/v1/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: p.texts.map((t) => prefix + t) }),
    });
    if (!res.ok) throw new Error(`llama-server (embed) ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const out = (await res.json()) as { data: { index: number; embedding: number[] }[] };
    const rows = [...out.data].sort((a, b) => a.index - b.index).map((d) => d.embedding);
    if (rows.length !== p.texts.length || rows.some((r) => r.length !== EMBED_DIMS)) throw new Error("unexpected embedding shape");
    const vectors = rows.map((v) => {
      const n = Math.hypot(...v) || 1;
      return v.map((x) => Math.round((x / n) * 1e6) / 1e6);
    });
    return { json: JSON.stringify(vectors), gpuMs: performance.now() - t0 };
  }

  stop() {
    this.proc?.kill();
    this.proc = undefined;
    this.ready = false;
  }
}
