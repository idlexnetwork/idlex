// Shared protocol for Idlex: network constants, job and receipt types, signing helpers. The scheduler and the node client both import this file.
import { createHash } from "node:crypto";
import { encodeAbiParameters, keccak256, recoverMessageAddress, verifyTypedData, type Address, type Hex } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";

// ---- Network constants -------------------------------------------------------------------
/** 6-hour epochs. The prototype lets you shorten it (EPOCH_SECONDS) for demos. */
export const EPOCH_SECONDS_DEFAULT = 6 * 60 * 60;
/** USDG has 6 decimals; credits are 1:1 with USDG units. */
export const USDG = 1_000_000n;
/** $IDLEX has 18 decimals. */
export const IDLEX = 10n ** 18n;
/** A node must hold at least 100 USD of $IDLEX. */
export const MIN_STAKE_USDG = 100n * USDG;
/** Basis points. */
export const BPS = 10_000n;
/** Largest price one job can have: 1,000 USDG. */
export const MAX_JOB_CREDITS = 1_000n * USDG;

/**
 * The reward a verified job draws, between `min` and `max` (wei, in whole-token steps). It is derived
 * from the epoch's sealed receipt root and the job id, so anyone can recompute every draw from public data.
 */
export function drawReward(root: Hex, jobId: Hex, min: bigint, max: bigint): bigint {
  const lo = min / IDLEX;
  const hi = max / IDLEX;
  const h = BigInt(keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }], [root, jobId])));
  return (lo + (h % (hi - lo + 1n))) * IDLEX;
}

/** Robinhood Chain */
export const CHAIN_ID = 4663;

// ---- Jobs ---------------------------------------------------------------------------------
/**
 * The prototype's one job type: render a Julia-set image tile on the GPU. The kernel uses only
 * integer (fixed-point Q24) math, so every honest GPU, of any vendor, returns the exact same
 * pixels and a spot-check can compare hashes. Real AI jobs are not bit-exact; see README.
 */
export type JuliaParams = {
  width: number; // 16..2048
  height: number; // 16..2048
  maxIter: number; // 16..20000
  cRe: number; // Julia constant, real part (-2..2)
  cIm: number; // Julia constant, imaginary part (-2..2)
  centerRe: number;
  centerIm: number;
  span: number; // width of the view in the complex plane (1e-5..4)
};

export const LIMITS = { minSide: 16, maxSide: 2048, minIter: 16, maxIter: 20_000 };

export function validateParams(p: unknown): JuliaParams {
  const o = p as Record<string, unknown>;
  const num = (k: string, lo: number, hi: number, int = false) => {
    const v = o?.[k];
    if (typeof v !== "number" || !Number.isFinite(v) || v < lo || v > hi || (int && !Number.isInteger(v))) {
      throw new Error(`param ${k} must be a ${int ? "whole " : ""}number in ${lo}..${hi}`);
    }
    return v;
  };
  return {
    width: num("width", LIMITS.minSide, LIMITS.maxSide, true),
    height: num("height", LIMITS.minSide, LIMITS.maxSide, true),
    maxIter: num("maxIter", LIMITS.minIter, LIMITS.maxIter, true),
    cRe: num("cRe", -2, 2),
    cIm: num("cIm", -2, 2),
    centerRe: num("centerRe", -2, 2),
    centerIm: num("centerIm", -2, 2),
    span: num("span", 1e-5, 4),
  };
}

/**
 * Price in credits (USDG units): 0.02 USDG per billion pixel-iterations, at least 0.001 USDG.
 * A 1024x1024 tile at 2,000 iterations costs about 0.042 USDG.
 */
export function priceCredits(p: JuliaParams): bigint {
  const work = BigInt(p.width) * BigInt(p.height) * BigInt(p.maxIter);
  const credits = (work * 2n * USDG) / 100n / 1_000_000_000n;
  return credits < 1_000n ? 1_000n : credits;
}

// ---- AI jobs (v2) -------------------------------------------------------------------------
/**
 * Real AI jobs. Outputs are not bit-exact across GPUs, so the scheduler compares results with a
 * tolerance (see verify.ts): a perceptual hash for images, normalized text for LLM output.
 */
export type ImageModel = "sd15";
export type TextModel = "qwen2.5-3b" | "qwen2.5-7b";
export type ImageParams = {
  model: ImageModel;
  prompt: string; // 1..1000 chars
  negative: string; // 0..500 chars
  width: number; // 256..768, step 64
  height: number; // 256..768, step 64
  steps: number; // 4..30
  guidance: number; // 1..12
  seed: number; // uint32, fixed so a spot-check can repeat it
};
export type TextParams = {
  model: TextModel;
  prompt: string; // 1..8000 chars
  system: string; // 0..2000 chars
  maxTokens: number; // 16..1024; decoding is greedy (temperature 0) so a spot-check can repeat it
};
export type JobSpec =
  | { kind: "julia"; params: JuliaParams }
  | { kind: "image"; params: ImageParams }
  | { kind: "text"; params: TextParams };
