import { useRef, type ReactNode } from 'react'
import { Ctx, type OffenesDokument } from './useEditorBruecke'

export function EditorBrueckeProvider({ children }: { children: ReactNode }) {
  const ref = useRef<OffenesDokument | null>(null)
  return <Ctx.Provider value={ref}>{children}</Ctx.Provider>
}

