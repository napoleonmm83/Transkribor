"use client"

import * as React from "react"
import { ScrollArea as ScrollAreaPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"

function ScrollArea({
  className,
  children,
  ...props
}: React.ComponentProps<typeof ScrollAreaPrimitive.Root>) {
  return (
    <ScrollAreaPrimitive.Root
      data-slot="scroll-area"
      className={cn("relative", className)}
      {...props}
    >
      {/* `relative` ist hier Pflicht, nicht Zierrat — und der Scanner in
          `bildlaufanker.test.ts` kann es nicht erzwingen: er sucht `overflow-*` in
          Klassennamen, und der Viewport hat keinen. Radix setzt sein `overflow: scroll`
          zur LAUFZEIT. Ohne Anker ist der Bezugsrahmen absolut positionierter Nachfahren
          die ScrollArea-WURZEL, die AUSSERHALB der rollenden Flaeche liegt; geklemmt wird
          aber nur, wessen Bezugsrahmen INNERHALB liegt. Gemessen am Editor (105 Segmente,
          14 Anmerkungen): 16 von 121 absoluten Nachfahren entkamen — alle `sr-only`, das
          IST `position:absolute` —, ihre Flusspositionen reichten bis 9909 px bei
          Viewport-Unterkante 1144 px. Das blies die Wurzel auf `scrollHeight` 9816 und gab
          dem `overflow-auto`-Div in `EditorView.tsx` eine ZWEITE Bildlaufflaeche: zwei
          Leisten am rechten Rand, die zweite greift erst, wenn die erste unten ist.
          Dieselbe Falle wie an `main` in `AppShell.tsx`, dort schon behoben — und dort
          ebenfalls von einem `sr-only` ausgeloest. */}
      <ScrollAreaPrimitive.Viewport
        data-slot="scroll-area-viewport"
        className="relative size-full rounded-[inherit] transition-[color,box-shadow] outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-1"
      >
        {children}
      </ScrollAreaPrimitive.Viewport>
      <ScrollBar />
      <ScrollAreaPrimitive.Corner />
    </ScrollAreaPrimitive.Root>
  )
}

function ScrollBar({
  className,
  orientation = "vertical",
  ...props
}: React.ComponentProps<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>) {
  return (
    <ScrollAreaPrimitive.ScrollAreaScrollbar
      data-slot="scroll-area-scrollbar"
      orientation={orientation}
      className={cn(
        "flex touch-none p-px transition-colors select-none",
        orientation === "vertical" &&
          "h-full w-2.5 border-l border-l-transparent",
        orientation === "horizontal" &&
          "h-2.5 flex-col border-t border-t-transparent",
        className
      )}
      {...props}
    >
      {/* Der Daumen traegt den Hausakzent, nicht `bg-border` — und das ist KEINE Kosmetik:
          Radix versteckt die native Leiste zur Laufzeit (ein ungeschichtetes `<style>` mit
          `[data-radix-scroll-area-viewport]{scrollbar-width:none}` plus
          `::-webkit-scrollbar{display:none}`), womit die globale `*`-Regel aus `index.css`
          hier NICHT ankommt — sie ist geschichtet und hat Spezifitaet 0,0,0. Das Transkript
          rollt in genau dieser Flaeche (`Transcript.tsx`), also auf der meistbenutzten
          Rollflaeche der App; sie blieb grau bei **1,22:1**, waehrend ueberall sonst 3,33:1
          stand. `bg-primary/70` ist rechnerisch DIESELBE Farbe wie die globale Regel —
          Tailwind v4 uebersetzt den Deckkraft-Modifikator nach
          `color-mix(in oklab, var(--primary) 70%, transparent)`, also Zeichen fuer Zeichen
          das, was in `index.css` steht. `w-2.5` (10 px) entspricht dabei etwa `thin`.
          **Was bleibt:** Radix' Voreinstellung `type="hover"` zeigt den Daumen nur, solange
          der Zeiger ueber der Flaeche steht — die nativen Leisten daneben stehen dauerhaft.
          Eine bewusst nicht angefasste Differenz: das ist Verhalten, nicht Farbe. */}
      <ScrollAreaPrimitive.ScrollAreaThumb
        data-slot="scroll-area-thumb"
        className="relative flex-1 rounded-full bg-primary/70"
      />
    </ScrollAreaPrimitive.ScrollAreaScrollbar>
  )
}

export { ScrollArea, ScrollBar }
