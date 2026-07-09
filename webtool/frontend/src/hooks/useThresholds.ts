import { useState } from 'react'
import type { Thresholds } from '@/lib/types'
const KEY = 'thresholds'
const load = (): Thresholds => {
  try { const v = JSON.parse(localStorage.getItem(KEY) || ''); if (v && typeof v.yellow === 'number') return v } catch {}
  return { yellow: 0.6, red: 0.4 }
}
export function useThresholds() {
  const [thr, setThrState] = useState<Thresholds>(load)
  const setThr = (t: Thresholds) => { setThrState(t); localStorage.setItem(KEY, JSON.stringify(t)) }
  return { thr, setThr }
}
