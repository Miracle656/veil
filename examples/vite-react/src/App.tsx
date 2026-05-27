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
          <h1>Vite + React starter</h1>
        </div>
        <nav className="nav">
          <NavLink to="/register">Register</NavLink>
          <NavLink to="/dashboard">Dashboard</NavLink>
          <NavLink to="/send">Send</NavLink>
        </nav>
      </header>

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
        <span>Passkey wallet starter example</span>
      </footer>
    </div>
  )
}
