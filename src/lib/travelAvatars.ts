/** Circular travel-symbol avatars (emoji on colored discs) — not DiceBear faces. */

function travelAvatarDataUrl(emoji: string, bg: string, label: string): string {
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128" role="img" aria-label="${label}">
  <circle cx="64" cy="64" r="64" fill="${bg}"/>
  <text x="64" y="72" text-anchor="middle" font-size="58" font-family="Apple Color Emoji, Segoe UI Emoji, Noto Color Emoji, sans-serif">${emoji}</text>
</svg>`
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

export const TRAVEL_AVATAR_PRESETS = [
  { e: '✈️', label: 'Airplane', bg: '#93C5FD' },
  { e: '🧳', label: 'Luggage', bg: '#C4B5FD' },
  { e: '🗺️', label: 'Map', bg: '#86EFAC' },
  { e: '🌍', label: 'Globe', bg: '#FDA4AF' },
  { e: '🏖️', label: 'Beach', bg: '#FCD34D' },
  { e: '⛰️', label: 'Mountain', bg: '#5EEAD4' },
  { e: '🚆', label: 'Train', bg: '#FDBA74' },
  { e: '📸', label: 'Camera', bg: '#A5B4FC' },
].map(p => ({
  e: p.e,
  label: p.label,
  url: travelAvatarDataUrl(p.e, p.bg, p.label),
}))
