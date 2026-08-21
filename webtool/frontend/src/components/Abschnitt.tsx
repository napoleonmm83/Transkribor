/**
 * Abschnitt als Blatt. Vorher trennten nur `border-t`-Striche — die Seite las sich als eine
 * lange Rolle, in der Whisper-Qualität, KI-Anbieter und Update-Stand gleich wichtig aussahen.
 *
 * Lag bis zur eigenen Versionsseite lokal in `SettingsPage.tsx`; hier liegt es, seit es zwei
 * Seiten sind — zwei Blätter, die sich um ein Pixel unterscheiden, sehen nach Versehen aus.
 */
export function Abschnitt({ titel, children }: { titel: string; children: React.ReactNode }) {
  return (
    <section className="blatt mb-6 p-5">
      <h2 className="rubrik mb-4">{titel}</h2>
      {children}
    </section>
  )
}
