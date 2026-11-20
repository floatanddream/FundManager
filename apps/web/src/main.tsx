import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { applyTheme, readThemePreference } from './theme.ts'

// 首次渲染前应用主题，避免工作台先用亮色绘出再切换。
const systemTheme = window.matchMedia('(prefers-color-scheme: dark)')
applyTheme(readThemePreference(), systemTheme.matches)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
