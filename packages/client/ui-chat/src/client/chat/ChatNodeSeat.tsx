import { memo, useCallback, useMemo } from 'react'
import { JsonBlock } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ConversationLocationDataStore, ConversationTurnDataMap } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ChatNodeOwnerProps, ChatViewSlotProps } from '../contract/slots.ts'
import type { ChatNode } from '../contract/chat-nodes.ts'
import { TURN_PROCESS_INDEPENDENT_KINDS } from '../contract/turn-process.ts'
import { storedTurnProcessEntry } from '../stores.ts'
import { useSearchableHidden } from './searchable-hidden.ts'
import css from './ChatView.module.css'

/**
 * [本地改造 2026-09-24] 一行用户消息的日志位置。
 *
 * Chat 行只有引擎 key，扩展 UI（撤回入口、已撤回隐藏）无法据此寻址到具体那条
 * `user/message` 事件；把 durable seq 一起写进 DOM，插件就能与服务端用同一个坐标
 * 说话，而服务端撤回也正是按 seq 覆盖 surface 节点。非用户行返回 undefined，属性缺席。
 * @param node - 当前行的 Chat Node。
 * @returns 该行的日志 seq，或 undefined。
 */
function chatRowSeq(node: ChatNode | undefined): number | undefined {
  if (node === undefined) return undefined
  if (node.kind !== 'user' && node.kind !== 'steering') return undefined
  return node.data.seq
}

interface ChatNodeSeatProps extends ChatNodeOwnerProps {
  readonly nodeKey: string
  readonly useChatNode: ChatViewSlotProps['useChatNode']
  readonly useChatNodeProcess: ChatViewSlotProps['useChatNodeProcess']
  readonly historyIncomplete: boolean
  readonly compactTranscript: boolean
  readonly useStore: ChatViewSlotProps['useStore']
  readonly actions: ChatViewSlotProps['actions']
  readonly renderSlot: ChatViewSlotProps['renderSlot']
  readonly t: ChatViewSlotProps['t']
}

type RoutedChatNodeOwner = {
  [Kind in ChatNode['kind']]: ChatNodeOwnerProps & { readonly node: ChatNode<Kind> }
}[ChatNode['kind']]

function turnDataOf(node: ChatNode | undefined): ConversationLocationDataStore<ConversationTurnDataMap> | undefined {
  const location = node?.location
  return location?.kind === 'turn' || location?.kind === 'step' ? location.turn.data : undefined
}

function turnOf(node: ChatNode | undefined): number | undefined {
  const location = node?.location
  return location?.kind === 'turn' || location?.kind === 'step' ? location.turn.turn : undefined
}

/** Subscribe, apply Turn-process visibility, and dispatch one stable Context key. */
export const ChatNodeSeat = memo(function ChatNodeSeat({
  nodeKey, useChatNode, useChatNodeProcess, historyIncomplete, compactTranscript,
  cwd, openFile, openSkill, inspectCall, forkAt,
  loadImage, loadVoice, renderMessageImages, fileMentions, useStore, actions, renderSlot, t,
}: ChatNodeSeatProps) {
  const node = useChatNode(nodeKey)
  const routedNode = node as ChatNode | undefined
  const turn = turnOf(routedNode)
  const processPresentation = useChatNodeProcess(nodeKey)
  const processSpec = processPresentation?.spec
  const storedEntry = useStore(state => processSpec === undefined
    ? undefined
    : storedTurnProcessEntry(state, processSpec.turn))
  const processEntry = processSpec !== undefined
    && processSpec.answerStep !== null
    && storedEntry?.answerStep === processSpec.answerStep
    ? storedEntry
    : undefined
  const processOpen = processEntry !== undefined
  const setOpen = useCallback((open: boolean) => {
    if (processSpec !== undefined && processSpec.answerStep !== null) {
      actions.setTurnProcessOpen(processSpec.turn, processSpec.answerStep, open)
    }
  }, [actions, processSpec])
  const processWindowReady = processSpec !== undefined
    && processPresentation !== undefined
    && compactTranscript
    && processSpec.answerAnchorSeq !== null
    && processPresentation.turn === processSpec.turn
    && processPresentation.turnClosed
    && !historyIncomplete
  const processMember = routedNode !== undefined
    && processWindowReady
    && !TURN_PROCESS_INDEPENDENT_KINDS.has(routedNode.kind)
    && routedNode.anchorSeq >= processSpec.processStartSeq
    && routedNode.anchorSeq < processSpec.answerAnchorSeq
  const processAnswer = routedNode !== undefined
    && processWindowReady
    && routedNode.kind === 'assistant-step'
    && routedNode.data.step === processSpec.answerStep
  const ownsDisclosure = routedNode?.kind === 'turn-process' || processAnswer
  const foldable = processWindowReady
    && (processMember || (ownsDisclosure
      && (processPresentation.hasExternalProcess || processSpec.inlineReasoning)))
  const turnProcess = useMemo(() => processSpec === undefined
    ? undefined
    : {
      spec: processSpec,
      foldable,
      open: processOpen,
      setOpen,
    }, [
    foldable, processOpen, processSpec, setOpen,
  ])
  const controllerInactive = routedNode?.kind === 'turn-process'
    && !foldable
  const compactAnswer = processAnswer
    && foldable
    && processPresentation.compactAnswer
    && !processOpen
  const processHidden = controllerInactive || (foldable && processMember && !processOpen)
  const revealProcess = useCallback(() => {
    if (processMember) setOpen(true)
  }, [processMember, setOpen])
  const wrapperRef = useSearchableHidden(processHidden, revealProcess)
  const owner = useMemo<ChatNodeOwnerProps | null>(() => node === undefined
    ? null
    : {
      cwd,
      openFile,
      openSkill,
      inspectCall,
      forkAt,
      loadImage,
      loadVoice,
      renderMessageImages,
      fileMentions,
      turnProcess,
    }, [
    node, cwd, openFile, openSkill, inspectCall, forkAt,
    loadImage, loadVoice, renderMessageImages, fileMentions, turnProcess,
  ])
  if (routedNode === undefined || owner === null) return null
  const turnData = turnDataOf(routedNode)
  // Runtime dispatch owns the correlation: every Node's discriminant is the
  // keyed-slot entry passed alongside that same Node. TypeScript does not
  // distribute an object containing a union into a union of objects itself.
  const routedOwner = { ...owner, node: routedNode } as RoutedChatNodeOwner
  return (
    <div
      ref={wrapperRef}
      className={css.flowItem}
      data-chat-anchor-key={routedNode.key}
      data-chat-flow-key={routedNode.key}
      data-chat-flow-kind={routedNode.kind}
      data-message-seq={chatRowSeq(routedNode)}
      data-chat-turn={turn}
      data-turn-process-member={processMember || undefined}
      data-turn-process-hidden={processHidden || undefined}
      data-turn-process-answer={compactAnswer || undefined}
    >
      {renderSlot('conversation.chat.node', routedOwner, {
        entryKey: routedNode.kind,
        hookContext: turnData,
        fallback: (
          <JsonBlock
            label={t('message.unknownSurface', { type: routedNode.kind })}
            payload={routedNode.data}
            truncatedLabel={total => t('json.truncated', { total })}
          />
        ),
      })}
    </div>
  )
})
