# create-veil-app

Scaffold a new [Veil](https://github.com/Miracle656/veil) passkey-wallet app
from a template — `npx create-veil-app my-app` gives you a working,
installed project in about 30 seconds.

## Usage

```bash
npx create-veil-app my-app
```

You'll be prompted to choose a template if you don't pass `--template`:

```bash
npx create-veil-app my-app --template=next     # Next.js
npx create-veil-app my-app --template=vite     # Vite + React
npx create-veil-app my-app --template=vanilla  # Vanilla JS, no framework
```

Each command:

1. Fetches the chosen template from [`examples/`](../../examples) in the
   Veil repo.
2. Vendors the [`sdk/`](../../sdk) package alongside it (the Stellar +
   WebAuthn SDK isn't published to npm yet, so it's fetched and built
   locally instead of installed from the registry).
3. Builds the SDK and installs the app's dependencies.

When it finishes, `cd my-app` and follow the printed next step (`npm run
dev`, or serve `index.html` for the vanilla template). Each template's own
README documents the environment variables it needs (factory contract
address, RPC URL, etc.).

## Requirements

- Node.js 20+

## Local development

This package isn't published yet. To run it from a checkout of this repo:

```bash
cd packages/create-veil-app
npm install
npm run build
node dist/index.js my-app --template=vite
```

Set `VEIL_TEMPLATE_REPO` to point at a different GitHub `owner/repo` (e.g.
your own fork) if you're testing template changes before they're merged:

```bash
VEIL_TEMPLATE_REPO=your-username/veil node dist/index.js my-app --template=vite
```
