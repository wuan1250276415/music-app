; Register user-visible choices only. Extension defaults and UserChoice are untouched.
!include "${PROJECT_DIR}\scripts\media-formats.nsh"
!macro customInstall
  WriteRegStr HKCU "Software\Classes\dev.aural.music.audio" "" "Aural music"
  WriteRegStr HKCU "Software\Classes\dev.aural.music.audio" "FriendlyTypeName" "Aural music"
  WriteRegStr HKCU "Software\Classes\dev.aural.music.audio\DefaultIcon" "" '"$INSTDIR\Aural.exe",0'
  WriteRegStr HKCU "Software\Classes\dev.aural.music.audio\shell\open\command" "" '"$INSTDIR\Aural.exe" "%1"'
  WriteRegStr HKCU "Software\Classes\Applications\Aural.exe" "FriendlyAppName" "Aural"
  WriteRegStr HKCU "Software\Classes\Applications\Aural.exe\shell\open\command" "" '"$INSTDIR\Aural.exe" "%1"'
  WriteRegStr HKCU "Software\Aural\Capabilities" "ApplicationName" "Aural"
  WriteRegStr HKCU "Software\Aural\Capabilities" "ApplicationDescription" "Local music library and player"
  WriteRegStr HKCU "Software\RegisteredApplications" "Aural" "Software\Aural\Capabilities"
  !insertmacro AuralRegisterFormats
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend
!macro customUnInstall
  ; An old uninstaller must not remove a newer installation's registration.
  ReadRegStr $0 HKCU "Software\Classes\dev.aural.music.audio\shell\open\command" ""
  StrCmp $0 '"$INSTDIR\Aural.exe" "%1"' 0 aural_uninstall_done
  !insertmacro AuralUnregisterFormats
  DeleteRegKey HKCU "Software\Classes\dev.aural.music.audio"
  ReadRegStr $0 HKCU "Software\Classes\Applications\Aural.exe\shell\open\command" ""
  StrCmp $0 '"$INSTDIR\Aural.exe" "%1"' 0 aural_application_done
  DeleteRegKey HKCU "Software\Classes\Applications\Aural.exe"
aural_application_done:
  ReadRegStr $0 HKCU "Software\RegisteredApplications" "Aural"
  StrCmp $0 "Software\Aural\Capabilities" 0 aural_capabilities_done
  DeleteRegValue HKCU "Software\RegisteredApplications" "Aural"
  DeleteRegKey HKCU "Software\Aural\Capabilities"
aural_capabilities_done:
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
aural_uninstall_done:
!macroend
