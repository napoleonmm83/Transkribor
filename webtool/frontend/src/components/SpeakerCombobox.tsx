import { useState } from 'react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Command, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Button } from '@/components/ui/button'

export function SpeakerCombobox({ value, options, onChange }: {
  value: string; options: string[]; onChange: (v: string) => void;
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const commit = (v: string) => { onChange(v); setOpen(false) }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" className="h-6 px-1 text-xs font-normal text-muted-foreground">
          {value || 'Sprecher…'}</Button>
      </PopoverTrigger>
      <PopoverContent className="w-56 p-0">
        <Command>
          <CommandInput placeholder="Sprecher…" value={query} onValueChange={setQuery}
            onKeyDown={e => { if (e.key === 'Enter' && query.trim()) { e.preventDefault(); commit(query.trim()) } }} />
          <CommandList>
            <CommandGroup>
              {query.trim() && !options.includes(query.trim()) &&
                <CommandItem value={query} onSelect={() => commit(query.trim())}>„{query.trim()}" übernehmen</CommandItem>}
              {options.map(o => <CommandItem key={o} value={o} onSelect={() => commit(o)}>{o}</CommandItem>)}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
