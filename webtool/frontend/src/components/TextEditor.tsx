import { Textarea } from '@/components/ui/textarea'

// ponytail: field-sizing-content (auto-grow) already ships in ui/textarea's base class, no inline style needed.
export function TextEditor({ initial, onCommit, onCancel }: {
  initial: string; onCommit: (text: string) => void; onCancel: () => void;
}) {
  return (
    <Textarea defaultValue={initial} autoFocus
      className="min-h-0 resize-none leading-relaxed"
      onBlur={e => onCommit(e.target.value)}
      onKeyDown={e => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); onCommit(e.currentTarget.value) }
        if (e.key === 'Escape') { e.preventDefault(); onCancel() }
      }} />
  )
}
