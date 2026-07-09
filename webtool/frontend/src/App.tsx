import { Button } from '@/components/ui/button'
import { ThemeToggle } from '@/components/ThemeToggle'

export default function App() {
  return (
    <div className="flex items-center gap-4 p-4">
      <h1 className="text-2xl font-bold text-primary">Transkribor</h1>
      <Button>Test</Button>
      <ThemeToggle />
    </div>
  )
}
