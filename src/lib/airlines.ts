/** Common airlines for award-search preferred-airline combobox. */

export interface AirlineOption {
  id: string
  name: string
  iata?: string
}

export const AIRLINES: AirlineOption[] = [
  { id: 'any', name: 'Any airline' },
  { id: 'UA', name: 'United Airlines', iata: 'UA' },
  { id: 'AA', name: 'American Airlines', iata: 'AA' },
  { id: 'DL', name: 'Delta Air Lines', iata: 'DL' },
  { id: 'AS', name: 'Alaska Airlines', iata: 'AS' },
  { id: 'B6', name: 'JetBlue', iata: 'B6' },
  { id: 'WN', name: 'Southwest Airlines', iata: 'WN' },
  { id: 'AC', name: 'Air Canada', iata: 'AC' },
  { id: 'BA', name: 'British Airways', iata: 'BA' },
  { id: 'VS', name: 'Virgin Atlantic', iata: 'VS' },
  { id: 'AF', name: 'Air France', iata: 'AF' },
  { id: 'KL', name: 'KLM', iata: 'KL' },
  { id: 'LH', name: 'Lufthansa', iata: 'LH' },
  { id: 'LX', name: 'Swiss', iata: 'LX' },
  { id: 'OS', name: 'Austrian', iata: 'OS' },
  { id: 'SN', name: 'Brussels Airlines', iata: 'SN' },
  { id: 'IB', name: 'Iberia', iata: 'IB' },
  { id: 'AY', name: 'Finnair', iata: 'AY' },
  { id: 'SK', name: 'SAS', iata: 'SK' },
  { id: 'TP', name: 'TAP Air Portugal', iata: 'TP' },
  { id: 'EI', name: 'Aer Lingus', iata: 'EI' },
  { id: 'TK', name: 'Turkish Airlines', iata: 'TK' },
  { id: 'QR', name: 'Qatar Airways', iata: 'QR' },
  { id: 'EK', name: 'Emirates', iata: 'EK' },
  { id: 'EY', name: 'Etihad Airways', iata: 'EY' },
  { id: 'SQ', name: 'Singapore Airlines', iata: 'SQ' },
  { id: 'CX', name: 'Cathay Pacific', iata: 'CX' },
  { id: 'NH', name: 'ANA', iata: 'NH' },
  { id: 'JL', name: 'Japan Airlines', iata: 'JL' },
  { id: 'KE', name: 'Korean Air', iata: 'KE' },
  { id: 'OZ', name: 'Asiana Airlines', iata: 'OZ' },
  { id: 'CI', name: 'China Airlines', iata: 'CI' },
  { id: 'BR', name: 'EVA Air', iata: 'BR' },
  { id: 'CA', name: 'Air China', iata: 'CA' },
  { id: 'MU', name: 'China Eastern', iata: 'MU' },
  { id: 'CZ', name: 'China Southern', iata: 'CZ' },
  { id: 'QF', name: 'Qantas', iata: 'QF' },
  { id: 'NZ', name: 'Air New Zealand', iata: 'NZ' },
  { id: 'VA', name: 'Virgin Australia', iata: 'VA' },
  { id: 'HA', name: 'Hawaiian Airlines', iata: 'HA' },
  { id: 'AV', name: 'Avianca', iata: 'AV' },
  { id: 'LA', name: 'LATAM', iata: 'LA' },
  { id: 'AM', name: 'Aeromexico', iata: 'AM' },
  { id: 'CM', name: 'Copa Airlines', iata: 'CM' },
  { id: 'ET', name: 'Ethiopian Airlines', iata: 'ET' },
  { id: 'SA', name: 'South African Airways', iata: 'SA' },
  { id: 'MS', name: 'EgyptAir', iata: 'MS' },
  { id: 'RJ', name: 'Royal Jordanian', iata: 'RJ' },
  { id: 'AI', name: 'Air India', iata: 'AI' },
  { id: 'TG', name: 'Thai Airways', iata: 'TG' },
  { id: 'VN', name: 'Vietnam Airlines', iata: 'VN' },
  { id: 'PR', name: 'Philippine Airlines', iata: 'PR' },
  { id: 'MH', name: 'Malaysia Airlines', iata: 'MH' },
  { id: 'GA', name: 'Garuda Indonesia', iata: 'GA' },
  { id: 'FJ', name: 'Fiji Airways', iata: 'FJ' },
].sort((a, b) => (a.id === 'any' ? -1 : b.id === 'any' ? 1 : a.name.localeCompare(b.name)))

export function searchAirlines(query: string, limit = 20): AirlineOption[] {
  const q = query.trim().toLowerCase()
  if (!q) return AIRLINES.slice(0, limit)
  return AIRLINES.filter(a => {
    const name = a.name.toLowerCase()
    const id = a.id.toLowerCase()
    const iata = (a.iata || '').toLowerCase()
    return name.includes(q) || id.includes(q) || iata.includes(q)
  }).slice(0, limit)
}

export function formatAirlineOption(a: AirlineOption): string {
  if (a.id === 'any') return a.name
  return a.iata ? `${a.name} (${a.iata})` : a.name
}
