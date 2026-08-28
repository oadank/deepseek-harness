/**
 * balance domain zod schemas (names derived from map keys: balanceGetRequestSchema /
 * balanceGetValueSchema).
 */

import { z } from 'zod'
import type { RequestPayload, ResponseValue } from './rpc-map.ts'
import type { Wire } from './rpc.schema.ts'
import type { ArkUsageView, BalanceView } from './balance.ts'
import { sessionIdSchema } from './sessions.schema.ts'

/** BalanceView row of balance.get. */
export const balanceViewSchema = z.object({
  currency: z.string().min(1),
  total: z.string().min(1),
  granted: z.string().min(1),
  toppedUp: z.string().min(1),
}) satisfies z.ZodType<Wire<BalanceView>>

/**
 * ArkUsageView row of balance.get（火山方舟 volc-ark 套餐配额快照）。
 * [本地改造 2026-08-27] 只含 5h / weekly / monthly 三个周期。
 */
export const arkUsageViewSchema = z.object({
  planType: z.string(),
  periods: z.array(z.object({
    label: z.string(),
    quota: z.number(),
    used: z.number(),
    resetAt: z.number(),
  })),
}) satisfies z.ZodType<Wire<ArkUsageView>>

/** balance.get request payload. */
export const balanceGetRequestSchema = z.object({
  // [本地改造 2026-08-16] 可选 sessionId：host 据此判断当前会话的模型 provider
  // 是否为 deepseek 直连——非直连（如 qwen 百炼）时余额指示不显示。
  sessionId: sessionIdSchema.optional(),
}) satisfies z.ZodType<Wire<RequestPayload<'balance.get'>>>

/** balance.get response value. */
export const balanceGetValueSchema = z.object({
  balance: balanceViewSchema.nullable(),
  // [本地改造 2026-08-27] 网关(henry-gao gw)健康状态：true=正常/绿、false=异常/红、null=非gw不显示。
  // ⚠️ zod nullable 不接受 undefined：host 所有返回分支必须补全此字段（真值或 null），否则浏览器 parse 抛 ZodError。
  gatewayHealthy: z.boolean().nullable(),
  // [本地改造 2026-08-27] ARK 套餐额度快照：volc-ark provider 会话时有值，其余 null。
  usage: arkUsageViewSchema.nullable(),
}) satisfies z.ZodType<Wire<ResponseValue<'balance.get'>>>
