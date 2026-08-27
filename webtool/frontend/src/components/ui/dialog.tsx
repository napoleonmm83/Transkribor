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
          // #330: die ✕-Huelle unten belegt Zeile 1 und kostet dadurch EINE `gap-4`-Luecke —
          // jeder Dialog waere sonst 16 px hoeher (gemessen 580 -> 596). Ein negativer Rand
          // an der Huelle selbst hilft NICHT: die Grid-Spur wird bei 0 geklemmt, die Luecke
          // bleibt (alle drei Varianten gemessen, Delta 0). Also am FOLGENDEN Element ziehen.
          // `:has(...)` haelt das an die Huelle gebunden: ohne ✕ (`showCloseButton={false}`)
          // gibt es sie nicht, und dann darf hier auch nichts verschoben werden.
          "[&:has(>[data-slot=dialog-close-huelle])>*:first-child]:-mt-4",
          className
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          // #330: der ✕ sass `absolute` IM Bildlaufbehaelter (seit #283 rollt der) und
          // wanderte mit dem Inhalt aus dem Bild (gemessen: top 33 -> -261 bei 320 px).
          // `sticky` haelt ihn — dafuer muss er IM FLUSS liegen, darum diese Huelle.
          // Sie ist `h-0` und spannt per `row-start-1 row-end-[-1]` ueber ALLE Zeilen:
          // eine eigene Zeile brauchte sonst eine `gap-4`-Luecke und machte jeden Dialog
          // 16 px hoeher (gemessen). Die negativen Versaetze am ✕ heben `p-6` teilweise
          // auf, damit er exakt dort bleibt, wo er vorher stand (16 px zur Kante).
          // `order-first` ist fuer MaterialDialog: das ersetzt `grid` durch `flex flex-col`,
          // und dort ist die Zeilenangabe wirkungslos — die Huelle landete als letztes
          // Flex-Kind UNTEN, der ✕ bei 615 von 648 px (im Browser gemessen). `order` wirkt
          // in beiden Layouts und laesst die TAB-Reihenfolge in Ruhe (die folgt dem DOM,
          // der ✕ bleibt also letzter Halt — sonst faenge der Dialog den Fokus auf dem ✕).
          // Keine `justify-self`/`self`-Angabe: die Huelle soll in BEIDEN Layouts die volle
          // Breite nehmen (`stretch` ist dort jeweils der Standard), damit `-right-2` am ✕
          // von der rechten Kante rechnet. In `flex-col` waere `self-start` die LINKE.
          <div
            data-slot="dialog-close-huelle"
            className="pointer-events-none sticky top-0 z-10 order-first row-start-1 row-end-[-1] h-0"
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
