import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.js'
import { patchWebAuthnProvider } from './tauri-webauthn.js'

async function bootstrap() {
  await patchWebAuthnProvider()
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  )
}

bootstrap()
