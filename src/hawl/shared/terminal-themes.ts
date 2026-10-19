import type { TerminalThemeMap } from '../../shared/terminal-themes/types'

export const HAWL_TERMINAL_THEME_DARK = 'Hawl Ember'
export const HAWL_TERMINAL_THEME_LIGHT = 'Hawl Daylight'

// Palettes from Hawl's tokens (hawl-tokens.css): coal ground, cream ink, flame cursor.
export const HAWL_TERMINAL_THEMES: TerminalThemeMap = {
  [HAWL_TERMINAL_THEME_DARK]: {
    background: '#0b0502',
    foreground: '#ffe8d6',
    cursor: '#ff7a2a',
    cursorAccent: '#0b0502',
    selectionBackground: '#6b3414',
    selectionForeground: '#fff3ea',
    black: '#1e140f',
    red: '#ff6b57',
    green: '#3fd884',
    yellow: '#ffc24a',
    blue: '#6fa2ff',
    magenta: '#ff6fa8',
    cyan: '#3fd0e0',
    white: '#e0b79c',
    brightBlack: '#7a6354',
    brightRed: '#ff9c8a',
    brightGreen: '#8cf5b8',
    brightYellow: '#ffd27a',
    brightBlue: '#9ec0ff',
    brightMagenta: '#ff9cc4',
    brightCyan: '#7fe3ee',
    brightWhite: '#fff3ea'
  },
  [HAWL_TERMINAL_THEME_LIGHT]: {
    background: '#fcf6e7',
    foreground: '#2b2318',
    cursor: '#c64a0e',
    cursorAccent: '#fcf6e7',
    selectionBackground: '#fbd9bb',
    selectionForeground: '#14243a',
    black: '#14243a',
    red: '#a6291a',
    green: '#3f6a06',
    yellow: '#8a5200',
    blue: '#1a5c96',
    magenta: '#a02a62',
    cyan: '#0b6b78',
    white: '#4a5c73',
    brightBlack: '#374a62',
    brightRed: '#c4301c',
    brightGreen: '#2f5a05',
    brightYellow: '#6d4100',
    brightBlue: '#124a7c',
    brightMagenta: '#7e1f4c',
    brightCyan: '#07525c',
    brightWhite: '#14243a'
  }
}
