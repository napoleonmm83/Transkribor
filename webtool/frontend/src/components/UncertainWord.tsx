import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { Word } from '@/lib/types'

export function UncertainWord({ word, cls }: { word: Word; cls: 'u-yellow' | 'u-red' }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild><span className={cls}>{word.word}</span></TooltipTrigger>
      <TooltipContent>Roh: „{word.word.trim()}" · {(word.probability ?? 1).toFixed(2)}</TooltipContent>
    </Tooltip>
  )
}
