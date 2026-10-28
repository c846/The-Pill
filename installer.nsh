!macro customInstall
  CreateShortCut "$SMSTARTUP\The Pill.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
!macroend

!macro customUnInstall
  Delete "$SMSTARTUP\The Pill.lnk"
!macroend
