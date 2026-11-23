/*!
 * Veil Connect (pilot) — https://app.useveilapp.xyz/connect.js
 *
 *   <script src="https://app.useveilapp.xyz/connect.js"></script>
 *   const veil = VeilConnect.init({ app: 'your-app-id' })
 *   const { address } = await veil.connect()
 *   const { hash, reference } = await veil.pay({ to, amount: '20', asset: 'USDC', reference: 'order-123' })
 *   await veil.addMoney()
 *
 * Call these from a click or tap. Browsers block a window that opens any
 * other way.
 *
 * IMPORTANT: a result is what the user's browser says happened. Before your
 * server credits a payment it must look the hash up on Stellar and check the
 * destination, the asset and the amount, and must accept each hash only once.
 */
(function (global) {
  'use strict'

  var CHANNEL = 'veil-connect'
  var VERSION = 1

  // Veil's origin is wherever this file was loaded from.
  var script = document.currentScript
  var VEIL_ORIGIN = script && script.src ? new URL(script.src).origin : 'https://app.useveilapp.xyz'

  function newId() {
    var bytes = new Uint8Array(16)
    global.crypto.getRandomValues(bytes)
    var out = ''
    for (var i = 0; i < bytes.length; i++) out += ('0' + bytes[i].toString(16)).slice(-2)
    return out
  }

  function VeilError(code, message) {
    var error = new Error(message)
    error.name = 'VeilConnectError'
    error.code = code
    return error
  }

  function open(appId, request) {
    return new Promise(function (resolve, reject) {
      request.id = newId()
      var url = VEIL_ORIGIN + '/connect?app=' + encodeURIComponent(appId)
      var popup = global.open(url, 'veil-connect', 'popup,width=440,height=720')
      if (!popup) {
        reject(VeilError('blocked', 'The browser blocked the Veil window. Call this from a click or tap.'))
        return
      }

      var done = false
      function finish(fn, value) {
        if (done) return
        done = true
        global.removeEventListener('message', onMessage)
        global.clearInterval(watch)
        fn(value)
      }

      function onMessage(event) {
        if (event.origin !== VEIL_ORIGIN || event.source !== popup) return
        var data = event.data
        if (!data || data.channel !== CHANNEL) return

        if (data.kind === 'ready') {
          popup.postMessage({ channel: CHANNEL, v: VERSION, kind: 'request', request: request }, VEIL_ORIGIN)
          return
        }
        if (data.kind === 'result' && data.id === request.id) {
          var result = data.result || {}
          if (result.ok) finish(resolve, result)
          else finish(reject, VeilError(result.error || 'refused', result.reason || 'The request was not completed.'))
        }
      }
      global.addEventListener('message', onMessage)

      // The user can simply close the window.
      var watch = global.setInterval(function () {
        if (popup.closed) finish(reject, VeilError('cancelled', 'The Veil window was closed.'))
      }, 500)
    })
  }

  function init(options) {
    var appId = options && options.app
    if (!appId) throw VeilError('config', 'VeilConnect.init needs { app: "<your app id>" }.')
    return {
      /** Resolves with { address, network }. */
      connect: function () {
        return open(appId, { type: 'connect' })
      },
      /** Resolves with { hash, reference, network }. Verify the hash on your server. */
      pay: function (payment) {
        payment = payment || {}
        return open(appId, {
          type: 'pay',
          to: payment.to,
          amount: String(payment.amount),
          asset: payment.asset || 'USDC',
          reference: payment.reference,
        })
      },
      /** Opens "Buy with naira" in Veil. Resolves once the user is on their way. */
      addMoney: function () {
        return open(appId, { type: 'fund' })
      },
    }
  }

  global.VeilConnect = { init: init, origin: VEIL_ORIGIN }
})(window)
