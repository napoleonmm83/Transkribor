import { Moon, Sun } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTheme } from '@/components/ThemeProvider'

export function ThemeToggle() {
  const { theme, toggle } = useTheme()
  return <Button variant="ghost" size="icon" onClick={toggle} aria-label="Theme umschalten">
    {theme === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}
  </Button>
}
