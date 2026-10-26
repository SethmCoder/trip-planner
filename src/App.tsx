import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { Analytics } from '@vercel/analytics/react'
import { AuthProvider, useAuth } from './context/AuthContext'
import LoginPage from './pages/LoginPage'
import CreateAccountPage from './pages/CreateAccountPage'
import MainPage from './pages/MainPage'
import TripPage from './pages/TripPage'
import SettingsPage from './pages/SettingsPage'
import SavedPlacesPage from './pages/SavedPlacesPage'
import ResetPasswordPage from './pages/ResetPasswordPage'
import ErrorBoundary from './components/ErrorBoundary'
function Protected({ children }: { children: JSX.Element }) { const { profile, loading } = useAuth(); if (loading) return <p style={{ padding: 24 }}>Loading…</p>; return profile ? children : <Navigate to="/login" replace /> }
export default function App() { return <AuthProvider><ErrorBoundary><BrowserRouter><Routes>
  <Route path="/login" element={<LoginPage />} /><Route path="/create-account" element={<CreateAccountPage />} /><Route path="/reset-password" element={<ResetPasswordPage />} />
  <Route path="/" element={<Protected><MainPage /></Protected>} /><Route path="/trip/:id" element={<Protected><TripPage /></Protected>} /><Route path="/saved" element={<Protected><SavedPlacesPage /></Protected>} /><Route path="/settings" element={<Protected><SettingsPage /></Protected>} />
  <Route path="*" element={<Navigate to="/" replace />} />
</Routes></BrowserRouter></ErrorBoundary><Analytics /></AuthProvider> }
