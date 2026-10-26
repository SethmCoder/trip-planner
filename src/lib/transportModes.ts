/** Shared transport mode options for transit items and between-stop gaps. */

export const TRANSIT_MODES = [
  { value: 'Airplane', label: 'Airplane', icon: '✈️' },
  { value: 'Train', label: 'Train', icon: '🚄' },
  { value: 'Driving', label: 'Driving', icon: '🚗' },
  { value: 'Bus', label: 'Bus', icon: '🚌' },
  { value: 'Walking', label: 'Walking', icon: '🚶' },
  { value: 'Public Transit', label: 'Public transit', icon: '🚇' },
  { value: 'Ferry', label: 'Ferry', icon: '⛴️' },
] as const

export type TransitModeValue = (typeof TRANSIT_MODES)[number]['value']

export const GAP_MODES = TRANSIT_MODES

export function modeIcon(mode: string): string {
  const m = (mode || '').toLowerCase()
  if (/air|flight|plane|fly/.test(m)) return '✈️'
  if (/train|rail|shinkansen/.test(m)) return '🚄'
  if (/walk|foot|hike/.test(m)) return '🚶'
  if (/bus|coach/.test(m)) return '🚌'
  if (/ferry|boat|ship/.test(m)) return '⛴️'
  if (/transit|metro|subway|tram/.test(m)) return '🚇'
  if (/car|driv|taxi/.test(m)) return '🚗'
  return '➡️'
}

export function modeLabel(mode: string): string {
  const found = TRANSIT_MODES.find(t => t.value.toLowerCase() === (mode || '').toLowerCase())
  return found?.label || mode || 'Travel'
}

/** Distinct colors for each trip day on the map. */
export const DAY_COLORS = [
  '#F97316', // orange
  '#2563EB', // blue
  '#059669', // green
  '#7C3AED', // purple
  '#DB2777', // pink
  '#0891B2', // cyan
  '#D97706', // amber
  '#4F46E5', // indigo
]

export function dayColor(dayIndex: number): string {
  return DAY_COLORS[((dayIndex % DAY_COLORS.length) + DAY_COLORS.length) % DAY_COLORS.length]
}