export type JobKind = JobSpec["kind"];

/** VRAM a node needs for each model (MB), and its capability tag. */
export const MODELS = {
  sd15: { kind: "image", vramMb: 4_000, tag: "image:sd15" },
  "qwen2.5-3b": { kind: "text", vramMb: 3_500, tag: "text:qwen2.5-3b" },
  "qwen2.5-7b": { kind: "text", vramMb: 6_500, tag: "text:qwen2.5-7b" },
} as const;

export function validateSpec(s: unknown): JobSpec {
  const o = s as Record<string, unknown>;
  const p = (o?.params ?? {}) as Record<string, unknown>;
  const str = (k: string, lo: number, hi: number) => {
    const v = p[k] ?? "";
    if (typeof v !== "string" || v.length < lo || v.length > hi) throw new Error(`param ${k} must be text of ${lo}..${hi} chars`);
    return v;
  };
  const int = (k: string, lo: number, hi: number, step = 1) => {
    const v = p[k];
    if (typeof v !== "number" || !Number.isInteger(v) || v < lo || v > hi || v % step !== 0) {
      throw new Error(`param ${k} must be a whole number in ${lo}..${hi}${step > 1 ? ` in steps of ${step}` : ""}`);
    }
    return v;
  };
  if (o?.kind === "julia") return { kind: "julia", params: validateParams(p) };
  if (o?.kind === "image") {
    if (p.model !== "sd15") throw new Error("image model must be sd15");
    const guidance = typeof p.guidance === "number" ? p.guidance : 7;
    if (!(guidance >= 1 && guidance <= 12)) throw new Error("param guidance must be in 1..12");
    return {
      kind: "image",
      params: {
        model: "sd15", prompt: str("prompt", 1, 1000), negative: str("negative", 0, 500),
        width: int("width", 256, 768, 64), height: int("height", 256, 768, 64), steps: int("steps", 4, 30),
        guidance, seed: int("seed", 0, 0xffff_ffff),
      },
    };
  }
  if (o?.kind === "text") {
    if (p.model !== "qwen2.5-3b" && p.model !== "qwen2.5-7b") throw new Error("text model must be qwen2.5-3b or qwen2.5-7b");
    return {
      kind: "text",
      params: { model: p.model, prompt: str("prompt", 1, 8000), system: str("system", 0, 2000), maxTokens: int("maxTokens", 16, 1024) },
    };
  }
  throw new Error("kind must be julia, image or text");
}

/** Model and VRAM a job needs. */
export function needs(s: JobSpec): { model: string; tag: string; vramMb: number } {
  if (s.kind === "julia") return { model: "julia", tag: "julia", vramMb: 0 };
  const m = MODELS[s.params.model];
  return { model: s.params.model, tag: m.tag, vramMb: m.vramMb };
}

/**
 * Estimated GPU time in ms on a mid-range card (RTX 3060 / 4060 class). The scheduler computes it
 * itself and uses it as the job's reward weight, so a node can't inflate its share by reporting a
 * longer gpuMs.
 */
export function workOf(s: JobSpec): bigint {
  if (s.kind === "julia") return (BigInt(s.params.width) * BigInt(s.params.height) * BigInt(s.params.maxIter)) / 100_000n + 1n;
  if (s.kind === "image") return BigInt(Math.round((s.params.width * s.params.height * s.params.steps) / (512 * 512) * 160));
  return BigInt(s.params.maxTokens * (s.params.model === "qwen2.5-7b" ? 32 : 16) + Math.ceil(s.params.prompt.length / 4));
}

/**
 * Listed prices in credits (USDG units).
 * - julia: 0.02 USDG per billion pixel-iterations, at least 0.001
 * - image: 0.004 USDG for 512x512 at 20 steps, scaled by pixels x steps, at least 0.001
 * - text: 0.002 USDG per 1,000 tokens (prompt / 4 chars + maxTokens), x2 for the 7B model, at least 0.0005
 */
export function priceSpec(s: JobSpec): bigint {
  if (s.kind === "julia") return priceCredits(s.params);
  if (s.kind === "image") {
    const c = BigInt(Math.round((4_000 * s.params.width * s.params.height * s.params.steps) / (512 * 512 * 20)));
    return c < 1_000n ? 1_000n : c;
  }
  const tokens = Math.ceil(s.params.prompt.length / 4) + Math.ceil(s.params.system.length / 4) + s.params.maxTokens;
  const c = BigInt(Math.round(tokens * 2 * (s.params.model === "qwen2.5-7b" ? 2 : 1)));
  return c < 500n ? 500n : c;
}

