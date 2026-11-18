// Runs one job on every GPU WebGPU can reach here (discrete and integrated), then compares the
// output hashes. Equal hashes across vendors prove the kernel is bit-exact. Usage: npm run gpu-check
import { mkdirSync, writeFileSync } from "node:fs";
import { GpuRunner } from "./gpu-runner.ts";
import { toKernel } from "./kernel.ts";
import { encodePng } from "./png.ts";
import { sha256Hex, type JuliaParams } from "./protocol.ts";

const job: JuliaParams = { width: 1024, height: 768, maxIter: 1500, cRe: -0.8, cIm: 0.156, centerRe: 0, centerIm: 0, span: 3.2 };
mkdirSync("out", { recursive: true });
const seen: string[] = [];
for (const gpu of ["high", "low"] as const) {
  const r = new GpuRunner(gpu);
  const info = await r.start();
  const warm = await r.run(toKernel(job));
  const { rgba, gpuMs } = await r.run(toKernel(job));
  const hash = sha256Hex(rgba);
  seen.push(hash);
  writeFileSync(`out/gpu-check-${gpu}.png`, encodePng(job.width, job.height, rgba));
  console.log(`${gpu.padEnd(4)} ${info.vendor}/${info.architecture}  ${gpuMs.toFixed(1)} ms (first run ${warm.gpuMs.toFixed(1)} ms)  ${hash}`);
  await r.stop();
}
console.log(seen.every((h) => h === seen[0]) ? "MATCH: outputs are bit-identical" : "MISMATCH");
