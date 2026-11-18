#!/usr/bin/env bash
# Idlex node installer (Linux x64 + NVIDIA GPU: Ubuntu 24.04 or newer, or another distro with glibc 2.38+).
#
#   bash install.sh
#
# Installs everything next to this file: npm packages, a Python venv with PyTorch + diffusers (image jobs),
# llama.cpp's CUDA build (text jobs) and the Qwen2.5-3B model. Downloads are pinned and checked by SHA-256.
# Same versions and models as install.ps1 on Windows: nodes re-run each other's jobs, so they must match.
# Needs: Node.js 22.18+ and Python 3.10-3.13 (with venv) on PATH, a recent NVIDIA driver, curl or wget,
# ~20 GB free disk. No sudo: everything goes in this folder, except the node key (~/.idlex-node) and the
# pip / npm download caches in your home folder.
set -euo pipefail
cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"

if [[ -t 1 ]]; then C="\033[36m" R="\033[31m" Y="\033[33m" G="\033[32m" N="\033[0m"; else C="" R="" Y="" G="" N=""; fi
step() { printf "\n${C}== %s${N}\n" "$1"; }
die() { printf "${R}%s${N}\n" "$1" >&2; exit 1; }
warn() { printf "${Y}%s${N}\n" "$1"; }
ver_ge() { [[ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -n1)" == "$2" ]]; }
sha_of() { sha256sum "$1" | cut -d' ' -f1; }
download() { # url out: resumes a partial download
  if command -v curl >/dev/null; then curl -fL --retry 5 --retry-delay 3 -C - -o "$2" "$1"
  else wget -q --show-progress --tries=5 -c -O "$2" "$1"; fi
}
fetch() { # url out [sha256]
  local url=$1 out=$2 sha=${3:-}
  if [[ -s $out ]] && { [[ -z $sha ]] || [[ $(sha_of "$out") == "$sha" ]]; }; then echo "  have $out"; return; fi
  echo "  downloading $url"
  if ! download "$url" "$out.part"; then
    # A finished .part from an interrupted run still counts if its checksum is right.
    [[ -n $sha && -s $out.part && $(sha_of "$out.part") == "$sha" ]] || die "Download failed: $url (run install.sh again to resume)."
  fi
  if [[ -n $sha && $(sha_of "$out.part") != "$sha" ]]; then rm -f "$out.part"; die "Checksum mismatch for $out"; fi
  mv -f "$out.part" "$out"
}

step "Checking requirements"
[[ $(uname -s) == Linux && $(uname -m) == x86_64 ]] || die "This installer is for Linux x64. On Windows use install.ps1."
# llama.cpp's Linux CUDA build is built on Ubuntu 24.04 and needs its glibc (2.38+) and libstdc++.
glibc=$(getconf GNU_LIBC_VERSION 2>/dev/null | awk '{print $2}')
ver_ge "${glibc:-0}" 2.38 || die "glibc ${glibc:-unknown} is too old: llama.cpp's CUDA build needs glibc 2.38+ (Ubuntu 24.04 or newer)."
libs=$(ldconfig -p 2>/dev/null || /sbin/ldconfig -p)
grep -q "libgomp.so.1 " <<<"$libs" || die "libgomp1 (OpenMP) is missing, llama.cpp needs it: sudo apt install libgomp1, then run install.sh again."
grep -q "libssl.so.3 " <<<"$libs" || die "OpenSSL 3 is missing, llama.cpp needs it: sudo apt install libssl3t64, then run install.sh again."
command -v node >/dev/null || die "Node.js not found. Install Node.js 22 LTS (22.18 or newer) from https://nodejs.org (or with nvm: nvm install 22)"
v=$(node -v); v=${v#v}
ver_ge "$v" 22.18.0 || die "Node.js $v is too old, need 22.18 or newer."
command -v npm >/dev/null || die "npm not found. It comes with Node.js from https://nodejs.org"
command -v curl >/dev/null || command -v wget >/dev/null || die "curl or wget is required (sudo apt install curl)."
command -v nvidia-smi >/dev/null || die "nvidia-smi not found. An NVIDIA GPU with a current driver is required (Ubuntu: sudo ubuntu-drivers install, then reboot)."
nvidia-smi --query-gpu=name,memory.total --format=csv,noheader || die "nvidia-smi can't reach the NVIDIA driver. Reboot after a driver or kernel update, then run install.sh again."
drv=$(nvidia-smi --query-gpu=driver_version --format=csv,noheader | awk 'NR == 1 {print $1}')
# PyTorch cu128 and llama.cpp's CUDA 12.8 build: CUDA 12 needs driver 525+, 570+ runs every GPU they support.
ver_ge "$drv" 525.60.13 || die "NVIDIA driver $drv is too old for CUDA 12. Update it (Ubuntu: sudo ubuntu-drivers install), reboot, run install.sh again."
ver_ge "$drv" 570 || warn "  NVIDIA driver $drv: 570 or newer is recommended (CUDA 12.8). If jobs fail, update the driver."
free_gb=$(( $(df -Pk . | awk 'NR==2 {print $4}') / 1024 / 1024 ))
(( free_gb >= 20 )) || warn "  Only ${free_gb} GB free here; the install needs about 20 GB."
# A Python 3.10-3.13 (PyTorch 2.8.0 has no wheels for 3.14).
find_python() {
  local c p v
  for c in python3.12 python3.13 python3.11 python3.10 python3 python; do
    p=$(command -v "$c" 2>/dev/null) || continue
    v=$("$p" -c "import sys; print('%d.%d' % sys.version_info[:2])" 2>/dev/null) || continue
    case $v in 3.10 | 3.11 | 3.12 | 3.13) echo "$p"; return 0 ;; esac
  done
  return 1
}
py=$(find_python) || die "Python 3.10-3.13 not found. Ubuntu 22.04/24.04 ship one (python3). On a newer release: sudo add-apt-repository ppa:deadsnakes/ppa && sudo apt install python3.12 python3.12-venv, then run install.sh again."
pyv=$("$py" -c "import sys; print('%d.%d' % sys.version_info[:2])")
# Debian/Ubuntu split venv's pip bootstrap into a separate package.
"$py" -c "import ensurepip, venv" 2>/dev/null || die "Python $pyv can't create a venv. Ubuntu: sudo apt install python$pyv-venv, then run install.sh again."
echo "  Python: $py ($pyv)"

step "npm packages"
npm ci --omit=dev --no-audit --no-fund || die "npm install failed."

step "Python venv for image jobs (PyTorch CUDA, diffusers)"
vpy="$PWD/.venv/bin/python"
if [[ ! -x $vpy ]] || ! "$vpy" -m pip --version >/dev/null 2>&1; then
  rm -rf .venv
  "$py" -m venv .venv || die "Could not create the Python venv."
fi
"$vpy" -m pip install --upgrade pip -q || die "pip upgrade failed (run install.sh again)."
echo "  PyTorch with CUDA is about 4 GB, this takes a while"
"$vpy" -m pip install "torch==2.8.0" --index-url https://download.pytorch.org/whl/cu128 --resume-retries 20 -q || die "PyTorch install failed (check your internet connection and run install.sh again)."
"$vpy" -m pip install "diffusers==0.35.1" "transformers==4.56.1" "accelerate==1.10.1" safetensors pillow --resume-retries 20 -q || die "pip install failed (run install.sh again)."
"$vpy" -c "import torch; print('  CUDA available:', torch.cuda.is_available())"

step "llama.cpp (CUDA) for text jobs"
mkdir -p bin/llama
# The same release (b12404) and backend (CUDA) as Windows. llama.cpp builds Linux CUDA with toolkit 12.8
# (Windows: 12.4); the cudart archive holds the CUDA runtime and cuBLAS it links against, like on Windows.
rel="https://github.com/ggml-org/llama.cpp/releases/download/b12404"
fetch "$rel/llama-b12404-bin-ubuntu-cuda-12.8-x64.tar.gz" bin/llama/llama.tar.gz 42edd396109b273fa510c69205bb88fa8d912cc118b2b6d2e287c64f4cc8eb7c
fetch "$rel/cudart-llama-b12404-bin-ubuntu-cuda-12.8-x64.tar.gz" bin/llama/cudart.tar.gz 0ebfc4b2e66feaf89729e823e7848b9d73b0b71f6ff63ed6cca893779633c13f
tar -xzf bin/llama/llama.tar.gz -C bin/llama --strip-components=1
tar -xzf bin/llama/cudart.tar.gz -C bin/llama --strip-components=1
llv=$(LD_LIBRARY_PATH="$PWD/bin/llama${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" bin/llama/llama-server --version 2>&1) || true
# Prints e.g. "version: 1.0.0-dev (build 12404, commit cf9a9957d)".
grep -q "build 12404, commit cf9a995" <<<"$llv" || die "llama-server doesn't run on this system:
$llv"
echo "  llama-server $(grep -m1 "^version: " <<<"$llv")"

step "Text model (Qwen2.5-3B Instruct, 2 GB)"
mkdir -p models
fetch "https://huggingface.co/Qwen/Qwen2.5-3B-Instruct-GGUF/resolve/main/qwen2.5-3b-instruct-q4_k_m.gguf" models/qwen2.5-3b-instruct-q4_k_m.gguf 626b4a6678b86442240e33df819e00132d3ba7dddfe1cdc4fbb18e0a9615c62d
# The image model (Stable Diffusion 1.5) downloads into models/hf on the first image job.

step "Node key"
node src/agent.ts init

printf "${G}%s${N}\n" "
Installed. Next:
  1. Copy the Node key above, open https://www.idlex.network/run-a-node#install (step 3),
     paste it and sign with the wallet that holds your \$IDLEX (one signature, no gas).
  2. The page then shows your start command. Paste it in a terminal in this folder:
     $PWD
     Tip: run it inside tmux or screen so the node keeps working after you close the terminal."
