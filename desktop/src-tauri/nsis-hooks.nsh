; NSIS install hooks for Circuit Node.
;
; The app runs a background sidecar (circuit-node.exe) and stays in the system tray, so during an
; in-place update its files stay locked ("Error opening file for writing … circuit-node.exe"). Kill
; the running app + sidecar before install/uninstall touches those files, so it doesn't stall.

!macro NSIS_HOOK_PREINSTALL
  DetailPrint "Closing any running Circuit Node…"
  nsExec::Exec 'taskkill /F /T /IM circuit-node.exe'
  nsExec::Exec 'taskkill /F /IM "Circuit Node.exe"'
  Sleep 800
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  DetailPrint "Closing any running Circuit Node…"
  nsExec::Exec 'taskkill /F /T /IM circuit-node.exe'
  nsExec::Exec 'taskkill /F /IM "Circuit Node.exe"'
  Sleep 800
!macroend
