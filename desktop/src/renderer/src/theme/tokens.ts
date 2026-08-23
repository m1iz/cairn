// Theme registry. Semantic design tokens themselves live in styles.css under
// :root (dark, default) and :root[data-theme="light"]; this module only owns
// the theme name contract and applies the active theme to the document.

export const THEMES = ['dark', 'light'] as const
export type ThemeName = (typeof THEMES)[number]
export const DEFAULT_THEME: ThemeName = 'dark'

export function isTheme(value: unknown): value is ThemeName {
  return (
    typeof value === 'string' && (THEMES as readonly string[]).includes(value)
  )
}

// Apply a theme to the document root by setting data-theme. Returns the theme
// actually applied (falls back to DEFAULT_THEME for invalid input).
export function applyTheme(doc: Document, name: unknown): ThemeName {
  const theme = isTheme(name) ? name : DEFAULT_THEME
  doc.documentElement.dataset.theme = theme
  return theme
}
