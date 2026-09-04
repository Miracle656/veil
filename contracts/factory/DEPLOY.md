# Factory Mainnet Deployment

This guide documents the mainnet deployment flow for the Veil factory contract.

The factory depends on the `invisible_wallet` Wasm hash, so deployment happens in
three stages:

1. build both contracts
2. upload the wallet Wasm and capture its hash
3. deploy the factory contract and initialize it with that wallet Wasm hash

## Prerequisites

- Rust with the `wasm32-unknown-unknown` target
- `stellar` CLI installed
- a funded mainnet deployer identity
- a mainnet Soroban RPC provider URL

```bash
rustup target add wasm32-unknown-unknown
stellar version
```

Set the shared deployment inputs:

```bash
export MAINNET_RPC_URL="https://your-mainnet-rpc-provider.example.com"
export NETWORK_PASSPHRASE="Public Global Stellar Network ; September 2015"
export DEPLOYER_ALIAS="veil-mainnet"
```

If you have not created the deployer identity yet:

```bash
stellar keys generate --global "$DEPLOYER_ALIAS"
stellar keys address "$DEPLOYER_ALIAS"
```

Fund that address with enough XLM to cover Wasm upload, contract deployment, and
the follow-up initialization transaction.

## 1. Build the Wasm artifacts

From the repo root:

```bash
cd contracts/invisible_wallet
cargo build --target wasm32-unknown-unknown --release

cd ../factory
cargo build --target wasm32-unknown-unknown --release
```

The generated artifacts are:

- `contracts/invisible_wallet/target/wasm32-unknown-unknown/release/invisible_wallet.wasm`
- `contracts/factory/target/wasm32-unknown-unknown/release/factory.wasm`

## 2. Upload the wallet Wasm

Upload the wallet code first and keep the returned hash:

```bash
cd /path/to/veil

WALLET_WASM_HASH=$(stellar contract upload \
  --rpc-url "$MAINNET_RPC_URL" \
  --network-passphrase "$NETWORK_PASSPHRASE" \
  --source-account "$DEPLOYER_ALIAS" \
  --wasm contracts/invisible_wallet/target/wasm32-unknown-unknown/release/invisible_wallet.wasm)

echo "$WALLET_WASM_HASH"
```

That hash is what the factory stores during `init`.

## 3. Deploy the factory contract

Deploy the compiled factory Wasm. The factory has a constructor that fixes the
**admin** atomically as part of this deploy transaction; only that admin can
later call `init`. Pass the deployer's own address as the admin:

```bash
DEPLOYER_ADDRESS=$(stellar keys address "$DEPLOYER_ALIAS")

FACTORY_CONTRACT_ID=$(stellar contract deploy \
  --rpc-url "$MAINNET_RPC_URL" \
  --network-passphrase "$NETWORK_PASSPHRASE" \
  --source-account "$DEPLOYER_ALIAS" \
  --wasm contracts/factory/target/wasm32-unknown-unknown/release/factory.wasm \
  -- --admin "$DEPLOYER_ADDRESS")

echo "$FACTORY_CONTRACT_ID"
```

## 4. Initialize the factory with the wallet Wasm hash

Call the factory's `init` entrypoint with the uploaded wallet Wasm hash. `init`
now **requires the admin's authorization** (the admin fixed in the constructor
above), so it must be signed by `$DEPLOYER_ALIAS`. This is what closes the
front-run race: between the deploy and this call, no other party can initialize
the factory with a wasm hash of their own, because they cannot produce the
admin's signature.

```bash
stellar contract invoke \
  --rpc-url "$MAINNET_RPC_URL" \
  --network-passphrase "$NETWORK_PASSPHRASE" \
  --source-account "$DEPLOYER_ALIAS" \
  --id "$FACTORY_CONTRACT_ID" \
  -- init \
  --wasm-hash "$WALLET_WASM_HASH"
```

If your local CLI version exposes a slightly different generated flag name for
the `init` argument, run:

```bash
stellar contract invoke \
  --rpc-url "$MAINNET_RPC_URL" \
  --network-passphrase "$NETWORK_PASSPHRASE" \
  --source-account "$DEPLOYER_ALIAS" \
  --id "$FACTORY_CONTRACT_ID" \
  -- --help
```

## 5. Record the deployment outputs

Capture both values for the release notes:

- `WALLET_WASM_HASH`
- `FACTORY_CONTRACT_ID`

The frontend mainnet deployment should then set:

```bash
NEXT_PUBLIC_NETWORK=mainnet
NEXT_PUBLIC_MAINNET_RPC_URL=$MAINNET_RPC_URL
NEXT_PUBLIC_FACTORY_CONTRACT_ID_MAINNET=$FACTORY_CONTRACT_ID
```

## Notes

- The actual mainnet deployment should be performed by the maintainer because it
  spends real XLM.
- Reuse the same RPC provider URL in the frontend so wallet reads and writes hit
  the same network.
- After deployment, verify the factory on-chain before pointing production
  traffic at it.
