"""Idlex image worker: Stable Diffusion 1.5 on the local GPU.

Reads one JSON request per line on stdin, writes one JSON reply per line on stdout:
  in:  {"id": "...", "prompt": "...", "negative": "...", "width": 512, "height": 512, "steps": 20, "guidance": 7, "seed": 42}
  out: {"id": "...", "png": "<base64>", "gpu_ms": 1234.5}   or   {"id": "...", "error": "..."}

The seed and settings come from the scheduler, so a spot-check on another GPU renders a near-identical
image. Model: stable-diffusion-v1-5 (CreativeML OpenRAIL-M), fp16, with its safety checker on.
"""
import base64
import io
import json
import os
import sys
import time

import torch
from diffusers import StableDiffusionPipeline

MODEL = os.environ.get("IDLEX_SD15_MODEL", "stable-diffusion-v1-5/stable-diffusion-v1-5")


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def main() -> None:
    if not torch.cuda.is_available():
        print(json.dumps({"ready": False, "error": "CUDA GPU not available"}), flush=True)
        return
    log(f"loading {MODEL} on {torch.cuda.get_device_name(0)}")
    pipe = StableDiffusionPipeline.from_pretrained(MODEL, torch_dtype=torch.float16, variant="fp16")
    pipe = pipe.to("cuda")
    pipe.set_progress_bar_config(disable=True)
    torch.backends.cudnn.benchmark = False
    print(json.dumps({"ready": True, "gpu": torch.cuda.get_device_name(0)}), flush=True)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        req = json.loads(line)
        try:
            gen = torch.Generator(device="cuda").manual_seed(int(req["seed"]))
            torch.cuda.synchronize()
            t0 = time.perf_counter()
            out = pipe(
                prompt=req["prompt"],
                negative_prompt=req.get("negative") or None,
                width=int(req["width"]),
                height=int(req["height"]),
                num_inference_steps=int(req["steps"]),
                guidance_scale=float(req.get("guidance", 7)),
                generator=gen,
            )
            torch.cuda.synchronize()
            gpu_ms = (time.perf_counter() - t0) * 1000
            buf = io.BytesIO()
            out.images[0].save(buf, format="PNG")
            nsfw = bool(out.nsfw_content_detected and out.nsfw_content_detected[0])
            print(json.dumps({"id": req["id"], "png": base64.b64encode(buf.getvalue()).decode(), "gpu_ms": gpu_ms, "nsfw": nsfw}), flush=True)
        except Exception as e:  # noqa: BLE001 - report every failure to the client
            print(json.dumps({"id": req.get("id"), "error": str(e)[:500]}), flush=True)


if __name__ == "__main__":
    main()
