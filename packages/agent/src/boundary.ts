import type { ToolSpec } from './llm.js'

/**
 * The read/write boundary, declared in code.
 *
 * Every agent tool is exactly one of two kinds. There is no third kind.
 *
 * - `read`    returns information, changes nothing, needs no approval.
 * - `prepare` returns a described, reviewable action that the user confirms on
 *             a screen, where the passkey ceremony runs. It cannot execute on
 *             its own.
 *
 * The agent never signs, never holds key material and never submits a
 * transaction. See BOUNDARY.md before adding a tool.
 */
export type ToolKind = 'read' | 'prepare'

/**
 * How a `prepare` tool reaches the user's passkey.
 *
 * - `request_user_approval`: the tool builds something that is only ever acted
 *   on after the model hands it to request_user_approval.
 * - `screen`: the tool hands off to a wallet screen (Swap, Invest) that does its
 *   own quote, review and passkey confirmation.
 * - `self`: the tool IS the approval hand-off (request_user_approval).
 */
export type ApprovalPath = 'request_user_approval' | 'screen' | 'self'

export type VeilTool = ToolSpec & {
  kind: ToolKind
  /** Required for `prepare` tools, forbidden for `read` tools. */
  approval?: ApprovalPath
  /**
   * The app screen this capability belongs to. The system prompt names it when
   * it has to tell the user where a thing lives, so it must be a screen that
   * exists and that actually does what this tool describes.
   */
  screen: string
}

/** The shape the model providers receive: no Veil-only fields. */
export function toModelTools(registry: readonly VeilTool[]): ToolSpec[] {
  return registry.map(({ kind: _kind, approval: _approval, screen: _screen, ...spec }) => spec)
}

const REDACTED_SECRET = '[redacted secret]'
const REDACTED_URL = '[redacted url]'

/**
 * Strip anything that must never reach the model, the user or a log from a
 * tool result or error: Stellar secret seeds (S...), URLs (provider keys live in
 * RPC URL paths) and long hex strings that look like raw key material.
 */
export function redactSensitive(text: string): string {
  return text
    .replace(/\bS[A-D][A-Z2-7]{54}\b/g, REDACTED_SECRET)
    .replace(/\b(?:https?|wss?):\/\/[^\s"'\<>)]+/gi, REDACTED_URL)
    .replace(/\b[0-9a-fA-F]{64}\b/g, (m) => (/^[0-9a-f]{64}$/i.test(m) ? REDACTED_SECRET : m))
}
