import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import './index.css'
import App from './App.tsx'
import { ThemeProvider } from './components/ThemeProvider.tsx'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { JobProvider } from '@/hooks/useActiveJob'

function anzeigen() { createRoot(document.getElementById('root')!).render(
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
) }

// Im normalen Browser gibt es keine Electron-Bruecke. Die Renderer-Integrationen erfassen
// ausschliesslich unbehandelte Fehler; der Hauptprozess entscheidet ueber Opt-in und Maske.
if ('__SENTRY_IPC__' in window) {
  import('@sentry/electron/renderer').then(Sentry => {
    Sentry.init({
      defaultIntegrations: [
        // Dedupe gehoert zur SDK-Vorgabe und fiel mit der expliziten Liste weg; ohne ihn geht
        // eine Fehlerschleife als Serie gleicher Ereignisse an den Hauptprozess (Kalt-Review 24.09.).
        Sentry.dedupeIntegration(),
        Sentry.globalHandlersIntegration(),
        Sentry.browserApiErrorsIntegration(),
        Sentry.linkedErrorsIntegration(),
      ],
      sendDefaultPii: false,
      autoSessionTracking: false,
      beforeBreadcrumb: () => null,
    })
  }).catch(e => console.error('Renderer-Fehlerberichte konnten nicht gestartet werden', e))
    .finally(anzeigen)
} else anzeigen()
