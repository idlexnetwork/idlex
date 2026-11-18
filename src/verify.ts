// Tolerant result comparison for AI jobs. Two honest GPUs running the same model with the same
// seed (images) or greedy decoding (text) give near-identical outputs, but not bit-identical ones,
// so the scheduler compares fingerprints instead of hashes:
//   image: a 64-bit difference hash (dHash) of the decoded PNG; match when ≤ IMAGE_MAX_BITS differ
//   text:  whitespace-normalized output; match when the edit-distance similarity ≥ TEXT_MIN_SIMILARITY
// Shared by the scheduler (Next.js API) and the node prototype; only depends on pngjs.
import { PNG } from "pngjs";

export const IMAGE_MAX_BITS = 12;
export const TEXT_MIN_SIMILARITY = 0.9;
const TEXT_COMPARE_CHARS = 4_000;

/** Decodes a PNG; null if it is not a PNG of the expected size. */
export function decodeImage(png: Uint8Array, width?: number, height?: number) {
  try {
    const img = PNG.sync.read(Buffer.from(png));
    if ((width && img.width !== width) || (height && img.height !== height)) return null;
    return img; // RGBA8
  } catch {
    return null;
  }
}

/** 64-bit difference hash: shrink to 9x8 grayscale, one bit per left-right brightness step. */
export function imageFingerprint(img: { width: number; height: number; data: Uint8Array | Buffer }): string {
  const W = 9, H = 8;
  const gray = new Float64Array(W * H);
  // Box-average each target cell so the hash is stable against tiny pixel noise.
  for (let ty = 0; ty < H; ty++) {
    const y0 = Math.floor((ty * img.height) / H), y1 = Math.max(y0 + 1, Math.floor(((ty + 1) * img.height) / H));
    for (let tx = 0; tx < W; tx++) {
      const x0 = Math.floor((tx * img.width) / W), x1 = Math.max(x0 + 1, Math.floor(((tx + 1) * img.width) / W));
      let sum = 0, n = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * img.width + x) * 4;
          sum += 0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2];
          n++;
        }
      }
      gray[ty * W + tx] = sum / n;
    }
  }
  let bits = 0n;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W - 1; x++) bits = (bits << 1n) | (gray[y * W + x] < gray[y * W + x + 1] ? 1n : 0n);
  }
  return bits.toString(16).padStart(16, "0");
}

export function hammingHex(a: string, b: string): number {
  let x = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  let n = 0;
  while (x) {
    n += Number(x & 1n);
    x >>= 1n;
  }
  return n;
}

export const textFingerprint = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, TEXT_COMPARE_CHARS);

/** 1 - normalized Levenshtein distance. */
export function textSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  const n = a.length, m = b.length;
  if (!n || !m) return 0;
  let prev = new Uint32Array(m + 1), cur = new Uint32Array(m + 1);
  for (let j = 0; j <= m; j++) prev[j] = j;
  for (let i = 1; i <= n; i++) {
    cur[0] = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= m; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca === b.charCodeAt(j - 1) ? 0 : 1));
    }
    [prev, cur] = [cur, prev];
  }
  return 1 - prev[m] / Math.max(n, m);
}

/** Do two results of the same job agree? */
export function fingerprintsMatch(kind: string, a: string, b: string): boolean {
  if (kind === "image") return hammingHex(a, b) <= IMAGE_MAX_BITS;
  if (kind === "text") return textSimilarity(a, b) >= TEXT_MIN_SIMILARITY;
  return a === b; // julia: exact pixel hash
}
