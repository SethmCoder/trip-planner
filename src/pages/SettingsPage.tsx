import { useState } from 'react'
import TopBar from '../components/TopBar'
import { useAuth } from '../context/AuthContext'
import * as api from '../lib/data'
import { bookingForwardAddress } from '../lib/aiClient'
import { BOOKING_APPS } from '../lib/awards'
import { isGoogleMapsEnabled } from '../lib/googleConfig'
import { LANGUAGE_OPTIONS, type DisplayLanguage, type SettingsMode } from '../lib/types'
import { requestBrowserNotifyPermission } from '../lib/notifications'

const PRESETS = ['✈️', '🧳', '🗺️', '🌍', '🏖️', '⛰️', '🚆', '📸'].map((e, i) => ({
  e,
  url: `https://api.dicebear.com/9.x/adventurer/svg?seed=travel${i}`,
}))

export default function SettingsPage() {
  const { profile, setProfile } = useAuth()
  const [mode, setMode] = useState<SettingsMode>(profile?.settings_mode === 'advanced' ? 'advanced' : 'basic')
  const [username, setUsername] = useState(profile?.username ?? '')
  const [email, setEmail] = useState(profile?.email ?? '')
  const [origPw, setOrigPw] = useState('')
  const [origPw2, setOrigPw2] = useState('')
  const [newPw, setNewPw] = useState('')
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')
  const [drag, setDrag] = useState(false)
  const [alerts, setAlerts] = useState(profile?.booking_alerts_enabled !== false)
  const [awardAlerts, setAwardAlerts] = useState(profile?.award_alerts_enabled !== false)
  const [bookingApps, setBookingApps] = useState<string[]>(profile?.preferred_booking_apps ?? ['roame', 'google_flights'])
  const [lang, setLang] = useState<string>(profile?.preferred_language || 'en')
  const [aiEmail, setAiEmail] = useState(Boolean(profile?.feature_ai_email))
  const [aiSuggest, setAiSuggest] = useState(Boolean(profile?.feature_ai_suggest))
  const [copied, setCopied] = useState(false)

  if (!profile) return null

  const flash = (m: string) => { setMsg(m); setErr('') }
  const forwardAddr = bookingForwardAddress(profile.forwarding_token)

  const switchMode = async (next: SettingsMode) => {
    setMode(next)
    try {
      // Master slider: Advanced off disables flight booker, Suggest itinerary, and Gmail reading.
      const patch = next === 'advanced'
        ? { settings_mode: next as SettingsMode, feature_ai_suggest: true, feature_ai_email: aiEmail || true }
        : { settings_mode: next as SettingsMode }
      if (next === 'advanced') {
        setAiSuggest(true)
        setAiEmail(true)
      }
      setProfile(await api.updateProfile(profile, patch))
      flash(
        next === 'advanced'
          ? 'Advanced on — Award Flights, Suggest itinerary, and Gmail reading are available.'
          : 'Advanced off — Award Flights, Suggest itinerary, and Gmail reading are disabled.',
      )
    } catch (x: any) {
      setErr(x.message)
    }
  }

  const saveIdentity = async (e: React.FormEvent) => {
    e.preventDefault()
    try {
      if (!(await api.verifyPassword(profile, origPw))) throw new Error('Original password is incorrect')
      setProfile(await api.updateProfile(profile, { username, email }))
      flash('Username/email updated.')
    } catch (x: any) {
      setErr(x.message)
    }
  }

  const savePassword = async (e: React.FormEvent) => {
    e.preventDefault()
    try {
      if (!(await api.verifyPassword(profile, origPw2))) throw new Error('Original password is incorrect')
      if (newPw.length < 6) throw new Error('New password must be at least 6 characters')
      setProfile(await api.updateProfile(profile, { newPassword: newPw }))
      setNewPw('')
      setOrigPw2('')
      flash('Password changed.')
    } catch (x: any) {
      setErr(x.message)
    }
  }

  const handleFile = async (f: File | undefined) => {
    if (!f) return
    try {
      const url = await api.uploadAvatar(profile, f)
      setProfile(await api.updateProfile(profile, { avatar_url: url }))
      flash('Avatar updated.')
    } catch (x: any) {
      setErr(x.message)
    }
  }

  const saveBasicPrefs = async () => {
    try {
      const next = await api.updateProfile(profile, {
        booking_alerts_enabled: alerts,
        preferred_language: lang as DisplayLanguage,
        award_alerts_enabled: awardAlerts,
        preferred_booking_apps: bookingApps,
      })
      setProfile(next)
      if (alerts || awardAlerts) {
        const perm = await requestBrowserNotifyPermission()
        if (perm === 'denied') {
          flash('Preferences saved. Browser notifications are blocked — you’ll still see alerts in the app.')
          return
        }
      }
      flash('Preferences saved.')
    } catch (x: any) {
      setErr(x.message)
    }
  }

  const saveAdvanced = async () => {
    try {
      let p = profile
      if (!p.forwarding_token) {
        p = await api.regenerateForwardingToken(p)
      }
      const next = await api.updateProfile(p, {
        feature_ai_email: aiEmail,
        feature_ai_suggest: aiSuggest,
        settings_mode: 'advanced',
      })
      setProfile(next)
      flash('Advanced AI settings saved.')
    } catch (x: any) {
      setErr(x.message)
    }
  }

  const copyForward = async () => {
    try {
      await navigator.clipboard.writeText(forwardAddr)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      setErr('Could not copy — select the address manually.')
    }
  }

  const regenToken = async () => {
    try {
      const next = await api.regenerateForwardingToken(profile)
      setProfile(next)
      flash('Forwarding address regenerated. Update any filters that used the old address.')
    } catch (x: any) {
      setErr(x.message)
    }
  }

  const toggleApp = (id: string) => {
    setBookingApps(prev => (prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]))
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100vh' }}>
      <TopBar />
      <main style={{ maxWidth: 760, width: '94vw', margin: '24px auto', display: 'flex', flexDirection: 'column', gap: 18 }}>
        <h1 style={{ margin: 0, fontSize: '1.75rem', fontWeight: 700, color: 'var(--slate-800)' }}>Settings</h1>

        <section className="panel">
          <h3 style={{ marginTop: 0 }}>Advanced features</h3>
          <p className="places-hint" style={{ marginTop: 0 }}>
            Master switch for Award Flights (flight booker), Suggest itinerary on trips, and Gmail booking-email reading.
            Friends and core trip planning stay available either way.
          </p>
          <label className="places-toggle" style={{ justifyContent: 'space-between', width: '100%' }}>
            <span>{mode === 'advanced' ? 'Advanced on' : 'Advanced off (Basic)'}</span>
            <span className="toggle">
              <input
                type="checkbox"
                checked={mode === 'advanced'}
                onChange={e => switchMode(e.target.checked ? 'advanced' : 'basic')}
              />
              <span className="slider" />
            </span>
          </label>
        </section>

        {mode === 'basic' && (
          <>
            <section className="panel">
              <h3 style={{ marginTop: 0 }}>Notifications</h3>
              <p className="places-hint" style={{ marginTop: 0 }}>
                When an itinerary item has a booking-window open date and that day arrives, you’ll get an alert
                in the app (and as a browser notification if allowed).
              </p>
              <label className="places-toggle" style={{ justifyContent: 'space-between', width: '100%' }}>
                <span>Booking window alerts</span>
                <span className="toggle">
                  <input type="checkbox" checked={alerts} onChange={e => setAlerts(e.target.checked)} />
                  <span className="slider" />
                </span>
              </label>
              <label className="places-toggle" style={{ justifyContent: 'space-between', width: '100%', marginTop: 12 }}>
                <span>Award flight alerts</span>
                <span className="toggle">
                  <input type="checkbox" checked={awardAlerts} onChange={e => setAwardAlerts(e.target.checked)} />
                  <span className="slider" />
                </span>
              </label>
            </section>

            <section className="panel">
              <h3 style={{ marginTop: 0 }}>Award booking apps</h3>
              <p className="places-hint" style={{ marginTop: 0 }}>
                Preferred apps for finishing award bookings (deep links from the Flights page).
              </p>
              <div className="booking-app-checks">
                {BOOKING_APPS.map(app => (
                  <label key={app.id} className="checkbox-square-label">
                    <input
                      type="checkbox"
                      className="checkbox-square"
                      checked={bookingApps.includes(app.id)}
                      onChange={() => toggleApp(app.id)}
                    />
                    <span>{app.label}</span>
                  </label>
                ))}
              </div>
            </section>

            <section className="panel">
              <h3 style={{ marginTop: 0 }}>Display language</h3>
              <p className="places-hint" style={{ marginTop: 0 }}>
                Place and item names are translated into this language when shown on trip cards and lists.
              </p>
              <label htmlFor="pref-lang">Language for place names</label>
              <select id="pref-lang" value={lang} onChange={e => setLang(e.target.value)}>
                {LANGUAGE_OPTIONS.map(o => (
                  <option key={o.code} value={o.code}>{o.label}</option>
                ))}
              </select>
              <button type="button" className="btn-orange" style={{ marginTop: 14 }} onClick={saveBasicPrefs}>
                Save preferences
              </button>
            </section>

            <section className="panel">
              <h3 style={{ marginTop: 0 }}>Google Saved Places</h3>
              <p className="places-hint" style={{ marginTop: 0 }}>
                {isGoogleMapsEnabled()
                  ? 'A Google Maps API key is configured. Connect your Google account from Saved Places to import bookmarks (OAuth is optional and separate from Advanced AI).'
                  : 'Add VITE_GOOGLE_MAPS_API_KEY to enable Google Places search and optional Saved Places import. Without it, maps stay on OpenStreetMap.'}
              </p>
              <p className="places-hint" style={{ margin: 0 }}>
                Status: {profile.google_places_connected ? 'Connected' : 'Not connected'}
              </p>
            </section>

            <section className="panel">
              <h3 style={{ marginTop: 0 }}>Avatar</h3>
              <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
                {profile.avatar_url
                  ? <img src={profile.avatar_url} alt="" style={{ width: 80, height: 80, borderRadius: '50%', objectFit: 'cover', border: '2px solid var(--border)' }} />
                  : <span style={{ width: 80, height: 80, borderRadius: '50%', background: 'var(--slate-500)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: 32 }}>{profile.username[0]?.toUpperCase()}</span>}
                <div
                  onDragOver={e => { e.preventDefault(); setDrag(true) }}
                  onDragLeave={() => setDrag(false)}
                  onDrop={e => { e.preventDefault(); setDrag(false); handleFile(e.dataTransfer.files[0]) }}
                  onClick={() => document.getElementById('avatar-file')?.click()}
                  style={{ flex: 1, border: `2px dashed ${drag ? 'var(--orange)' : 'var(--border)'}`, borderRadius: 'var(--radius-md)', padding: 20, textAlign: 'center', cursor: 'pointer', background: 'var(--orange-50)' }}
                >
                  Drag &amp; drop your own avatar here, or click to browse
                  <input id="avatar-file" type="file" accept="image/*" hidden onChange={e => handleFile(e.target.files?.[0])} />
                </div>
              </div>
              <label>Common Pictures</label>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                {PRESETS.map(p => (
                  <button
                    key={p.url}
                    type="button"
                    title={p.e}
                    onClick={async () => {
                      setProfile(await api.updateProfile(profile, { avatar_url: p.url }))
                      flash('Avatar updated.')
                    }}
                    style={{ border: profile.avatar_url === p.url ? '3px solid var(--orange)' : '1px solid var(--border)', borderRadius: '50%', padding: 2, background: '#fff' }}
                  >
                    <img src={p.url} alt="" style={{ width: 52, height: 52, borderRadius: '50%' }} />
                  </button>
                ))}
              </div>
            </section>

            <section className="panel">
              <h3 style={{ marginTop: 0 }}>Change Username &amp; Email</h3>
              <form onSubmit={saveIdentity}>
                <label>New Username</label>
                <input value={username} onChange={e => setUsername(e.target.value)} required />
                <label>New Email</label>
                <input type="email" value={email} onChange={e => setEmail(e.target.value)} required />
                <label>Original Password (required)</label>
                <input type="password" value={origPw} onChange={e => setOrigPw(e.target.value)} required />
                <button className="btn-orange" style={{ marginTop: 14 }}>Save Username / Email</button>
              </form>
            </section>

            <section className="panel">
              <h3 style={{ marginTop: 0 }}>Change Password</h3>
              <form onSubmit={savePassword}>
                <label>Original Password (required)</label>
                <input type="password" value={origPw2} onChange={e => setOrigPw2(e.target.value)} required />
                <label>New Password</label>
                <input type="password" value={newPw} onChange={e => setNewPw(e.target.value)} required minLength={6} />
                <button className="btn-orange" style={{ marginTop: 14 }}>Change Password</button>
              </form>
            </section>
          </>
        )}

        {mode === 'advanced' && (
          <>
            <section className="panel">
              <h3 style={{ marginTop: 0 }}>Advanced details</h3>
              <p className="places-hint" style={{ marginTop: 0 }}>
                With Advanced on: use <strong>Suggest itinerary</strong> on trip pages, <strong>Award Flights</strong> in the avatar menu,
                and optional Gmail forwarding below. Server secrets: <code>GROQ_API_KEY</code>, Gmail OAuth, optional <code>SEATS_AERO_API_KEY</code>.
              </p>
              <label className="places-toggle" style={{ justifyContent: 'space-between', width: '100%' }}>
                <span>Gmail booking-email reading</span>
                <span className="toggle">
                  <input type="checkbox" checked={aiEmail} onChange={e => setAiEmail(e.target.checked)} />
                  <span className="slider" />
                </span>
              </label>
              <p className="places-hint" style={{ marginTop: 12, marginBottom: 0 }}>
                Suggest itinerary and Award Flights are included while this Advanced slider is on.
              </p>
              <button type="button" className="btn-orange" style={{ marginTop: 16 }} onClick={saveAdvanced}>
                Save Advanced settings
              </button>
            </section>

            <section className="panel">
              <h3 style={{ marginTop: 0 }}>Booking email forward address</h3>
              <p className="places-hint" style={{ marginTop: 0 }}>
                Forward airline/hotel confirmations to this address. Mail is polled from the shared Gmail inbox, redacted, then matched to your itinerary.
              </p>
              <div className="forward-address-box">
                <code>{forwardAddr}</code>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button type="button" className="btn-ghost" onClick={copyForward}>{copied ? 'Copied' : 'Copy'}</button>
                  <button type="button" className="btn-ghost" onClick={regenToken}>Regenerate</button>
                </div>
              </div>
              <p className="places-hint" style={{ marginBottom: 0 }}>
                Gmail connection: configured on the server via OAuth secrets (not in this browser). Status appears after <code>poll-gmail-inbox</code> is deployed.
              </p>
            </section>
          </>
        )}

        {msg && <div className="success">{msg}</div>}
        {err && <div className="error">{err}</div>}
      </main>
    </div>
  )
}
