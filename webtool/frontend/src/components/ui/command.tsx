"use client"

import * as React from "react"
import { Command as CommandPrimitive } from "cmdk"
import { SearchIcon } from "lucide-react"

import { cn } from "@/lib/utils"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

function Command({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive>) {
  return (
    <CommandPrimitive
      data-slot="command"
      className={cn(
        "flex h-full w-full flex-col overflow-hidden rounded-md bg-popover text-popover-foreground",
        className
      )}
      {...props}
    />
  )
}

function CommandDialog({
  title = "Command Palette",
  description = "Search for a command to run...",
  children,
  className,
  showCloseButton = true,
  ...props
}: React.ComponentProps<typeof Dialog> & {
  title?: string
  description?: string
  className?: string
  showCloseButton?: boolean
}) {
  return (
    <Dialog {...props}>
      <DialogHeader className="sr-only">
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{description}</DialogDescription>
      </DialogHeader>
      <DialogContent
        // #330: der ✕ sitzt seit der Bildlauf-Reparatur in einer Huelle IM Inhaltsfluss,
        // rechnet also ab dem INHALTSRAND — die Basis gleicht dafuer das uebliche `p-6`
        // mit `-top-2 -right-2` aus. Hier ist die Polsterung `p-0`, der Ausgleich zeigt
        // also ins Leere: der ✕ landete bei -7,3/-7,3. Er war damit nicht etwa ausserhalb
        // SICHTBAR — `overflow-hidden` klemmt ihn an der Kante weg: in der ✕-Mitte
        // antwortete `elementFromPoint` mit dem Overlay, und erreichbar blieben **61 von
        // 256 px** (mit dieser Zeile: 255 von 256, Mitte trifft). Ohne Polsterung ist der
        // normale Versatz der richtige. Der Nachfahren-Selektor schlaegt die Basisklasse
        // (Spezifitaet 0,2,0 gegen 0,1,0 — im Browser bestaetigt).
        // Nebenwirkung, heute ohne Verbraucher: `DialogClose` traegt dasselbe `data-slot`,
        // ein solches Element in einem `CommandDialog` bekaeme die Regel also mit — an
        // einem statischen Element sind `top`/`right` wirkungslos.
        className={cn(
          "overflow-hidden p-0 [&_[data-slot=dialog-close]]:top-4 [&_[data-slot=dialog-close]]:right-4",
          className
        )}
        showCloseButton={showCloseButton}
      >
        <Command className="**:data-[slot=command-input-wrapper]:h-12 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group]]:px-2 [&_[cmdk-group]:not([hidden])_~[cmdk-group]]:pt-0 [&_[cmdk-input-wrapper]_svg]:h-5 [&_[cmdk-input-wrapper]_svg]:w-5 [&_[cmdk-input]]:h-12 [&_[cmdk-item]]:px-2 [&_[cmdk-item]]:py-3 [&_[cmdk-item]_svg]:h-5 [&_[cmdk-item]_svg]:w-5">
          {children}
        </Command>
      </DialogContent>
    </Dialog>
  )
}

function CommandInput({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Input>) {
  return (
    <div
      data-slot="command-input-wrapper"
      className="flex h-9 items-center gap-2 border-b px-3"
    >
      <SearchIcon className="size-4 shrink-0 opacity-50" />
      <CommandPrimitive.Input
        data-slot="command-input"
        className={cn(
          "flex h-10 w-full rounded-md bg-transparent py-3 text-sm outline-hidden placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50",
          className
        )}
        {...props}
      />
    </div>
  )
}

function CommandList({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.List>) {
  return (
    <CommandPrimitive.List
      data-slot="command-list"
      className={cn(
        // `relative` aus demselben Grund wie am ScrollArea-Viewport: ein `overflow`-Behaelter
        // klemmt absolut positionierte Nachfahren NUR, wenn er selbst ihr Bezugsrahmen ist,
        // und diese Liste IST der Bildlaufbehaelter (`overflow-y-auto` eine Zeile tiefer).
        // **Heute ein No-op, und das ist gemessen:** weder `ProjektPalette` noch
        // `SpeakerCombobox` rendert absolut positionierte Nachfahren in die Liste. Er steht
        // trotzdem — dieselbe Abwaegung wie am `<nav>` der Seitenleiste (`AppShell.tsx`): der
        // Anker ist billig, und es ist der Behaelter, dessen Inhalt mit den Daten waechst.
        // **cmdks `<label>` ist NICHT der Grund** (so stand es hier zuerst, CodeRabbit-Bot,
        // Major): das `position:absolute`-Label haengt im Command-ROOT (cmdk 1.1.1,
        // `createElement("label", …, {style: Te})`), ist also nie Nachfahre dieser Liste — kein
        // `overflow` von ihr kann es klemmen oder verfehlen. Es an die Root zu haengen (der
        // Vorschlag des Befunds) waere eine ANDERE Frage als die Ankerregel, und sie stellt sich
        // nicht: beide Verbraucher geben dem Label ohnehin einen positionierten Vorfahren
        // (`DialogContent` ist `fixed`, `PopoverContent` positioniert Radix).
        // Der Scanner in `bildlaufanker.test.ts` sieht diese Zeile nicht (sie steht in `cn(…)`,
        // #366) — der Waechter dafuer ist die DOM-Zusicherung dort.
        "relative max-h-[300px] scroll-py-1 overflow-x-hidden overflow-y-auto",
        className
      )}
      {...props}
    />
  )
}

function CommandEmpty({
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Empty>) {
  return (
    <CommandPrimitive.Empty
      data-slot="command-empty"
      className="py-6 text-center text-sm"
      {...props}
    />
  )
}

function CommandGroup({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Group>) {
  return (
    <CommandPrimitive.Group
      data-slot="command-group"
      className={cn(
        "overflow-hidden p-1 text-foreground [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground",
        className
      )}
      {...props}
    />
  )
}

function CommandSeparator({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Separator>) {
  return (
    <CommandPrimitive.Separator
      data-slot="command-separator"
      className={cn("-mx-1 h-px bg-border", className)}
      {...props}
    />
  )
}

function CommandItem({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Item>) {
  return (
    <CommandPrimitive.Item
      data-slot="command-item"
      className={cn(
        "relative flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-hidden select-none data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50 data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 [&_svg:not([class*='text-'])]:text-muted-foreground",
        className
      )}
      {...props}
    />
  )
}

function CommandShortcut({
  className,
  ...props
}: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="command-shortcut"
      className={cn(
        "ml-auto text-xs tracking-widest text-muted-foreground",
        className
      )}
      {...props}
    />
  )
}

export {
  Command,
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandShortcut,
  CommandSeparator,
}
