import { createContext, useContext } from 'react'

export type Theme = 'light' | 'dark'
export const Ctx = createContext<{ theme: Theme; toggle: () => void }>({ theme: 'dark', toggle: () => {} })

export const useTheme = () => useContext(Ctx)
