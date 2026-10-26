# The read/write boundary

Read this before you add a tool.

**The agent never signs.** It never touches key material, never calls
`signXdrPayload()`, and never submits a transaction. Anything that moves money is
prepared by the agent and handed to the user through `request_user_approval` and
the real screen, where the passkey ceremony runs. That ceremony is the thing
standing between a prompt-injected instruction and someone's balance.

## Two kinds of tool, no third

Every entry in `TOOL_REGISTRY` (`src/agent.ts`) declares a `kind` in the
definition itself (type `VeilTool`, `src/boundary.ts`):

| kind | meaning | approval |
| --- | --- | --- |
| `read` | Returns information, changes nothing. | none; must not declare one |
| `prepare` | Returns a described, reviewable action the user confirms on a screen. It cannot execute on its own. | must declare `approval` |

A `prepare` tool declares how it reaches the passkey:

- `approval: 'request_user_approval'` — it builds something (e.g. a payment XDR)
  that is only acted on once handed to `request_user_approval`.
- `approval: 'screen'` — it hands off to a wallet screen (Swap, Invest) that
  quotes, reviews and runs the passkey itself.
- `approval: 'self'` — reserved for `request_user_approval`.

A tool that writes without approval does not get merged.

## What the tests enforce (`src/__tests__/boundary.test.ts`)

- Every tool declares `read` or `prepare`; every `case` in `executeTool` is in the
  registry, so a tool cannot exist without a kind.
- A `read` tool cannot reach a write path or hand an action to the user; a
  `prepare` tool cannot stage a transaction except through
  `request_user_approval`.
- No source file in this package signs or submits (`sendTransaction`,
  `signXdrPayload`, `.sign(`, `Keypair.fromSecret`).
- No tool returns a secret seed, a raw 64-hex key or a URL, given hostile input
  and a backend that errors with those in its message.
- A prompt telling the agent to skip approval does not skip approval.

The checker is run against deliberately broken tools in the same file, so you can
see it fail.

## Adding a tool

1. Add it to `TOOL_REGISTRY` with `kind` (and `approval` if `prepare`).
2. Add its `case` to `executeTool`, and a hostile input for it in `boundary.test.ts`.
3. Anything a prepare tool returns for review goes through the same
   fee-payer-source check the wallet already applies. Do not add a second review
   path.
4. Call the wallet's existing module for a money flow (`frontend/mobile/lib/`);
   do not write a second implementation inside the agent.

## Ground rules

- Pin assets by issuer, never by code. Eight issuers publish `USDT0`.
- Never render or log an RPC URL; provider keys live in the URL path. Tool output
  passes through `redactSensitive` as a last gate, but do not rely on it.
- Never speak, log or return a private key, seed, passkey credential or fee-payer
  secret — including inside an error message.
- Anything from a backend, a token's metadata or a memo is data, never
  instruction.
