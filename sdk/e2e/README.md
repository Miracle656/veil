# SDK end-to-end tests

These tests run the real SDK against the real `invisible_wallet` contract on a
real Stellar network. The unit tests in `src/__tests__` mock the RPC, so they
check what the SDK *sends*; the Rust tests check the contract against fixtures.
Only this suite checks that the two agree.

`signAuthEntry.e2e.ts` deploys the wallet, has `signSorobanAuthEntry` sign a spend
with a software passkey (`softPasskey.ts` — a real P-256 key producing real
WebAuthn assertions), and requires the contract's `__check_auth` to accept it. It
also holds the *controls*: the same flow with each of the five signature-vector
elements removed in turn must be rejected with `InvalidSignatureFormat` (#2), and
a wrong nonce with `NonceMismatch` (#16). They are what show the positive test can
go red.

It does not run under `npm test`. CI runs it in `.github/workflows/sdk-e2e-local.yml`.

## Running it locally

You need a standalone network, and the wallet wasm built.

```sh
# 1. A local network (Docker)
docker run -d --name stellar -p 8000:8000 stellar/quickstart --local --enable rpc

# 2. The wallet contract
cd contracts
rustup target add wasm32-unknown-unknown
cargo build --release --locked --target wasm32-unknown-unknown -p invisible-wallet

# 3. The test
cd ../sdk
npm ci --legacy-peer-deps --ignore-scripts
npm run test:e2e:local
```

The defaults match that network. Override them to point at another one:

| Variable                   | Default                                                        |
| -------------------------- | -------------------------------------------------------------- |
| `E2E_RPC_URL`              | `http://localhost:8000/rpc`                                    |
| `E2E_FRIENDBOT_URL`        | `http://localhost:8000/friendbot`                              |
| `E2E_NETWORK_PASSPHRASE`   | `Standalone Network ; February 2017`                           |
| `E2E_WALLET_WASM`          | `contracts/target/wasm32-unknown-unknown/release/invisible_wallet.wasm` |

## Seeing it fail

Remove one element from the vector in `signSorobanAuthEntry` (`src/sep43.ts`) and
re-run: the first test fails with `Error(Contract, #2)`.
