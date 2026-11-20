export type ThemePreference = 'system' | 'light' | 'dark'

const storageKey = 'fundmanager-theme'

/** 从本地设置读取主题；浏览器禁用存储时回退到系统模式。 */
export function readThemePreference(): ThemePreference {
  try {
    const saved = window.localStorage.getItem(storageKey)
    if (saved === 'light' || saved === 'dark' || saved === 'system') return saved
  } catch {
    // 隐私模式或浏览器策略可能禁用存储，系统模式仍可正常使用。
  }
  return 'system'
}

/** 保存显示偏好，存储不可用时由当前会话继续持有选择。 */
export function saveThemePreference(preference: ThemePreference) {
  try {
    window.localStorage.setItem(storageKey, preference)
  } catch {
    // 浏览器可能阻止写入，主题切换仍可在本次会话使用。
  }
}

/** 按显式偏好或系统偏好设置 html.dark，供全局样式和图表读取。 */
export function applyTheme(preference: ThemePreference, systemIsDark: boolean) {
  document.documentElement.classList.toggle(
    'dark',
    preference === 'dark' || (preference === 'system' && systemIsDark),
  )
}
