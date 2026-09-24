import { Link, Navigate, NavLink, Route, Routes } from 'react-router-dom'
import { RegisterPage } from './routes/RegisterPage'
import { DashboardPage } from './routes/DashboardPage'
import { SendPage } from './routes/SendPage'

export function App() {
  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Veil</p>
          <h1>Electron desktop wallet</h1>
        </div>
        <nav className="nav">
          <NavLink to="/register">Register</NavLink>
          <NavLink to="/dashboard">Dashboard</NavLink>
          <NavLink to="/send">Send</NavLink>
        </nav>
      </header>

      <div className="notice warning" style={{ marginTop: 20, marginBottom: -8, fontSize: '0.85rem', lineHeight: 1.5 }}>
        <strong style={{ color: '#fdda24' }}>⚠️ Demonstration only — not production-safe:</strong>{' '}
        This app stores a delegated transaction signer secret (<code>veil_signer_secret</code>) in plaintext renderer <code>localStorage</code>. Any script in the renderer context or local file access can extract it. Production Electron apps must protect signer credentials using OS-level encrypted storage (e.g. Electron <code>safeStorage</code>) or hardware keystores.
      </div>

      <main className="content">
        <Routes>
          <Route path="/" element={<Navigate to="/register" replace />} />
          <Route path="/register" element={<RegisterPage />} />
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/send" element={<SendPage />} />
        </Routes>
      </main>

      <footer className="footer">
        <Link to="/register">Start with registration</Link>
        <span>Passkey wallet — Electron renderer example</span>
      </footer>
    </div>
  )
}
