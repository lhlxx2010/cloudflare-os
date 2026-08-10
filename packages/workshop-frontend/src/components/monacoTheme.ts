/**
 * Shared Monaco theme + monospace font stack used by both CodeEditor (full
 * editing surface) and CodeDiffEditor (read-mostly unified-diff renderer).
 *
 * Monaco renders into its own DOM that doesn't reliably inherit the page's
 * `--font-mono` CSS variable, so editor instances pass `monoFont` as an
 * explicit option. The CSS in CodeDiffEditor's view zones is in the same
 * boat — Monaco view zone DOM nodes don't pick up our body font either.
 *
 * The theme itself is shared because the diff editor and the regular editor
 * should look identical when displaying the same file; the diff editor only
 * adds line-level decorations on top.
 */

import type { ResolvedThemeMode } from '../theme'

export const GADGETS_CODE_THEME_LIGHT = 'gadgets-code-light'
export const GADGETS_CODE_THEME_DARK = 'gadgets-code-dark'

export const monoFont =
  'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace'

let themesDefined = false

export function getGadgetsCodeTheme(theme: ResolvedThemeMode): string {
  return theme === 'dark' ? GADGETS_CODE_THEME_DARK : GADGETS_CODE_THEME_LIGHT
}

export function defineGadgetsCodeTheme(monaco: typeof import('monaco-editor')): void {
  if (themesDefined) return

  monaco.editor.defineTheme(GADGETS_CODE_THEME_LIGHT, {
    base: 'vs',
    inherit: true,
    rules: [
      { token: '', foreground: '1e293b' },
      { token: 'comment', foreground: '64748b', fontStyle: 'italic' },
      { token: 'keyword', foreground: '8e3aa6' },
      { token: 'storage', foreground: '8e3aa6' },
      { token: 'operator', foreground: '475569' },
      { token: 'string', foreground: '4d8a44' },
      { token: 'number', foreground: '1d4ed8' },
      { token: 'type', foreground: '1d4ed8' },
      { token: 'class', foreground: '1d4ed8' },
      { token: 'interface', foreground: '1d4ed8' },
      { token: 'function', foreground: '3a72c9' },
      { token: 'variable', foreground: '1e293b' },
      { token: 'variable.predefined', foreground: '3a72c9' },
      { token: 'constant', foreground: '1d4ed8' },
      { token: 'delimiter', foreground: '475569' },
      { token: 'tag', foreground: '1d4ed8' },
      { token: 'attribute.name', foreground: '1d4ed8' },
      { token: 'attribute.value', foreground: '4d8a44' },
    ],
    colors: {
      'editor.background': '#f8fafc',
      'editor.foreground': '#1e293b',
      'editorLineNumber.foreground': '#94a3b8',
      'editorLineNumber.activeForeground': '#475569',
      'editorCursor.foreground': '#1e293b',
      'editor.selectionBackground': '#b3d4ff',
      'editor.inactiveSelectionBackground': '#dbe6f5',
      'editor.selectionHighlightBackground': '#cee0fa',
      'editor.wordHighlightBackground': '#cee0fa',
      'editor.wordHighlightStrongBackground': '#b3d4ff',
      'editor.lineHighlightBackground': '#00000000',
      'editor.lineHighlightBorder': '#00000000',
      'editorGutter.background': '#f8fafc',
      'editorIndentGuide.background1': '#e2e8f0',
      'editorIndentGuide.activeBackground1': '#cbd5e1',
      'editorWhitespace.foreground': '#e2e8f0',
      'editorOverviewRuler.border': '#00000000',
      'scrollbarSlider.background': '#94a3b833',
      'scrollbarSlider.hoverBackground': '#64748b55',
      'scrollbarSlider.activeBackground': '#47556977',
    },
  })

  monaco.editor.defineTheme(GADGETS_CODE_THEME_DARK, {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: '', foreground: 'e8e6f0' },
      { token: 'comment', foreground: '858396', fontStyle: 'italic' },
      { token: 'keyword', foreground: 'd8b4fe' },
      { token: 'storage', foreground: 'd8b4fe' },
      { token: 'operator', foreground: 'b9b5c8' },
      { token: 'string', foreground: '86efac' },
      { token: 'number', foreground: '60a5fa' },
      { token: 'type', foreground: '60a5fa' },
      { token: 'class', foreground: '60a5fa' },
      { token: 'interface', foreground: '60a5fa' },
      { token: 'function', foreground: '93c5fd' },
      { token: 'variable', foreground: 'e8e6f0' },
      { token: 'variable.predefined', foreground: '93c5fd' },
      { token: 'constant', foreground: '60a5fa' },
      { token: 'delimiter', foreground: 'b9b5c8' },
      { token: 'tag', foreground: 'fca5a5' },
      { token: 'attribute.name', foreground: '60a5fa' },
      { token: 'attribute.value', foreground: '86efac' },
    ],
    colors: {
      'editor.background': '#16151f',
      'editor.foreground': '#e8e6f0',
      'editorLineNumber.foreground': '#6d6880',
      'editorLineNumber.activeForeground': '#b9b5c8',
      'editorCursor.foreground': '#e8e6f0',
      'editor.selectionBackground': '#4b3d66',
      'editor.inactiveSelectionBackground': '#352f4a',
      'editor.selectionHighlightBackground': '#352f4a',
      'editor.wordHighlightBackground': '#352f4a',
      'editor.wordHighlightStrongBackground': '#4b3d66',
      'editor.lineHighlightBackground': '#00000000',
      'editor.lineHighlightBorder': '#00000000',
      'editorGutter.background': '#16151f',
      'editorIndentGuide.background1': '#2a263b',
      'editorIndentGuide.activeBackground1': '#423a5f',
      'editorWhitespace.foreground': '#332d4d',
      'editorOverviewRuler.border': '#00000000',
      'scrollbarSlider.background': '#4b465f66',
      'scrollbarSlider.hoverBackground': '#5d587399',
      'scrollbarSlider.activeBackground': '#746d8fcc',
    },
  })

  themesDefined = true
}
