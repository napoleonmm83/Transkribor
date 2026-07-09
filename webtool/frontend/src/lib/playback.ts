export const PAD = { in: 0.15, out: 0.35 }

export function playWindow(seg: { start: number; end: number }, duration: number) {
  const from = Math.max(0, seg.start - PAD.in)
  const end = seg.end + PAD.out
  return { from, to: Number.isFinite(duration) ? Math.min(duration, end) : end }
}
