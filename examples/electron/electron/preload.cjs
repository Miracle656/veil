const { contextBridge } = require('electron')

// The Veil SDK only needs standard Web APIs (navigator.credentials,
// crypto.subtle, fetch, localStorage), all of which are already available in
// the renderer's isolated context — no bridging required. This preload only
// exposes version info so the UI can show what it's running under.
contextBridge.exposeInMainWorld('veilElectron', {
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
})