/** Job id for any spec: keccak of the builder, a nonce and the canonical spec. */
export function jobIdOfSpec(builder: Address, nonce: string, s: JobSpec): Hex {
  if (s.kind === "julia") return jobIdOf(builder, nonce, s.params);
  return keccak256(new TextEncoder().encode(`${builder.toLowerCase()}|${nonce}|${JSON.stringify(s)}`));
}

/** Job id: keccak of the builder, a nonce and the canonical params. */
export function jobIdOf(builder: Address, nonce: string, p: JuliaParams): Hex {
  return keccak256(new TextEncoder().encode(`${builder.toLowerCase()}|${nonce}|${JSON.stringify(p)}`));
}

export const sha256Hex = (data: Uint8Array | string): Hex => `0x${createHash("sha256").update(data).digest("hex")}`;

// ---- Receipts (EIP-712) -------------------------------------------------------------------
/** A node's signed statement: "I ran job X in epoch E and got output hash H in G ms". */
export type Receipt = { jobId: Hex; node: Address; outputHash: Hex; gpuMs: bigint; epoch: bigint };

export const RECEIPT_DOMAIN = {
  name: "Idlex",
  version: "1",
  chainId: CHAIN_ID,
  verifyingContract: "0x0000000000000000000000000000000000000000",
} as const;

export const RECEIPT_TYPES = {
  Receipt: [
    { name: "jobId", type: "bytes32" },
    { name: "node", type: "address" },
    { name: "outputHash", type: "bytes32" },
    { name: "gpuMs", type: "uint64" },
    { name: "epoch", type: "uint64" },
  ],
} as const;

export const signReceipt = (account: PrivateKeyAccount, r: Receipt) =>
  account.signTypedData({ domain: RECEIPT_DOMAIN, types: RECEIPT_TYPES, primaryType: "Receipt", message: r });

export const verifyReceipt = (r: Receipt, signature: Hex) =>
  verifyTypedData({ address: r.node, domain: RECEIPT_DOMAIN, types: RECEIPT_TYPES, primaryType: "Receipt", message: r, signature });

/** Receipt leaf: keccak256(keccak256(abi.encode(jobId, node, outputHash, gpuMs, epoch))). */
export function receiptLeaf(r: Receipt): Hex {
  const inner = keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "address" }, { type: "bytes32" }, { type: "uint64" }, { type: "uint64" }],
      [r.jobId, r.node, r.outputHash, r.gpuMs, r.epoch],
    ),
  );
  return keccak256(inner);
}

// ---- Request signing (node -> scheduler) --------------------------------------------------
/**
 * Every signed request (node or builder) carries `x-idlex-from`, `x-idlex-ts` and `x-idlex-sig`: an EIP-191
 * signature over "idlex|METHOD|PATH|TS|sha256(body)". The scheduler accepts a 60 s window.
 */
export const requestMessage = (method: string, path: string, ts: string, body: string) =>
  `idlex|${method.toUpperCase()}|${path}|${ts}|${sha256Hex(body)}`;

export async function signedHeaders(account: PrivateKeyAccount, method: string, path: string, body: string) {
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = await account.signMessage({ message: requestMessage(method, path, ts, body) });
  return { "content-type": "application/json", "x-idlex-from": account.address, "x-idlex-ts": ts, "x-idlex-sig": sig };
}

export async function verifyRequest(headers: Record<string, string | string[] | undefined>, method: string, path: string, body: string) {
  const node = String(headers["x-idlex-from"] ?? "") as Address;
  const ts = String(headers["x-idlex-ts"] ?? "");
  const sig = String(headers["x-idlex-sig"] ?? "") as Hex;
  if (!/^0x[0-9a-fA-F]{40}$/.test(node) || !/^\d+$/.test(ts) || !/^0x[0-9a-fA-F]+$/.test(sig)) throw new Error("missing signature headers");
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 60) throw new Error("stale request");
  const signer = await recoverMessageAddress({ message: requestMessage(method, path, ts, body), signature: sig });
  if (signer.toLowerCase() !== node.toLowerCase()) throw new Error("bad signature");
  return signer;
}

/**
 * The owner's wallet signs this once (EIP-191, no gas) to link a node key to it. The stake and the
 * rewards belong to the owner wallet; the node key only signs requests and receipts,
 * so the node client never holds the owner's private key.
 */
export const linkMessage = (node: string, owner: string) =>
  `Idlex: link node ${node.toLowerCase()} to wallet ${owner.toLowerCase()}`;

/** JSON with bigint support (bigints become strings). */
export const toJson = (v: unknown, space?: number) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x), space);

export const fmtUnits = (v: bigint, decimals: number, digits = 4) => {
  const neg = v < 0n;
  const a = neg ? -v : v;
  const base = 10n ** BigInt(decimals);
  const whole = a / base;
  const frac = (a % base).toString().padStart(decimals, "0").slice(0, digits);
  return `${neg ? "-" : ""}${whole.toLocaleString("en-US")}${digits ? "." + frac : ""}`;
};
