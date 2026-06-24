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
#   $env:CIRCUIT_RELAY_URL     = "relay.circuitllm.xyz:18940"   # if behind a home router (NAT)

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
$prefix = ""
if ($env:CIRCUIT_PAYOUT_WALLET) { $prefix += "CIRCUIT_PAYOUT_WALLET='$($env:CIRCUIT_PAYOUT_WALLET)' " }
if ($env:CIRCUIT_RELAY_URL)     { $prefix += "CIRCUIT_RELAY_URL='$($env:CIRCUIT_RELAY_URL)' " }
Info "Running the node installer inside WSL..."
wsl -e bash -lc "$prefix curl -fsSL https://circuitllm.xyz/join | bash"

Write-Host ""
Ok "Done. Manage the node from inside WSL:  wsl docker logs -f circuit-gpu-node"
