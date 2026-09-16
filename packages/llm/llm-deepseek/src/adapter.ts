/** Select a DeepSeek wire implementation from one validated configuration generation. */
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, PreparedAdapterCall, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { DeepSeekAdapterOptions } from './common/types.ts'
import { ChatCompletionsAdapter } from './protocols/chat-completions/adapter.ts'
import { DeepSeekFileStore } from './common/file-store.ts'
import { DeepSeekMessagesAdapter } from './protocols/messages/adapter.ts'

/** One provider route with protocol-local transport and shared credentials and model configuration. */
export class DeepSeekAdapter extends LlmAdapter {
  /**
   * [本地改造 2026-08-28，2026-09-16 随上游门面重构调整] 文本模型发图转本地路径文本：
   * chat-completions 由 `serialize.ts` 的 `imagesAsText` 承担，故该协议下跳过
   * `LlmRuntime` 顶层的 sha 摘要投影，否则图在 dispatch 前被替换、路径能力被架空。
   * messages 协议没有本地 `imagesAsText`，必须保留官方投影——跳过会让
   * `protocols/messages/images.ts` 对文本模型抛 `UNSUPPORTED_CONTENT`。
   */
  override get textImageHandling(): 'path' | undefined {
    return this.dependencies.options().protocol === 'chat-completions' ? 'path' : undefined
  }

  private readonly files: DeepSeekFileStore

  constructor(private readonly dependencies: DeepSeekAdapterOptions) {
    super()
    this.files = dependencies.resolveFiles?.() ?? new DeepSeekFileStore()
  }

  private implementation(): LlmAdapter {
    const connection = this.dependencies.options()
    switch (connection.protocol) {
      case 'messages':
        return new DeepSeekMessagesAdapter({
          connection: () => connection,
          apiKey: this.dependencies.resolveApiKey,
          userId: this.dependencies.resolveUserId,
          attachments: () => this.dependencies.resolveAttachments?.(),
          imageAccess: (ref) => {
            const attachments = this.dependencies.resolveAttachments?.()
            return attachments === undefined ? undefined : this.dependencies.resolveImageAccess?.(attachments, ref)
          },
          files: () => this.files,
          prepareExtensions: this.dependencies.prepareExtensions,
          ...this.dependencies.onReplayDegrade === undefined ? {} : { onReplayDegrade: this.dependencies.onReplayDegrade },
        })
      case 'chat-completions':
        return new ChatCompletionsAdapter({ ...this.dependencies, options: () => connection, resolveFiles: () => this.files })
      /* v8 ignore next -- protocol is validated at configuration resolution. */
      default: return assertNever(connection.protocol, 'DeepSeek protocol')
    }
  }

  override providerInfo(provider: string) { return this.implementation().providerInfo(provider) }
  override providerRetryPolicy(provider: string) { return this.implementation().providerRetryPolicy(provider) }
  override listModels(provider: string) { return this.implementation().listModels(provider) }
  override resolveModel(provider: string, model: string, signal?: AbortSignal) {
    return this.implementation().resolveModel(provider, model, signal)
  }
  override imageRequestPricing(provider: string, model: string) {
    return this.implementation().imageRequestPricing(provider, model)
  }
  override prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall> {
    return this.implementation().prepareCall(provider, model, signal)
  }
  stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    return this.implementation().stream(options)
  }
}
