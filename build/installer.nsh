; Adds PST Explorer to "Open with" for .pst and .ost without taking the default
; association away from Outlook (per-user install: HKCU).
!macro customInstall
  WriteRegStr HKCU "Software\Classes\PSTExplorer.DataFile" "" "Outlook data file"
  WriteRegStr HKCU "Software\Classes\PSTExplorer.DataFile\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr HKCU "Software\Classes\PSTExplorer.DataFile\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
  WriteRegStr HKCU "Software\Classes\.pst\OpenWithProgids" "PSTExplorer.DataFile" ""
  WriteRegStr HKCU "Software\Classes\.ost\OpenWithProgids" "PSTExplorer.DataFile" ""
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

!macro customUnInstall
  DeleteRegKey HKCU "Software\Classes\PSTExplorer.DataFile"
  DeleteRegValue HKCU "Software\Classes\.pst\OpenWithProgids" "PSTExplorer.DataFile"
  DeleteRegValue HKCU "Software\Classes\.ost\OpenWithProgids" "PSTExplorer.DataFile"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend
