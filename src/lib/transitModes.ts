/** Canonical transit modes for the dropdown. */

export const TRANSIT_MODES = [
  { value: 'Airplane', label: 'Airplane', icon: '✈️' },
  { value: 'Train', label: 'Train', icon: '🚆' },
  { value: 'Bus', label: 'Bus', icon: '🚌' },
  { value: 'Car', label: 'Driving', icon: '🚗' },
  { value: 'Walking', label: 'Walking', icon: '🚶' },
  { value: 'Ferry', label: 'Ferry', icon: '⛴️' },
  { value: 'Public Transit', label: 'Public transit', icon: '🚇' },
] as const

export type TransitModeValue = (typeof TRANSIT_MODES)[number]['value']

export function normalizeTransitMode(mode: string | null | undefined): string {
  const m = (mode || '').trim()
  if (!m) return 'Airplane'
  const hit = TRANSIT_MODES.find(t => t.value.toLowerCase() === m.toLowerCase())
  if (hit) return hit.value
  if (/air|flight|plane|fly/i.test(m)) return 'Airplane'
  if (/train|rail|shinkansen|jr/i.test(m)) return 'Train'
  if (/bus|coach/i.test(m)) return 'Bus'
  if (/walk|foot|hike/i.test(m)) return 'Walking'
  if (/ferry|boat|ship/i.test(m)) return 'Ferry'
  if (/car|drive|taxi|uber|lyft/i.test(m)) return 'Car'
  if (/transit|metro|subway|tram/i.test(m)) return 'Public Transit'
  return m
}

export function isTrainMode(mode: string) {
  return /train|rail|shinkansen|jr/i.test(mode || '')
}
