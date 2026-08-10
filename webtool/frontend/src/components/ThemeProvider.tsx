import { createContext, useContext, useEffect, useState } from 'react'

type Theme = 'light' | 'dark'
const Ctx = createContext<{ theme: Theme; toggle: () => void }>({ theme: 'dark', toggle: () => {} })

function initial(): Theme {
  const saved = localStorage.getItem('theme')
  if (saved === 'light' || saved === 'dark') return saved
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setTheme] = useState<Theme>(initial)
  useEffect(() => {
    const dunkel = theme === 'dark'
    document.documentElement.classList.toggle('dark', dunkel)
    localStorage.setItem('theme', theme)
    // Dritter Empfaenger des Themas: die eigene Titelzeile faerbt sich per CSS mit, das
    // Fensterknopf-Overlay des Betriebssystems DARUEBER nicht — das kann nur der
    // Hauptprozess. Ohne Bruecke (normaler Browser) faellt der Aufruf weg.
    // Die Werte spiegeln --background aus index.css; laufen sie auseinander, sieht man
    // eine Kante zwischen unserer Zeile und den Fensterknoepfen.
    const w = window as unknown as {
      transkribor?: { titelleisteFarbe?: (f: { color: string; symbolColor: string }) => Promise<void> }
    }
    w.transkribor?.titelleisteFarbe?.(dunkel
      ? { color: '#0B0B0F', symbolColor: '#FAFAFA' }
      : { color: '#FAFAFA', symbolColor: '#0B0B0F' })?.catch?.(() => {})
  }, [theme])
  return <Ctx.Provider value={{ theme, toggle: () => setTheme(t => (t === 'dark' ? 'light' : 'dark')) }}>{children}</Ctx.Provider>
}
export const useTheme = () => useContext(Ctx)
