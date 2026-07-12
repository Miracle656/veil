# Payroll Batch Example

A CRON-driven Node.js script that pays N team members in a **single Stellar transaction** with multiple payment operations.

## Prerequisites

- Node.js 18+
- npm or yarn

## Setup

```bash
cd examples/payroll
npm install
```

## Configuration

Edit `payroll.json` with your values:

```json
{
  "sourceSecret": "S...",
  "rpcUrl": "https://soroban-testnet.stellar.org",
  "token": "native",
  "payments": [
    { "to": "G...", "amount": "100.00", "memo": "June payroll" },
    { "to": "G...", "amount": "150.50", "memo": "June payroll" }
  ]
}
```

| Field | Description |
|-------|-------------|
| `sourceSecret` | Secret key of the funding account |
| `rpcUrl` | Soroban RPC endpoint |
| `token` | `native` (XLM) or a Soroban token contract address |
| `payments` | Array of employees with `to`, `amount`, optional `memo` |

## Dry Run

Validate that the batch is well-formed without submitting:

```bash
npm run payroll -- --dry-run
```

## Submit

Run the payroll batch:

```bash
npm run payroll -- --file payroll.json
```

## How It Works

1. Reads `payroll.json`
2. Builds one `TransactionBuilder` and appends one `Operation.payment()` (or contract `transfer` call) per employee
3. **Dry-run**: calls `server.simulateTransaction()` and prints the result
4. **Live**: assembles, signs, submits, and polls until confirmation

A Stellar transaction can contain up to 100 operations, so this pattern scales to monthly payroll for teams of that size in a single transaction.
