import { Settings } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Slider } from '@/components/ui/slider'
import { Button } from '@/components/ui/button'
import type { Thresholds } from '@/lib/types'

export function ThresholdPopover({ thr, setThr }: { thr: Thresholds; setThr: (t: Thresholds) => void }) {
  return (
    <Popover>
      <PopoverTrigger asChild><Button size="icon" variant="ghost" aria-label="Einstellungen"><Settings className="size-4" /></Button></PopoverTrigger>
      <PopoverContent className="w-64 space-y-4">
        <div><div className="mb-1 flex justify-between text-xs"><span>gelb &lt;</span><span>{thr.yellow.toFixed(2)}</span></div>
          <Slider min={0} max={1} step={0.05} value={[thr.yellow]} onValueChange={([v]) => setThr({ ...thr, yellow: v })} /></div>
        <div><div className="mb-1 flex justify-between text-xs"><span>rot &lt;</span><span>{thr.red.toFixed(2)}</span></div>
          <Slider min={0} max={1} step={0.05} value={[thr.red]} onValueChange={([v]) => setThr({ ...thr, red: v })} /></div>
      </PopoverContent>
    </Popover>
  )
}
