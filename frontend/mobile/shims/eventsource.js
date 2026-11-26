// React Native shim for the `eventsource` package.
//
// `@stellar/stellar-sdk`'s Horizon `call_builder` imports `eventsource` to power
// `.stream()` (server-sent events). That package pulls in Node's `url`, `http`,
// `https`, and `events` modules, none of which exist in the Hermes/React Native
// runtime, so bundling the real package fails outright.
//
// This app talks to Horizon request/response only (`loadAccount`,
// `submitTransaction`, polling on a timer) and never calls `.stream()`, so the
// EventSource constructor is imported but never invoked. This inert stand-in
// satisfies the import and keeps the Node dependencies out of the bundle. If
// Horizon streaming is ever needed on native, swap this for `react-native-sse`.

class EventSource {
  constructor() {
    throw new Error(
      'EventSource (Horizon streaming) is not supported on React Native. ' +
        'Use request/response calls or a timer-based poll instead.',
    );
  }
  close() {}
  addEventListener() {}
  removeEventListener() {}
}

EventSource.CONNECTING = 0;
EventSource.OPEN = 1;
EventSource.CLOSED = 2;

module.exports = EventSource;
module.exports.default = EventSource;
module.exports.EventSource = EventSource;
