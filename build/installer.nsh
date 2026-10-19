; Agrega PST Explorer a «Abrir con» para .pst y .ost sin quitarle la asociación
; predeterminada a Outlook (instalación por usuario: HKCU).
!macro customInstall
  WriteRegStr HKCU "Software\Classes\PSTExplorer.DataFile" "" "Archivo de datos de Outlook"
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
