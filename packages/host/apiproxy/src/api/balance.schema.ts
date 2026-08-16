/**
 * balance domain zod schemas (names derived from map keys: balanceGetRequestSchema /
 * balanceGetValueSchema).
 */

import { z } from 'zod'
import type { RequestPayload, ResponseValue } from './rpc-map.ts'
import type { Wire } from './rpc.schema.ts'
import type { BalanceView } from './balance.ts'
import { sessionIdSchema } from './sessions.schema.ts'

/** BalanceView row of balance.get. */
export const balanceViewSchema = z.object({
  currency: z.string().min(1),
  total: z.string().min(1),
  granted: z.string().min(1),
  toppedUp: z.string().min(1),
}) satisfies z.ZodType<Wire<BalanceView>>

/** balance.get request payload. */
export const balanceGetRequestSchema = z.object({
  // [本地改造 2026-08-16] 可选 sessionId：host 据此判断当前会话的模型 provider
  // 是否为 deepseek 直连——非直连（如 qwen 百炼）时余额指示不显示。
  sessionId: sessionIdSchema.optional(),
}) satisfies z.ZodType<Wire<RequestPayload<'balance.get'>>>

/** balance.get response value. */
export const balanceGetValueSchema = z.object({
  balance: balanceViewSchema.nullable(),
}) satisfies z.ZodType<Wire<ResponseValue<'balance.get'>>>
