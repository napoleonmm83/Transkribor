import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import './index.css'
import App from './App.tsx'
import { ThemeProvider } from './components/ThemeProvider.tsx'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { JobProvider } from '@/hooks/useActiveJob'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider>
      <TooltipProvider>
        <JobProvider>
          <BrowserRouter>
            <App />
          </BrowserRouter>
        </JobProvider>
        <Toaster richColors position="bottom-right" />
      </TooltipProvider>
    </ThemeProvider>
  </StrictMode>,
)
