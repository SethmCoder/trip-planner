/** Optional Google Maps / Places — only active when a Vite key is present. */

export const GOOGLE_MAPS_API_KEY =
  (typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_GOOGLE_MAPS_API_KEY) || ''

export const isGoogleMapsEnabled = (): boolean => Boolean(GOOGLE_MAPS_API_KEY?.trim())

let placesScriptPromise: Promise<void> | null = null

/** Load the Maps JavaScript API with Places library (once). */
export function loadGoogleMapsScript(): Promise<void> {
  if (!isGoogleMapsEnabled()) return Promise.reject(new Error('Google Maps key not configured'))
  if (typeof window !== 'undefined' && (window as any).google?.maps?.places) return Promise.resolve()
  if (placesScriptPromise) return placesScriptPromise
  placesScriptPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector('script[data-travel-log-gmaps]')
    if (existing) {
      existing.addEventListener('load', () => resolve())
      existing.addEventListener('error', () => reject(new Error('Google Maps failed to load')))
      return
    }
    const s = document.createElement('script')
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(GOOGLE_MAPS_API_KEY)}&libraries=places`
    s.async = true
    s.dataset.travelLogGmaps = '1'
    s.onload = () => resolve()
    s.onerror = () => reject(new Error('Google Maps failed to load'))
    document.head.appendChild(s)
  })
  return placesScriptPromise
}

export interface GooglePlaceResult {
  placeId: string
  name: string
  address: string
  lat: number
  lng: number
}

/** Text places via Google Places Textbox when key is present. */
export async function googlePlacesSearch(query: string, near?: { lat: number; lng: number }): Promise<GooglePlaceResult[]> {
  if (!query.trim() || !isGoogleMapsEnabled()) return []
  await loadGoogleMapsScript()
  const g = (window as any).google
  const service = new g.maps.places.PlacesService(document.createElement('div'))
  const request: Record<string, unknown> = { query: query.trim(), fields: ['place_id', 'name', 'formatted_address', 'geometry'] }
  if (near) {
    request.location = new g.maps.LatLng(near.lat, near.lng)
    request.radius = 50000
  }
  return new Promise(resolve => {
    service.textSearch(request, (results: any[] | null, status: string) => {
      if (status !== g.maps.places.PlacesServiceStatus.OK || !results) {
        resolve([])
        return
      }
      resolve(
        results.slice(0, 8).map(r => ({
          placeId: r.place_id,
          name: r.name || '',
          address: r.formatted_address || '',
          lat: r.geometry?.location?.lat?.() ?? 0,
          lng: r.geometry?.location?.lng?.() ?? 0,
        })),
      )
    })
  })
}

/** Nearby restaurants/attractions via Google Places. */
export async function googleNearbyPois(
  lat: number,
  lng: number,
  type: 'restaurant' | 'tourist_attraction' = 'tourist_attraction',
): Promise<GooglePlaceResult[]> {
  if (!isGoogleMapsEnabled()) return []
  await loadGoogleMapsScript()
  const g = (window as any).google
  const service = new g.maps.places.PlacesService(document.createElement('div'))
  return new Promise(resolve => {
    service.nearbySearch(
      { location: new g.maps.LatLng(lat, lng), radius: 2500, type },
      (results: any[] | null, status: string) => {
        if (status !== g.maps.places.PlacesServiceStatus.OK || !results) {
          resolve([])
          return
        }
        resolve(
          results.slice(0, 12).map(r => ({
            placeId: r.place_id,
            name: r.name || '',
            address: r.vicinity || '',
            lat: r.geometry?.location?.lat?.() ?? 0,
            lng: r.geometry?.location?.lng?.() ?? 0,
          })),
        )
      },
    )
  })
}
