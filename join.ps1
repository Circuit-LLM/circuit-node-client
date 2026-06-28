# Circuit GPU node - Windows (WSL2) one-click installer.
#
#   Run in an ELEVATED (Administrator) PowerShell:
#     irm https://circuitllm.xyz/join.ps1 | iex
#
# Sets up WSL2 + Ubuntu (if needed), then runs the Linux node installer inside it. The GPU passes
# through from Windows via the NVIDIA Windows driver - no driver or dual-boot needed inside WSL.
#
# Optional, set before running to skip prompts / use the relay:
#   $env:CIRCUIT_PAYOUT_WALLET = "<your-solana-address>"
#   $env:CIRCUIT_RELAY_URL     = "relay.circuitllm.xyz:18942"   # if behind a home router (NAT)

$ErrorActionPreference = "Stop"

function Info($m){ Write-Host "  $m" -ForegroundColor Cyan }
function Warn($m){ Write-Host "  ! $m" -ForegroundColor Yellow }
function Ok($m){ Write-Host "  + $m" -ForegroundColor Green }

Write-Host ""
Write-Host "  Circuit GPU node - Windows (WSL2) setup" -ForegroundColor Magenta
Write-Host ""

# must be elevated (wsl --install needs admin)
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
         ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) {
  Warn "Please re-run this in an ELEVATED PowerShell (Run as Administrator)."
  return
}

# 1. WSL2 + a default Linux distro
$hasWsl = Get-Command wsl -ErrorAction SilentlyContinue
$distros = if ($hasWsl) { (wsl -l -q) -join "" } else { "" }
if (-not $hasWsl -or [string]::IsNullOrWhiteSpace($distros)) {
  Info "Installing WSL2 + Ubuntu..."
  wsl --install -d Ubuntu
  Warn "WSL/Ubuntu was just installed. REBOOT if prompted, finish Ubuntu's first-run (set a username),"
  Warn "then re-run:  irm https://circuitllm.xyz/join.ps1 | iex"
  return
}
Ok "WSL2 present"

# 2. GPU driver reminder (the WINDOWS driver provides CUDA to WSL)
Info "Make sure the NVIDIA *Windows* driver is installed (Game-Ready/Studio). Do NOT install a"
Info "driver inside WSL. Verify with:  wsl nvidia-smi"

# 3. run the Linux installer inside WSL, passing through wallet/relay if set
# A Windows desktop is ~always behind a home router (NAT), so default to the relay — the coordinator
# reaches this GPU through it without any port-forwarding. Override with $env:CIRCUIT_RELAY_URL.
if (-not $env:CIRCUIT_RELAY_URL) { $env:CIRCUIT_RELAY_URL = "relay.circuitllm.xyz:18942" }
$prefix = ""
if ($env:CIRCUIT_PAYOUT_WALLET) { $prefix += "CIRCUIT_PAYOUT_WALLET='$($env:CIRCUIT_PAYOUT_WALLET)' " }
if ($env:CIRCUIT_RELAY_URL)     { $prefix += "CIRCUIT_RELAY_URL='$($env:CIRCUIT_RELAY_URL)' " }
Info "Running the node installer inside WSL..."
# EXPORT the vars so the piped `| bash` (the installer) inherits them. `VAR=val curl … | bash` would
# only set them for curl, not for the bash running the script — which is why the relay wasn't picked up.
$cmd = "curl -fsSL https://circuitllm.xyz/join | bash"
if ($prefix.Trim()) { $cmd = "export $prefix; $cmd" }
wsl -e bash -lc $cmd

Write-Host ""
if ($LASTEXITCODE -ne 0) {
  Warn "The Linux installer exited with an error (code $LASTEXITCODE) — scroll up for the cause."
  Warn "If it was a 'tls: error decoding message' on the image pull, it's a network MTU/VPN issue;"
  Warn "the installer already retried down to MTU 1200. Try off-VPN, or re-run:  irm https://circuitllm.xyz/join.ps1 | iex"
  return
}
Ok "Done. Manage the node from inside WSL:  wsl docker logs -f circuit-gpu-node"
