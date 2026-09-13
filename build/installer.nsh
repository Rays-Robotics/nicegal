; Installed builds can self-update. Do not put this marker in extraResources: ZIP and portable
; targets share those resources and must not accidentally run an NSIS upgrade.
!macro customInstall
  FileOpen $0 "$INSTDIR\resources\nicegal-installed" w
  FileWrite $0 "nsis"
  FileClose $0
!macroend
