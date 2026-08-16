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

/** Balance-domain unary methods (the map keys balance.* of RpcMethodMap). */
export interface BalanceApi {
  /**
   * 查询 DeepSeek 直连账户余额。无 DEEPSEEK_API_KEY 凭证或查询失败时
   * 返回 null（非直连部署/网络异常均不报错——余额只是辅助指示）。
   * [本地改造 2026-08-16] 可选 sessionId：调用方传入当前会话 id 时，
   * host 仅在该会话的模型 provider 为 deepseek 直连（deepseek-official）
   * 时返回余额，否则返回 null（余额指示只对 deepseek 直连模型显示）。
   */
  get(request: RpcRequest<{ sessionId?: SessionId }>): Promise<RpcResponse<{ balance: BalanceView | null }>>
}
