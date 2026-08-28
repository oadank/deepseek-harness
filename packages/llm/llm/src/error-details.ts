/**
 * Structured cause-chain extraction for transport failures.
 *
 * Transport errors (DNS, TLS, socket resets, proxy failures) carry their
 * actionable diagnosis on the Error `cause` chain (e.g. undici
 * `SocketError` → `ECONNRESET`, `ENOTFOUND`, `ETIMEDOUT`). DSH normalizes
 * them to the provider-neutral `TRANSPORT` code, which is stable for retry
 * routing but hides the underlying code that distinguishes "DNS broke" from
 * "socket reset". This module recursively snapshots the cause chain into a
 * JSON-safe flat record that rides on `LlmFailure.details` into the session
 * log, so a session package alone can tell `ECONNRESET` from `ENOTFOUND`
 * without querying service logs.
 *
 * @module @deepseek-ai/dsh-llm/error-details
 */

/** Max cause-chain depth captured, matching the transport diagnostics contract. */
const MAX_CAUSE_DEPTH = 4

/** Own transport-diagnosis fields captured per error (everything else is dropped). */
const FIELD_NAMES = [
  'name',
  'message',
  'code',
  'errno',
  'syscall',
  'hostname',
  'address',
  'port',
] as const

/**
 * Read one own data field from an error without invoking accessors (an SDK
 * property trap must not poison diagnostics).
 * @param error - the error being snapshotted.
 * @param field - the field name (a `CapturedField`, or `'cause'` for the chain link).
 * @returns the own data value, or `undefined` for accessor/absent fields.
 */
function ownField(error: Error, field: string): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, field)
    return descriptor !== undefined && 'value' in descriptor ? descriptor.value : undefined
  } catch (_sdkPropertyTrap) {
    return undefined
  }
}

/**
 * Capture an own field value only when it is JSON-safe and finite-size.
 * @param value - the own data value read from the error.
 * @returns the sanitized string, or `undefined` when the value is not worth capturing.
 */
function sanitize(value: unknown): string | undefined {
  try {
    if (typeof value === 'string') {
      const text = value.slice(0, 512)
      return text.length > 0 ? text : undefined
    }
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  } catch (_hostileCoercion) {
    return undefined
  }
  return undefined
}

/**
 * Recursively snapshot an error's cause chain into a flat, prefix-keyed,
 * JSON-safe record. Empty chains produce `{}`.
 * @param error - the thrown value; non-Error values are ignored.
 * @returns the flat cause-chain snapshot (no API keys, bodies, or user prompts).
 */
export function transportErrorDetails(error: unknown): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  const seen = new Set<unknown>()
  let current: unknown = error

  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (!(current instanceof Error) || seen.has(current)) break
    seen.add(current)
    const prefix = depth === 0 ? '' : `cause${depth}.`
    for (const field of FIELD_NAMES) {
      const value = sanitize(ownField(current, field))
      if (value !== undefined) result[`${prefix}${field}`] = value
    }
    const cause = ownField(current, 'cause')
    if (!(cause instanceof Error)) break
    current = cause
  }

  return result
}
