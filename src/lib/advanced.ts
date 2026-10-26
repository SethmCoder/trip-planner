import type { Profile } from './types'

/** Master gate: Advanced settings on. Basic mode disables all Advanced features. */
export function isAdvancedEnabled(profile: Profile | null | undefined): boolean {
  return profile?.settings_mode === 'advanced'
}

export function canUseAiSuggest(profile: Profile | null | undefined): boolean {
  return isAdvancedEnabled(profile) && Boolean(profile?.feature_ai_suggest)
}

export function canUseAiEmail(profile: Profile | null | undefined): boolean {
  return isAdvancedEnabled(profile) && Boolean(profile?.feature_ai_email)
}

export function canUseAwardFlights(profile: Profile | null | undefined): boolean {
  return isAdvancedEnabled(profile)
}
