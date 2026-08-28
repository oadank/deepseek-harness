/**
 * balance domain contract: DeepSeek 直连账户余额查询。仅当部署配置了
 * DEEPSEEK_API_KEY（直连 deepseek 路由）时有意义；走 LiteLLM 等其他
 * 路由的部署返回 null（前端据此隐藏余额指示）。
 */

import type { RpcRequest, RpcResponse } from './rpc.ts'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** Wire view of one DeepSeek balance entry. */
export interface BalanceView {
  /** 币种（如 CNY）。 */
  currency: string
  /** 总额。 */
  total: string
  /** 赠送金额。 */
  granted: string
  /** 充值金额。 */
  toppedUp: string
}

/**
 * Wire view of ARK Agent Plan 套餐配额快照（火山方舟 volc-ark 显示额度而非余额）。
 * [本地改造 2026-08-27] 来自 GetAFPUsage 返回的 AFPFiveHour/AFPWeekly/AFPMonthly，
 * 只取用户关注的 5小时/周/月 三个周期。
 */
export interface ArkUsageView {
  /** 套餐档位：small/medium/large/max。 */
  planType: string
  /** 各周期配额使用情况（按 label 稳定排序：5h / weekly / monthly）。 */
  periods: Array<{
    /** 周期标签：5h / weekly / monthly。 */
    label: string
    /** 该周期配额总量。 */
    quota: number
    /** 该周期已用量。 */
    used: number
    /** 下次刷新时间（epoch ms）。 */
    resetAt: number
  }>
}

/** Balance-domain unary methods (the map keys balance.* of RpcMethodMap). */
export interface BalanceApi {
  /**
   * 查询 DeepSeek 直连账户余额。无 DEEPSEEK_API_KEY 凭证或查询失败时
   * 返回 null（非直连部署/网络异常均不报错——余额只是辅助指示）。
   * [本地改造 2026-08-16] 可选 sessionId：调用方传入当前会话 id 时，
   * host 仅在该会话的模型 provider 为 deepseek 直连（deepseek-official）
   * 时返回余额，否则返回 null（余额指示只对 deepseek 直连模型显示）。
   */
  get(request: RpcRequest<{ sessionId?: SessionId }>): Promise<RpcResponse<{
    balance: BalanceView | null
    /** [本地改造 2026-08-27] 网关(henry-gao gw)健康状态：true=正常/绿、false=异常/红、
     * null=非 gw 直连。host 探测 /health 得到（浏览器直连会被 CORS 拦截）。所有分支必填。 */
    gatewayHealthy: boolean | null
    /** [本地改造 2026-08-27] ARK Agent Plan 套餐配额快照：volc-ark provider 会话
     * 时有值，其余为 null（前端据此显示 ARK 额度而非余额）。 */
    usage: ArkUsageView | null
  }>>
}
