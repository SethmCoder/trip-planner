import type { Profile } from './types'

/** Master gate: Advanced settings on. Basic mode disables all Advanced features. */
export function isAdvancedEnabled(profile: Profile | null | undefined): boolean {
  return profile?.settings_mode === 'advanced'
}

/** Suggest itinerary is available whenever Advanced is on (master slider). */
export function canUseAiSuggest(profile: Profile | null | undefined): boolean {
  return isAdvancedEnabled(profile)
}

export function canUseAiEmail(profile: Profile | null | undefined): boolean {
  return isAdvancedEnabled(profile) && profile?.feature_ai_email !== false
}

export function canUseAwardFlights(profile: Profile | null | undefined): boolean {
  return isAdvancedEnabled(profile)
}
