import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import TopBar from '../components/TopBar'
import { useAuth } from '../context/AuthContext'
import * as api from '../lib/data'
import * as social from '../lib/social'
import type { Friendship, SavedPlace, Trip } from '../lib/types'

export default function FriendsPage() {
  const { profile } = useAuth()
  const nav = useNavigate()
  const [friends, setFriends] = useState<Friendship[]>([])
  const [pendingIn, setPendingIn] = useState<Friendship[]>([])
  const [pendingOut, setPendingOut] = useState<Friendship[]>([])
  const [query, setQuery] = useState('')
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')
  const [trips, setTrips] = useState<Trip[]>([])
  const [places, setPlaces] = useState<SavedPlace[]>([])
  const [inviteTripId, setInviteTripId] = useState('')
  const [inviteFriendId, setInviteFriendId] = useState('')
  const [sharePlaceId, setSharePlaceId] = useState('')
  const [shareFriendId, setShareFriendId] = useState('')
  const [sharedWithMe, setSharedWithMe] = useState<SavedPlace[]>([])

  const reload = async () => {
    if (!profile) return
    const all = await social.listFriendships(profile.id)
    setFriends(all.filter(f => f.status === 'accepted'))
    setPendingIn(all.filter(f => f.status === 'pending' && f.addressee_id === profile.id))
    setPendingOut(all.filter(f => f.status === 'pending' && f.requester_id === profile.id))
    setTrips(await api.listTrips(profile.id))
    setPlaces(await api.listSavedPlaces(profile.id))
    setSharedWithMe(await social.listSharedWithMe(profile.id))
  }

  useEffect(() => { reload().catch(e => setErr(e.message)) }, [profile?.id])

  if (!profile) return null

  const sendRequest = async (e: React.FormEvent) => {
    e.preventDefault()
    setErr(''); setMsg('')
    try {
      await social.sendFriendRequest(profile.id, query)
      setQuery('')
      setMsg('Friend request sent.')
      await reload()
    } catch (x: any) {
      setErr(x.message)
    }
  }

  const respond = async (id: string, accept: boolean) => {
    try {
      await social.respondFriendRequest(id, accept)
      setMsg(accept ? 'Friend added.' : 'Request declined.')
      await reload()
    } catch (x: any) {
      setErr(x.message)
    }
  }

  const invite = async () => {
    if (!inviteTripId || !inviteFriendId) return
    try {
      await social.inviteCollaborator(inviteTripId, inviteFriendId, 'editor')
      setMsg('Friend invited to edit the trip.')
    } catch (x: any) {
      setErr(x.message)
    }
  }

  const share = async () => {
    if (!sharePlaceId || !shareFriendId) return
    try {
      await social.shareSavedPlace(sharePlaceId, profile.id, shareFriendId)
      setMsg('Saved place shared.')
    } catch (x: any) {
      setErr(x.message)
    }
  }

  const friendUserId = (f: Friendship) => (f.requester_id === profile.id ? f.addressee_id : f.requester_id)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100vh' }}>
      <TopBar />
      <main style={{ maxWidth: 860, width: '94vw', margin: '24px auto', display: 'flex', flexDirection: 'column', gap: 18 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <h1 style={{ margin: 0, fontSize: '1.75rem', fontWeight: 700, color: 'var(--slate-800)' }}>Friends</h1>
          <button type="button" className="btn-ghost" onClick={() => nav('/')}>Back to Main</button>
        </div>

        <section className="panel">
          <h3 style={{ marginTop: 0 }}>Find friends</h3>
          <form onSubmit={sendRequest} style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <div style={{ flex: 1, minWidth: 180 }}>
              <label>Username</label>
              <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search by username" required />
            </div>
            <button type="submit" className="btn-orange">Send request</button>
          </form>
        </section>

        {pendingIn.length > 0 && (
          <section className="panel">
            <h3 style={{ marginTop: 0 }}>Incoming requests</h3>
            <ul className="friends-list">
              {pendingIn.map(f => (
                <li key={f.id}>
                  <span>{f.other_username || 'User'}</span>
                  <span style={{ display: 'flex', gap: 8 }}>
                    <button type="button" className="btn-orange" onClick={() => respond(f.id, true)}>Accept</button>
                    <button type="button" className="btn-ghost" onClick={() => respond(f.id, false)}>Decline</button>
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {pendingOut.length > 0 && (
          <section className="panel">
            <h3 style={{ marginTop: 0 }}>Outgoing requests</h3>
            <ul className="friends-list">
              {pendingOut.map(f => (
                <li key={f.id}><span>{f.other_username || 'User'}</span><span className="places-hint">Pending</span></li>
              ))}
            </ul>
          </section>
        )}

        <section className="panel">
          <h3 style={{ marginTop: 0 }}>Your friends</h3>
          {friends.length === 0 ? (
            <p className="places-hint" style={{ margin: 0 }}>No friends yet — send a request by username.</p>
          ) : (
            <ul className="friends-list">
              {friends.map(f => (
                <li key={f.id}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    {f.other_avatar_url
                      ? <img src={f.other_avatar_url} alt="" style={{ width: 36, height: 36, borderRadius: '50%', objectFit: 'cover' }} />
                      : <span className="avatar-fallback">{(f.other_username || '?')[0]?.toUpperCase()}</span>}
                    {f.other_username || 'Friend'}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="panel">
          <h3 style={{ marginTop: 0 }}>Invite to edit a trip</h3>
          <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}>
            <div>
              <label>Trip</label>
              <select value={inviteTripId} onChange={e => setInviteTripId(e.target.value)}>
                <option value="">Select trip</option>
                {trips.map(t => <option key={t.id} value={t.id}>{t.name || t.place || 'Untitled'}</option>)}
              </select>
            </div>
            <div>
              <label>Friend</label>
              <select value={inviteFriendId} onChange={e => setInviteFriendId(e.target.value)}>
                <option value="">Select friend</option>
                {friends.map(f => <option key={f.id} value={friendUserId(f)}>{f.other_username}</option>)}
              </select>
            </div>
          </div>
          <button type="button" className="btn-orange" style={{ marginTop: 14 }} onClick={invite} disabled={!inviteTripId || !inviteFriendId}>
            Invite as editor
          </button>
        </section>

        <section className="panel">
          <h3 style={{ marginTop: 0 }}>Share a saved place</h3>
          <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}>
            <div>
              <label>Place</label>
              <select value={sharePlaceId} onChange={e => setSharePlaceId(e.target.value)}>
                <option value="">Select place</option>
                {places.map(p => <option key={p.id} value={p.id}>{p.name || p.place_name}</option>)}
              </select>
            </div>
            <div>
              <label>Friend</label>
              <select value={shareFriendId} onChange={e => setShareFriendId(e.target.value)}>
                <option value="">Select friend</option>
                {friends.map(f => <option key={f.id} value={friendUserId(f)}>{f.other_username}</option>)}
              </select>
            </div>
          </div>
          <button type="button" className="btn-orange" style={{ marginTop: 14 }} onClick={share} disabled={!sharePlaceId || !shareFriendId}>
            Share place
          </button>
        </section>

        {sharedWithMe.length > 0 && (
          <section className="panel">
            <h3 style={{ marginTop: 0 }}>Shared with you</h3>
            <ul className="friends-list">
              {sharedWithMe.map(p => (
                <li key={p.id}><span>{p.name || p.place_name}</span></li>
              ))}
            </ul>
          </section>
        )}

        {msg && <div className="success">{msg}</div>}
        {err && <div className="error">{err}</div>}
      </main>
    </div>
  )
}
