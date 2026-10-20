// Hawl: load the bundled F15 fonts at startup so xterm measures real glyph widths, not the fallback's.
if (typeof document !== 'undefined' && document.fonts) {
  for (const face of [
    '13px "Hawl JetBrains Mono"',
    '600 13px "Hawl Inter"',
    '700 20px "Hawl Bricolage"'
  ]) {
    void document.fonts.load(face).catch(() => undefined)
  }
}
