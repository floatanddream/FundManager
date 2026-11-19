import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

const systemTheme = window.matchMedia('(prefers-color-scheme: dark)')
const syncTheme = ({ matches }: { matches: boolean }) => {
  document.documentElement.classList.toggle('dark', matches)
}
syncTheme(systemTheme)
systemTheme.addEventListener('change', syncTheme)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
