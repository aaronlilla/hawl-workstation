// Why: only the initial value shown in Settings; buildFontFamily() adds the real cross-platform fallback chain.
export function defaultTerminalFontFamily(): string {
  // Hawl: the F15 type system uses JetBrains Mono for terminals on every platform; the font ships with the app.
  return 'Hawl JetBrains Mono'
}

export const getDefaultPrimarySelectionMiddleClickPaste = (
  platform = typeof process !== 'undefined' ? process.platform : ''
): boolean => platform === 'linux' || platform === 'darwin'

export const getDefaultTerminalRightClickToPaste = (
  platform = typeof process !== 'undefined' ? process.platform : ''
): boolean => platform === 'win32'
