import { useState } from 'react'
import { toast } from 'sonner'
import { BarChart3 } from 'lucide-react'
import { useNutzung } from '@/hooks/useNutzung'
import { useFehlerberichte } from '@/hooks/useFehlerberichte'
import { Button } from '@/components/ui/button'
import {
  AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogMedia, AlertDialogTitle,
} from '@/components/ui/alert-dialog'

/**
 * Die einmalige Nachfrage zur Nutzungszählung — Zwilling von `FehlerberichteFrage` und mit
 * denselben drei Entscheidungen: Schliessen und Enter heissen **Nein**, Vorgabe **aus**.
 * Sie erscheint erst, wenn die Fehlerberichte-Frage beantwortet ist (sonst stünden zwei
 * Dialoge übereinander); eine Hülle ohne Fehlerberichte-Schalter fragt direkt.
 */
export function NutzungFrage() {
  const nu = useNutzung()
  const fb = useFehlerberichte()
  const [beantwortet, setBeantwortet] = useState(false)
  if (nu?.zustand?.gefragt && !beantwortet) setBeantwortet(true)

  const fbErledigt = fb === null || !!fb.zustand?.gefragt
  const offen = !beantwortet && fbErledigt && nu?.zustand?.gefragt === null

  const antwort = (an: boolean) => {
    setBeantwortet(true)
    nu?.setzen(an).catch(() => toast.error(
      'Die Antwort liess sich nicht speichern — Transkribor fragt beim nächsten Start noch einmal.',
    ))
  }

  return (
    <AlertDialog open={offen} onOpenChange={o => { if (!o) antwort(false) }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogMedia>
            <BarChart3 aria-hidden="true" />
          </AlertDialogMedia>
          <AlertDialogTitle>Darf Transkribor mitzählen, dass es benutzt wird?</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-3">
              <p>
                Einmal am Tag schickt Transkribor drei Angaben an uns: eine Gerätenummer, die Fassung
                des Programms und dein Betriebssystem. Die Gerätenummer wird aus einer Kennung deines
                Computers berechnet. Sie erkennt dieses Gerät wieder, auch nach einer Neuinstallation,
                verrät aber nicht, wer du bist oder wie dein Computer heisst.
              </p>
              <p>
                <strong className="font-medium text-foreground">Wofür:</strong> damit wir wissen, wie
                viele Geräte Transkribor benutzen und welche Fassungen und Betriebssysteme wir weiter
                unterstützen müssen.
              </p>
              <p>
                <strong className="font-medium text-foreground">Nie dabei:</strong> Aufnahmen,
                Transkripte, Projekt- oder Dateinamen, Einstellungen. Deine IP-Adresse wird nicht gespeichert.
              </p>
              <p>Du kannst das jederzeit unter „Version“ umstellen und siehst dort genau, was gesendet wird.</p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Nein</AlertDialogCancel>
          <Button onClick={() => antwort(true)}>Ja, mitzählen</Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
