import * as React from "react"
import { XIcon } from "lucide-react"
import { Dialog as DialogPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"

function Dialog({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />
}

function DialogTrigger({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />
}

function DialogPortal({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Portal>) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />
}

function DialogClose({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />
}

function DialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      className={cn(
        "fixed inset-0 z-50 bg-black/50 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0",
        className
      )}
      {...props}
    />
  )
}

function DialogContent({
  className,
  children,
  showCloseButton = true,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  showCloseButton?: boolean
}) {
  return (
    <DialogPortal data-slot="dialog-portal">
      <DialogOverlay />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        className={cn(
          "fixed top-[50%] left-[50%] z-50 grid w-full max-w-[calc(100%-2rem)] translate-x-[-50%] translate-y-[-50%] gap-4 max-h-[calc(100dvh-2rem-var(--titelzeile,0px))] overflow-y-auto rounded-lg border bg-background p-6 shadow-lg duration-200 outline-none data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 sm:max-w-lg",
          // #330: die ✕-Huelle unten steht als erstes im Fluss und kostet dadurch EINE
          // `gap-4`-Luecke — jeder Dialog waere sonst 16 px hoeher (gemessen 580 -> 596).
          // Ein negativer Rand an der Huelle selbst hilft NICHT: die Grid-Spur wird bei 0
          // geklemmt, die Luecke bleibt (alle drei Varianten gemessen, Delta 0). Also am
          // FOLGENDEN Element ziehen. `:has(...)` haelt das an die Huelle gebunden: ohne ✕
          // (`showCloseButton={false}`) gibt es sie nicht, und dann darf auch nichts
          // verschoben werden.
          //
          // **Was diese Zeile an Kopplung NEU einfuehrt** — alles gemessen, und KEINES
          // trifft einen der fuenf heutigen Verbraucher; wer einen neuen baut, liest hier:
          //   * `p-6` — die Versaetze `-top-2 -right-2` am ✕ gleichen genau diese Polsterung
          //     aus. Andere Polsterung ⇒ eigene Zeile noetig (siehe `command.tsx`, `p-0`).
          //   * `gap-4` — der Ausgleich ist auf diesen Wert festverdrahtet. Mit `gap-0` zieht
          //     er das erste Kind 16 px IN die Polsterung (8,67 statt 24,67).
          //   * einspaltig — die Huelle dehnt sich ueber EINE Spalte. Bei zwei Spalten sitzt
          //     der ✕ an der Spaltenkante (48 statt 32 px von rechts), nicht an der Dialogkante.
          //   * kein eigener `mt-*` am ersten Kind — diese Regel schlaegt dessen Utility.
          "[&:has(>[data-slot=dialog-close-huelle])>*:first-child]:-mt-4",
          className
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          // #330: der ✕ sass `absolute` IM Bildlaufbehaelter (seit #283 rollt der) und
          // wanderte mit dem Inhalt aus dem Bild (gemessen: top 33 -> -261 bei 320 px).
          // `sticky` haelt ihn — dafuer muss er IM FLUSS liegen, darum diese `h-0`-Huelle.
          //
          // `order-first` traegt die Platzierung ALLEIN, und zwar in beiden Layouts:
          // `MaterialDialog` ersetzt `grid` durch `flex flex-col`, wo Grid-Zeilenangaben
          // wirkungslos sind — ohne `order` landete die Huelle dort als letztes Flex-Kind
          // UNTEN, der ✕ bei 615 von 648 px (im Browser gemessen). Hier standen zuerst
          // zusaetzlich `row-start-1 row-end-[-1]`, mit der Begruendung, `sticky` brauche
          // einen vollhohen Bezugsrahmen. **Das war falsch und ist nachgemessen:** in der
          // echten App klebt der ✕ mit `1/-1`, mit `row-start-1` und ganz ohne Zeilenangabe
          // gleich gut (16,67 an jedem Rollstand); nur ohne `order` wandert er. `-1` zaehlt
          // ausserdem ab dem EXPLIZITEN Raster, das es hier nicht gibt — die Angabe war
          // wirkungslos und waere zur Falle geworden, sobald ein Verbraucher `grid-rows-*`
          // setzt: damit gemessen kam die `gap`-Luecke zurueck (580 -> 596).
          // `order` laesst die TAB-Reihenfolge in Ruhe (die folgt dem DOM, der ✕ bleibt
          // letzter Halt — als DOM-erstes Kind finge der Dialog den Fokus auf dem ✕).
          //
          // Keine `justify-self`/`self`-Angabe: die Huelle soll die volle Breite nehmen
          // (`stretch` ist in beiden Layouts der Standard), damit `-right-2` am ✕ von der
          // rechten Kante rechnet. In `flex-col` waere `self-start` die LINKE.
          <div
            data-slot="dialog-close-huelle"
            className="pointer-events-none sticky top-0 z-10 order-first h-0"
          >
            <DialogPrimitive.Close
              data-slot="dialog-close"
              className="pointer-events-auto absolute -top-2 -right-2 rounded-xs opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:outline-hidden disabled:pointer-events-none data-[state=open]:bg-accent data-[state=open]:text-muted-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4"
            >
              <XIcon />
              <span className="sr-only">Close</span>
            </DialogPrimitive.Close>
          </div>
        )}
      </DialogPrimitive.Content>
    </DialogPortal>
  )
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn("flex flex-col gap-2 text-center sm:text-left", className)}
      {...props}
    />
  )
}

function DialogFooter({
  className,
  showCloseButton = false,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  showCloseButton?: boolean
}) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        "flex flex-col-reverse gap-2 sm:flex-row sm:justify-end",
        className
      )}
      {...props}
    >
      {children}
      {showCloseButton && (
        <DialogPrimitive.Close asChild>
          <Button variant="outline">Close</Button>
        </DialogPrimitive.Close>
      )}
    </div>
  )
}

function DialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn("text-lg leading-none font-semibold", className)}
      {...props}
    />
  )
}

function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  )
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
}
