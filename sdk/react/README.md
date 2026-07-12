# `invisible-wallet-sdk/react`

React bindings for the Invisible Wallet SDK: a provider, data hooks, and a set of
presentational components.

## 📕 Storybook

Browse and interact with every component in Storybook:

**Live: https://miracle656.github.io/veil/**

> The live site is published by [`.github/workflows/storybook.yml`](../../.github/workflows/storybook.yml)
> on every push to `main` (GitHub Pages must be enabled for the repo: Settings →
> Pages → Source: GitHub Actions).

Run it locally:

```bash
cd sdk
npm install
npm run storybook        # dev server on http://localhost:6006
npm run build-storybook  # static build → react/storybook-static
```

## Exports

### Provider & hooks
- `VeilProvider` — wraps the app with the wallet + a React Query client.
- `useVeilContext`, `useAccount`, `useBalance`, `useSendPayment`, `useTransactionStatus`.

### Components
Presentational components — feed them from the hooks (each component's JSDoc shows
the exact wiring). Storied states: default, loading, error, and more.

| Component | Pairs with | Shows |
| --- | --- | --- |
| `AccountBadge` | `useAccount` | Address + deployed/loading/error status |
| `BalanceCard` | `useBalance` | Formatted balance for an asset |
| `SendPaymentForm` | `useSendPayment` | Recipient / amount / memo form |
| `TxStatusPill` | `useTransactionStatus` | Pending / success / failed / not-found pill |
| `ConnectButton` | `VeilProvider` wallet | Connect / connected-address button |

```tsx
import { useBalance, BalanceCard } from 'invisible-wallet-sdk/react';

function Balance() {
  const { data, isLoading, error } = useBalance();
  return <BalanceCard amount={data?.amount} assetCode={data?.assetCode} loading={isLoading} error={error?.message} />;
}
```
