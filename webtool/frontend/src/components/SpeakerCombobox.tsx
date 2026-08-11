import { useState } from 'react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Command, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export function SpeakerCombobox({ value, options, onChange, className, style, title }: {
  value: string; options: string[]; onChange: (v: string) => void; className?: string;
  style?: React.CSSProperties; title?: string;
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const commit = (v: string) => { onChange(v); setOpen(false) }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" style={style} title={title}
          className={cn('h-6 px-1 text-xs font-normal text-muted-foreground', className)}>
          {value || 'Sprecher…'}</Button>
      </PopoverTrigger>
      <PopoverContent className="w-56 p-0">
        <Command>
          <CommandInput placeholder="Sprecher…" value={query} onValueChange={setQuery}
            onKeyDown={e => { if (e.key === 'Enter' && query.trim()) { e.preventDefault(); e.stopPropagation(); commit(query.trim()) } }} />
          <CommandList>
            <CommandGroup>
              {query.trim() && !options.includes(query.trim()) &&
                <CommandItem value={query} onSelect={() => commit(query.trim())}>„{query.trim()}“ übernehmen</CommandItem>}
              {options.map(o => <CommandItem key={o} value={o} onSelect={() => commit(o)}>{o}</CommandItem>)}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
