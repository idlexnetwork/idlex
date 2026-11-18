// Runs jobs on the local GPU through WebGPU in a headless Chrome. No CUDA or Python needed:
// any GPU with a WebGPU driver works. `gpu: "high"` asks Windows/macOS for the discrete GPU.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync } from "node:fs";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { WGSL, type KernelInput } from "./kernel.ts";

export type GpuInfo = { vendor: string; architecture: string; description: string };
export type RunResult = { rgba: Uint8Array; gpuMs: number };

const CHROME_PATHS = [
  process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].filter(Boolean) as string[];

export class GpuRunner {
  private browser?: Browser;
  private page?: Page;
  private server?: Server;
  private gpu: "high" | "low";
  info?: GpuInfo;

  constructor(gpu: "high" | "low" = "high") {
    this.gpu = gpu;
  }

  async start() {
    const chrome = CHROME_PATHS.find((p) => existsSync(p));
    if (!chrome) throw new Error("Chrome not found. Set CHROME_PATH to a Chrome or Chromium binary.");
    // WebGPU needs a secure context: serve an empty page from localhost.
    this.server = createServer((_q, r) => r.end("<!doctype html><title>idlex-node</title>"));
    await new Promise<void>((ok) => this.server!.listen(0, "127.0.0.1", ok));
    const port = (this.server.address() as AddressInfo).port;
    const args = ["--enable-unsafe-webgpu"];
    if (this.gpu === "high") args.push("--force_high_performance_gpu");
    this.browser = await puppeteer.launch({ executablePath: chrome, headless: true, args });
    this.page = await this.browser.newPage();
    await this.page.goto(`http://127.0.0.1:${port}/`);
    this.info = await this.page.evaluate(async (wgsl, gpu) => {
      const nav = navigator as Navigator & { gpu?: any };
      if (!nav.gpu) throw new Error("WebGPU is not available in this Chrome");
      const adapter = await nav.gpu.requestAdapter({ powerPreference: gpu === "high" ? "high-performance" : "low-power" });
      if (!adapter) throw new Error("No WebGPU adapter");
      const device = await adapter.requestDevice();
      const module = device.createShaderModule({ code: wgsl });
      const pipeline = device.createComputePipeline({ layout: "auto", compute: { module, entryPoint: "main" } });
      (window as any).__idlex = { device, pipeline };
      const i = adapter.info ?? {};
      return { vendor: i.vendor ?? "", architecture: i.architecture ?? "", description: i.description ?? "" };
    }, WGSL, this.gpu);
    return this.info;
  }

  /** Renders one job and returns raw RGBA bytes plus the GPU time (submit to done). */
  async run(k: KernelInput): Promise<RunResult> {
    if (!this.page) throw new Error("runner not started");
    const res = await this.page.evaluate(async (k) => {
      const { device, pipeline } = (window as any).__idlex;
      const G = (globalThis as any).GPUBufferUsage;
      const M = (globalThis as any).GPUMapMode;
      const params = new Int32Array([k.width, k.height, k.maxIter, k.step, k.cRe, k.cIm, k.centerRe, k.centerIm]);
      const ubuf = device.createBuffer({ size: params.byteLength, usage: G.UNIFORM | G.COPY_DST });
      device.queue.writeBuffer(ubuf, 0, params);
      const size = k.width * k.height * 4;
      const out = device.createBuffer({ size, usage: G.STORAGE | G.COPY_SRC });
      const read = device.createBuffer({ size, usage: G.MAP_READ | G.COPY_DST });
      const bind = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: ubuf } },
          { binding: 1, resource: { buffer: out } },
        ],
      });
      const t0 = performance.now();
      const enc = device.createCommandEncoder();
      const pass = enc.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bind);
      pass.dispatchWorkgroups(Math.ceil(k.width / 8), Math.ceil(k.height / 8));
      pass.end();
      enc.copyBufferToBuffer(out, 0, read, 0, size);
      device.queue.submit([enc.finish()]);
      await device.queue.onSubmittedWorkDone();
      const gpuMs = performance.now() - t0;
      await read.mapAsync(M.READ);
      const bytes = new Uint8Array(read.getMappedRange().slice(0));
      read.unmap();
      ubuf.destroy();
      out.destroy();
      read.destroy();
      // base64 in chunks (String.fromCharCode has an argument limit)
      let bin = "";
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return { b64: btoa(bin), gpuMs };
    }, k);
    return { rgba: new Uint8Array(Buffer.from(res.b64, "base64")), gpuMs: res.gpuMs };
  }

  async stop() {
    await this.browser?.close();
    await new Promise<void>((ok) => (this.server ? this.server.close(() => ok()) : ok()));
  }
}
