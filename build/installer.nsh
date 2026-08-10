; MUI2 fuegt die Willkommensseite NICHT von selbst hinzu. Ohne sie erscheint der
; 164x314-Streifen nur auf der Abschlussseite, und die eigentliche Nachricht kaeme
; nie an: dass nach der Installation noch ein grosser Download folgt. Genau dort
; halten Leute die App fuer kaputt.
!macro customWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "Willkommen bei Transkribor"
  !define MUI_WELCOMEPAGE_TEXT "Dieser Assistent installiert Transkribor auf deinem Rechner. \
Das dauert etwa eine Minute.$\r$\n$\r$\nDanach passiert noch etwas: Beim ersten Start lädt \
Transkribor die Spracherkennung herunter — mehrere Gigabyte, je nach Leitung 10 bis 30 Minuten. \
Das ist einmalig. Danach läuft alles offline auf deinem Rechner, ohne Konto und ohne Cloud."
  !insertmacro MUI_PAGE_WELCOME
!macroend
