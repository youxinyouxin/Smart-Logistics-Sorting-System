import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import './styles/tokens.css'
import './styles/global.css'
import './styles/pages.css'
import App from './App.tsx'
import { SettingsProvider } from './lib/settings'
import { ToastProvider } from './components/ui/Toast'
import { RulesProvider } from './lib/rules'
import { DataSourceProvider } from './lib/useDataSource'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <SettingsProvider>
      <ToastProvider>
        <RulesProvider>
          <DataSourceProvider>
            <BrowserRouter>
              <App />
            </BrowserRouter>
          </DataSourceProvider>
        </RulesProvider>
      </ToastProvider>
    </SettingsProvider>
  </StrictMode>,
)
