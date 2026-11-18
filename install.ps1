# Idlex node installer (Windows + NVIDIA GPU).
#
#   powershell -ExecutionPolicy Bypass -File install.ps1
#
# Installs everything next to this file: npm packages, a Python venv with PyTorch + diffusers (image jobs),
# llama.cpp's CUDA build (text jobs) and the Qwen2.5-3B model. Downloads are pinned and checked by SHA-256.
# Needs: Node.js 22.18+ and Python 3.10-3.12 on PATH, a recent NVIDIA driver, ~12 GB free disk.
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
Set-Location $PSScriptRoot

function Step($t) { Write-Host "`n== $t" -ForegroundColor Cyan }
function Need($ok, $msg) { if (-not $ok) { Write-Host $msg -ForegroundColor Red; exit 1 } }
function Fetch($url, $out, $sha) {
  if ((Test-Path $out) -and ((Get-Item $out).Length -gt 0) -and (-not $sha -or (Get-FileHash $out -Algorithm SHA256).Hash -eq $sha)) { Write-Host "  have $out"; return }
  Write-Host "  downloading $url"
  Invoke-WebRequest -Uri $url -OutFile $out -UseBasicParsing
  $got = (Get-FileHash $out -Algorithm SHA256).Hash
  if ($sha -and $got -ne $sha) { Remove-Item $out; throw "Checksum mismatch for $out" }
}

Step "Checking requirements"
$node = (Get-Command node -ErrorAction SilentlyContinue)
Need $node "Node.js not found. Install Node.js 22 LTS (22.18 or newer) from https://nodejs.org"
$v = [version]((node -v).TrimStart("v"))
Need ($v -ge [version]"22.18.0") "Node.js $v is too old, need 22.18 or newer."
Need (Get-Command nvidia-smi -ErrorAction SilentlyContinue) "nvidia-smi not found. An NVIDIA GPU with a current driver is required."
nvidia-smi --query-gpu=name,memory.total --format=csv,noheader
# A real Python 3.10-3.13 (the "python" in WindowsApps is only a Microsoft Store shortcut).
function Find-Python {
  $ErrorActionPreference = "Continue"
  $c = @()
  $c += Get-Command python -All -ErrorAction SilentlyContinue | Where-Object { $_.Source -notmatch "WindowsApps" } | ForEach-Object { $_.Source }
  $c += Get-ChildItem "$env:LOCALAPPDATA\Programs\Python\Python3*\python.exe", "$env:ProgramFiles\Python3*\python.exe" -ErrorAction SilentlyContinue | Sort-Object FullName -Descending | ForEach-Object { $_.FullName }
  foreach ($p in $c) {
    $v = & $p -c "import sys; print('%d.%d' % sys.version_info[:2])" 2>$null
    if ($v -and [version]$v -ge [version]"3.10" -and [version]$v -le [version]"3.13") { return $p }
  }
  $launcher = Get-Command py -ErrorAction SilentlyContinue
  if ($launcher) { foreach ($ver in "3.12", "3.13", "3.11", "3.10") { $p = & py "-$ver" -c "import sys; print(sys.executable)" 2>$null; if ($p) { return $p.Trim() } } }
  return $null
}
$py = Find-Python
Need $py "Python 3.10-3.13 not found. Install Python 3.12 from https://www.python.org (tick 'Add python.exe to PATH'), then run install.ps1 again."
Write-Host "  Python: $py"

Step "npm packages"
npm ci --omit=dev --no-audit --no-fund
Need ($LASTEXITCODE -eq 0) "npm install failed."

Step "Python venv for image jobs (PyTorch CUDA, diffusers)"
$vpy = Join-Path $PSScriptRoot ".venv\Scripts\python.exe"
if (-not (Test-Path $vpy)) { & $py -m venv .venv; Need ($LASTEXITCODE -eq 0) "Could not create the Python venv." }
& $vpy -m pip install --upgrade pip -q
& $vpy -m pip install "torch==2.8.0" --index-url https://download.pytorch.org/whl/cu128 --resume-retries 20 -q
Need ($LASTEXITCODE -eq 0) "PyTorch install failed (check your internet connection and run install.ps1 again)."
& $vpy -m pip install "diffusers==0.35.1" "transformers==4.56.1" "accelerate==1.10.1" safetensors pillow --resume-retries 20 -q
Need ($LASTEXITCODE -eq 0) "pip install failed (run install.ps1 again)."
& $vpy -c "import torch; print('  CUDA available:', torch.cuda.is_available())"

Step "llama.cpp (CUDA) for text jobs"
New-Item -ItemType Directory -Force bin\llama | Out-Null
$rel = "https://github.com/ggml-org/llama.cpp/releases/download/b12404"
Fetch "$rel/llama-b12404-bin-win-cuda-12.4-x64.zip" "bin\llama\llama.zip" "0C70A8DC0BE7F836C82827DD4F279A5416D9CA59BBC6BA29EBD90CFF40D86BAD"
Fetch "$rel/cudart-llama-bin-win-cuda-12.4-x64.zip" "bin\llama\cudart.zip" "8C79A9B226DE4B3CACFD1F83D24F962D0773BE79F1E7B75C6AF4DED7E32AE1D6"
Expand-Archive bin\llama\llama.zip bin\llama -Force
Expand-Archive bin\llama\cudart.zip bin\llama -Force

Step "Text model (Qwen2.5-3B Instruct, 2 GB)"
New-Item -ItemType Directory -Force models | Out-Null
Fetch "https://huggingface.co/Qwen/Qwen2.5-3B-Instruct-GGUF/resolve/main/qwen2.5-3b-instruct-q4_k_m.gguf" "models\qwen2.5-3b-instruct-q4_k_m.gguf" ""
# The image model (Stable Diffusion 1.5) downloads into models\hf on the first image job.

Step "Node key"
node src/agent.ts init

Write-Host @"

Installed. Next:
  1. Copy the Node key above, open https://www.idlex.network/run-a-node#install (step 3),
     paste it and sign with the wallet that holds your `$IDLEX (one signature, no gas).
  2. The page then shows your start command. Paste it here, in this folder.
"@ -ForegroundColor Green
