; Páginas y textos del asistente de instalación de CapiUploader (lo incluye electron-builder con
; nsis.include). Las imágenes están en build/ (installerSidebar.bmp, uninstallerSidebar.bmp e
; installerHeader.bmp) y se generan con `npm run installer-art`.
;
; La plantilla de electron-builder inserta las páginas antes de customHeader, así que cada texto se
; define en la macro de su página, justo antes de insertarla (MUI2 consume los defines de cada página).
; Este archivo debe guardarse en UTF-8 con BOM para que NSIS lea bien los acentos.

; Bienvenida (la plantilla no trae una). Al actualizar se salta.
!macro customWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "Te damos la bienvenida a CapiUploader"
  !define MUI_WELCOMEPAGE_TEXT "Sube capítulos a Capibara Traductor desde tu escritorio: uno o muchos a la vez, desde carpetas o archivos de Photoshop, o importados de otras webs.$\r$\n$\r$\nSi ya la tenías, tus scans y ajustes se conservan.$\r$\n$\r$\nCierra CapiUploader si está abierto y pulsa «Siguiente»."
  !insertmacro skipPageIfUpdated
  !insertmacro MUI_PAGE_WELCOME
!macroend

; Final, con la casilla para abrir la app (como la de la plantilla, con otros textos).
!macro customFinishPage
  Function StartApp
    ${if} ${isUpdated}
      StrCpy $1 "--updated"
    ${else}
      StrCpy $1 ""
    ${endif}
    ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"
  FunctionEnd

  !define MUI_FINISHPAGE_TITLE "CapiUploader está lista"
  !define MUI_FINISHPAGE_TEXT "Ya puedes subir tus capítulos.$\r$\n$\r$\nCuando salga una versión nueva, la app se actualiza sola."
  !define MUI_FINISHPAGE_RUN
  !define MUI_FINISHPAGE_RUN_FUNCTION "StartApp"
  !define MUI_FINISHPAGE_RUN_TEXT "Abrir CapiUploader"
  !insertmacro MUI_PAGE_FINISH
!macroend

; Desinstalador: bienvenida y, antes de su página final, los textos de esa página.
!macro customUnWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "Desinstalar CapiUploader"
  !define MUI_WELCOMEPAGE_TEXT "Se quitará CapiUploader de este equipo.$\r$\n$\r$\nTus scans, API keys y ajustes no se borran: si vuelves a instalarla, todo sigue como lo dejaste.$\r$\n$\r$\nCierra CapiUploader si está abierto y pulsa «Siguiente»."
  !insertmacro MUI_UNPAGE_WELCOME
!macroend

!macro customUninstallPage
  !define MUI_FINISHPAGE_TITLE "CapiUploader se desinstaló"
  !define MUI_FINISHPAGE_TEXT "Gracias por usar CapiUploader."
!macroend
