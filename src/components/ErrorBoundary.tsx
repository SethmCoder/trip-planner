import { Component, type ReactNode } from 'react'

export default class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) { return { error } }
  componentDidCatch(error: Error) { console.error(error) }
  render() {
    if (this.state.error) {
      return (
        <div style={{ minHeight: '100vh', background: 'var(--white)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
          <div style={{ width: 440, maxWidth: '94vw', border: '1px solid var(--black)', borderRadius: 16, overflow: 'hidden' }}>
            <div style={{ background: 'var(--orange)', color: 'var(--white)', padding: '14px 20px', fontWeight: 800, fontSize: 20 }}>The Travel Log</div>
            <div style={{ padding: 22 }}>
              <h2 style={{ marginTop: 0, color: 'var(--slate-800)' }}>Something went wrong</h2>
              <p style={{ fontSize: 14 }}>This page hit an error instead of loading. Your saved trips are stored safely and have not been lost.</p>
              <p style={{ fontSize: 12, color: '#c00', wordBreak: 'break-word' }}>{this.state.error.message}</p>
              <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
                <button className="btn-orange" style={{ flex: 1 }} onClick={() => { this.setState({ error: null }); window.location.href = '/' }}>Go to Main Page</button>
                <button className="btn-outline" style={{ flex: 1 }} onClick={() => window.location.reload()}>Reload</button>
              </div>
            </div>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
