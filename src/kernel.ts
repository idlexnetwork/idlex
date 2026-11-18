// The GPU job: a Julia-set tile in Q24 fixed point. Integer-only so the output is bit-exact on
// every GPU (NVIDIA, AMD, Intel, Apple) and an honest spot-check always matches.
import type { JuliaParams } from "./protocol.ts";

const Q = 1 << 24;

/** Integer kernel inputs, derived the same way on every node (plain JS doubles are deterministic). */
export function toKernel(p: JuliaParams) {
  const step = Math.max(1, Math.round((p.span / p.width) * Q));
  return {
    width: p.width,
    height: p.height,
    maxIter: p.maxIter,
    cRe: Math.round(p.cRe * Q),
    cIm: Math.round(p.cIm * Q),
    centerRe: Math.round(p.centerRe * Q),
    centerIm: Math.round(p.centerIm * Q),
    step,
  };
}
export type KernelInput = ReturnType<typeof toKernel>;

/**
 * WGSL compute shader. One invocation per pixel, writes packed RGBA8 into `out`.
 * mulq() multiplies two Q24 numbers through a 64-bit product built from 16-bit limbs.
 */
export const WGSL = /* wgsl */ `
struct Params {
  width: u32, height: u32, maxIter: u32, step: i32,
  cRe: i32, cIm: i32, centerRe: i32, centerIm: i32,
};
@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read_write> out: array<u32>;

fn mulq(a: i32, b: i32) -> i32 {
  let neg = (a < 0) != (b < 0);
  let ua = u32(abs(a));
  let ub = u32(abs(b));
  let a0 = ua & 0xffffu; let a1 = ua >> 16u;
  let b0 = ub & 0xffffu; let b1 = ub >> 16u;
  let p00 = a0 * b0; let p01 = a0 * b1; let p10 = a1 * b0; let p11 = a1 * b1;
  let mid = p01 + p10;
  let midCarry = select(0u, 1u, mid < p01);
  let lo = p00 + (mid << 16u);
  let loCarry = select(0u, 1u, lo < p00);
  let hi = p11 + (mid >> 16u) + (midCarry << 16u) + loCarry;
  let r = i32((hi << 8u) | (lo >> 24u));
  return select(r, -r, neg);
}

// Brand gradient: ink -> sky -> lime -> pink -> ink, 64 steps per leg.
fn palette(n: u32, maxIter: u32) -> u32 {
  if (n >= maxIter) { return 0xff090a08u; } // ink, ABGR in memory = RGBA bytes 08 0A 09 FF
  let stops = array<vec3<u32>, 5>(
    vec3<u32>(8u, 10u, 9u), vec3<u32>(169u, 216u, 255u), vec3<u32>(200u, 242u, 90u),
    vec3<u32>(255u, 188u, 217u), vec3<u32>(8u, 10u, 9u));
  let t = (n * 5u) % 256u;
  let leg = t / 64u;
  let f = t % 64u;
  let a = stops[leg];
  let b = stops[leg + 1u];
  let c = (a * (64u - f) + b * f) / 64u;
  return 0xff000000u | (c.z << 16u) | (c.y << 8u) | c.x;
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= P.width || id.y >= P.height) { return; }
  var x = P.centerRe + (i32(id.x) - i32(P.width / 2u)) * P.step;
  var y = P.centerIm - (i32(id.y) - i32(P.height / 2u)) * P.step;
  var n = 0u;
  loop {
    if (n >= P.maxIter) { break; }
    let x2 = mulq(x, x);
    let y2 = mulq(y, y);
    if (u32(x2) + u32(y2) > (4u << 24u)) { break; }
    let xy = mulq(x, y);
    x = x2 - y2 + P.cRe;
    y = 2 * xy + P.cIm;
    n = n + 1u;
  }
  out[id.y * P.width + id.x] = palette(n, P.maxIter);
}
`;

/**
 * CPU reference of the same kernel, integer for integer (i32/u32 wrap-around as in WGSL).
 * Slow; used by the self-test to prove the GPU output is the true answer, not just a shared one.
 */
export function cpuKernel(k: KernelInput): Uint8Array {
  const mulq = (a: number, b: number) => {
    const neg = a < 0 !== b < 0;
    const p = (BigInt(Math.abs(a)) * BigInt(Math.abs(b))) >> 24n;
    const r = Number(BigInt.asIntN(32, p));
    return neg ? -r | 0 : r;
  };
  const stops = [[8, 10, 9], [169, 216, 255], [200, 242, 90], [255, 188, 217], [8, 10, 9]];
  const out = new Uint8Array(k.width * k.height * 4);
  for (let py = 0; py < k.height; py++) {
    for (let px = 0; px < k.width; px++) {
      let x = (k.centerRe + Math.imul(px - Math.floor(k.width / 2), k.step)) | 0;
      let y = (k.centerIm - Math.imul(py - Math.floor(k.height / 2), k.step)) | 0;
      let n = 0;
      while (n < k.maxIter) {
        const x2 = mulq(x, x);
        const y2 = mulq(y, y);
        if (((x2 >>> 0) + (y2 >>> 0)) >>> 0 > 4 * Q) break;
        const xy = mulq(x, y);
        x = (x2 - y2 + k.cRe) | 0;
        y = (Math.imul(2, xy) + k.cIm) | 0;
        n++;
      }
      const o = (py * k.width + px) * 4;
      if (n >= k.maxIter) {
        out.set([8, 10, 9, 255], o);
        continue;
      }
      const t = (n * 5) % 256;
      const leg = Math.floor(t / 64);
      const f = t % 64;
      const [a, b] = [stops[leg], stops[leg + 1]];
      for (let c = 0; c < 3; c++) out[o + c] = Math.floor((a[c] * (64 - f) + b[c] * f) / 64);
      out[o + 3] = 255;
    }
  }
  return out;
}
