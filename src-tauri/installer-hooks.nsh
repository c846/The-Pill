; Starts The Pill when the user signs in to Windows.
; The installer closes every copy of the pill first, including the watchdog that would bring back the
; taskbar and switch Do Not Disturb off again, so the hooks do that themselves.
!macro NSIS_HOOK_POSTINSTALL
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "The Pill" '"$INSTDIR\${MAINBINARYNAME}.exe"'
  ExecWait '"$INSTDIR\${MAINBINARYNAME}.exe" --restore'
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "The Pill"
  ExecWait '"$INSTDIR\${MAINBINARYNAME}.exe" --restore'
!macroend
