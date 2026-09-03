import { useState } from 'react'
import { toast } from 'sonner'
import { Bug } from 'lucide-react'
import { useFehlerberichte } from '@/hooks/useFehlerberichte'
import { Button } from '@/components/ui/button'
import {
  AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogMedia, AlertDialogTitle,
} from '@/components/ui/alert-dialog'

/**
 * Die einmalige Nachfrage zu automatischen Fehlerberichten (#530) — im Design der App statt
 * im grauen Systemkasten. Bis v0.52.0 stellte sie der Hauptprozess per
 * `dialog.showMessageBox`; ein natives Fenster laesst sich nicht gestalten, also fragt jetzt
 * die Oberflaeche.
 *
 * **Es braucht dafuer keinen neuen Kanal.** Der Zustand aus `useFehlerberichte()` sagt selbst,
 * ob schon gefragt wurde: `gefragt === null` heisst „noch nie". Und `setzen()` traegt im
 * Hauptprozess `gefragt` mit ein (`main.js`, ipc `fehlerberichte:setzen`) — die Antwort
 * beendet die Frage also von selbst, in derselben Datei wie vorher.
 *
 * Drei Eigenschaften des alten Fensters bleiben, weil sie Entscheidungen waren:
 *   1. `cancelId: 1` — Schliessen heisst **Nein**. Es gibt genau ZWEI Wege hinaus, und beide
 *      fallen durch dasselbe `onOpenChange`: der Nein-Knopf und Escape. Ein Klick DANEBEN tut
 *      nichts — ein `AlertDialog` unterdrueckt `onInteractOutside` von sich aus, anders als ein
 *      `Dialog`. Das ist das bessere Verhalten (kein versehentliches Nein), aber es ist nicht
 *      dasselbe wie „jeder Weg hinaus"; hier stand die falsche Fassung, bis das Review sie fand.
 *   2. `defaultId: 1` — Enter heisst **Nein**. Radix legt den Fokus von sich aus auf
 *      `AlertDialogCancel`; Opt-in bleibt damit eine Entscheidung, kein Durchwinken.
 *   3. Vorgabe **aus**: schlaegt das Schreiben fehl, steht nichts in der Datei — dann fragt
 *      der naechste Start noch einmal, und genau das sagt der Toast.
 */
export function FehlerberichteFrage() {
  const fb = useFehlerberichte()
  // Schliesst sofort, statt bis zur Antwort des Hauptprozesses offen zu bleiben — und genau
  // DARIN liegt der Riegel: bliebe der Dialog waehrend des Rundlaufs stehen, schriebe ein
  // Escape in dieser Luecke ein „Nein" ueber das eben gegebene „Ja". Ein kontrolliertes
  // `open={false}` loest umgekehrt KEIN `onOpenChange` aus, es kommt also keine zweite Antwort
  // nach. (Der Rundlauf ist kurz, aber nicht null — die Mutationsprobe sieht ihn nur mit einem
  // haengenden Versprechen, und ohne dieses Detail war die Zusicherung Dekoration.)
  const [beantwortet, setBeantwortet] = useState(false)

  // `fb === null`: Browser oder aeltere App-Huelle. `zustand === null`: der Hauptprozess hat
  // noch nicht geantwortet — solange wird nicht gefragt, sonst blitzt der Dialog beim Start auf.
  const offen = !beantwortet && fb?.zustand?.gefragt === null

  const antwort = (an: boolean) => {
    setBeantwortet(true)
    fb?.setzen(an).catch(() => toast.error(
      'Die Antwort liess sich nicht speichern — Transkribor fragt beim nächsten Start noch einmal.',
    ))
  }

  return (
    <AlertDialog open={offen} onOpenChange={o => { if (!o) antwort(false) }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogMedia>
            <Bug aria-hidden="true" />
          </AlertDialogMedia>
          <AlertDialogTitle>Darf Transkribor Fehler automatisch an uns senden?</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-3">
              <p>
                Mitgeschickt werden: die Fehlermeldung mit Stelle im Programm, die Fassung, dein
                Betriebssystem und die letzten Protokollzeilen — Benutzername, Projekt- und
                Aufnahmenamen werden vorher unkenntlich gemacht.
              </p>
              <p>
                <strong className="font-medium text-foreground">Nie mitgeschickt:</strong> Aufnahmen,
                Transkripte, Einstellungen, Schlüssel.
              </p>
              <p>Du kannst das jederzeit unter „Version“ umstellen.</p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Nein</AlertDialogCancel>
          <Button onClick={() => antwort(true)}>Ja, automatisch senden</Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
