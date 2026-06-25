const { app, BrowserWindow } = require('electron')
const path = require('node:path')
const http = require('node:http')
const fs = require('node:fs')

const PROD_PORT = 5180
const DEV_SERVER_URL = process.env.ELECTRON_RENDERER_URL

const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.ico': 'image/x-icon',
}

// WebAuthn (navigator.credentials) requires a secure context: Chromium does
// not treat file:// pages as secure, so the built renderer is served over
// plain HTTP on localhost rather than loaded from disk. See README "WebAuthn
// caveats" for why this matters.
function serveDist(distDir, port) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const requestPath = decodeURIComponent((req.url || '/').split('?')[0])
      const candidate = path.join(distDir, requestPath)
      const filePath = requestPath === '/' || !path.extname(candidate)
        ? path.join(distDir, 'index.html')
        : candidate

      fs.readFile(filePath, (err, data) => {
        if (err) {
          res.writeHead(404, { 'Content-Type': 'text/plain' })
          res.end('Not found')
          return
        }
        res.writeHead(200, { 'Content-Type': MIME_TYPES[path.extname(filePath)] || 'application/octet-stream' })
        res.end(data)
      })
    })

    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve(server))
  })
}

let mainWindow
let staticServer

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 780,
    title: 'Veil Electron Wallet',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  if (DEV_SERVER_URL) {
    await mainWindow.loadURL(DEV_SERVER_URL)
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  } else {
    const distDir = path.join(__dirname, '..', 'dist')
    staticServer = await serveDist(distDir, PROD_PORT)
    await mainWindow.loadURL(`http://localhost:${PROD_PORT}`)
  }
}

app.whenReady().then(createWindow)

app.on('window-all-closed', () => {
  staticServer?.close()
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})
