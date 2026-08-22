/**
 * dsh-input-tools — 语音能力一体化插件（host 半：语音工具/TTS/ASR/克隆/自动回复）
 *
 * 能力：
 *   1) send_voice 工具（agent 主动发语音，任一新会话自动注入）
 *   2) turn/end 自动语音回复（用户本轮发过语音 / 文本明确要求语音 / 指定服务商）
 *   3) TTS 引擎（可配置，默认 auto=小米优先→edge 降级）：
 *      - edge      微软免费（edge-tts，音色可配）
 *      - xiaomi    小米 mimo-v2.5-tts（8 预置音色 + 唱歌 + 自然语言风格）
 *      - voicedesign 小米 mimo-v2.5-tts-voicedesign（文本描述定制音色）
 *      - voiceclone  小米 mimo-v2.5-tts-voiceclone（音频样本复刻音色）
 *      - local     本地 MeloTTS（HTTP 常驻服务优先，CMD 兜底）
 *      - ali       阿里 qwen3-tts-flash（dashscope，音色可配）
 *   4) voice 对象内容寻址落盘（DSH_HOME/attachments/v1/objects，与图片同池）
 *   5) 配置中心：~/.dsh/voice-config.json（环境变量 → 配置 → 默认值 三级回退）
 *   6) HTTP 路由：GET/POST /voice-config（设置页读写）+ GET /voice-config/engines（引擎元数据）
 *
 * 原代码在 api-proxy.ts 中已删除，本文件为唯一实现；voice.ts 仍保留给
 * voiceAsr/voiceTts RPC（编辑器内转写/合成）使用。
 */

import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, unlink, writeFile, copyFile, stat } from 'node:fs/promises'
import { constants, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join, resolve, sep } from 'node:path'
import { execFileSync } from 'node:child_process'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { edgeTts } from './edge-tts.js'

const name = 'dsh-input-tools'
const inject = ['tools', 'webServer']

export { name, inject }

// ──────────────────────────────────────────────────────────────
// [0.3.4] 自带素材（下载即用）：克隆样本 + VoiceDesign 示例音频打进 npm 包 assets/，
// 首次加载自动拷贝到 DSH_HOME 并注册，不再依赖"手动上传/在线生成"。
// ──────────────────────────────────────────────────────────────
const PLUGIN_ROOT = join(fileURLToPath(import.meta.url), '..', '..') // .../dsh-input-tools
const ASSETS_DIR = join(PLUGIN_ROOT, 'assets')
const BUNDLED_CLONE_ID = '8da38fcc-b041-4f5b-86b9-901956016f89'
const BUNDLED_CLONE_SAMPLE = {
  id: BUNDLED_CLONE_ID,
  name: '小团团(60秒长样本)',
  context: '一个魔性的少女萝莉音，说话自带沙雕搞怪和无厘头气质，像在撒娇又像在耍宝，情绪起伏很大：前一句还奶声奶气地撒娇卖萌，后一句就突然拔高音量夸张卖惨耍赖，再下一秒又贱兮兮地坏笑。尾音拖长上扬，带着气音和魔性笑声，喜欢用「臭猪」「你凶我」「哼」「嘿嘿嘿」这类咋咋呼呼的用词，语速忽快忽慢、节奏跳跃，吐字软糯清晰，傻白甜又可爱，让人听了忍不住想笑',
}
const VOICE_DESIGN_SAMPLE_KEYS = ['asmr', 'docu', 'elder']

// [2026-08-22] AI 自动模式的年龄感 6 档（用户实时可改，禁止自由文本）
const AI_AGE_LABELS = { infant: '婴儿感', child: '幼儿感', teen: '少年感', young: '青年感', middle: '中年感', old: '老年感' }

// [2026-08-22] 年龄×性别 → 无歧义身份短语（XDN 实测: "老年感+女孩"分维度拼接自相矛盾，
// "女孩"是中心词→年龄被降级→萝莉化；且"忽略性别/年龄"注把"沙哑/苍老"等最强质感词删了）。
// 改为"老年女性/小女孩/少女"这类中心词明确的合并短语，年龄不会再被降级。
function ageGenderIdentity(ageKey, genderKey) {
  const male = genderKey === 'male'
  const female = genderKey === 'female'
  switch (ageKey) {
    case 'infant': return male ? '男婴' : female ? '女婴' : '婴儿'
    case 'child': return male ? '小男孩' : female ? '小女孩' : '小孩'
    case 'teen': return male ? '少年' : female ? '少女' : '少年'
    case 'young': return male ? '青年男性' : female ? '青年女性' : '青年人'
    case 'middle': return male ? '中年男性' : female ? '中年女性' : '中年人'
    case 'old': return male ? '老年男性' : female ? '老年女性' : '老年人'
    default: return male ? '男性' : female ? '女性' : ''
  }
}

let bundledInitDone = false
/** 首次加载把自带素材落地到 DSH_HOME：克隆样本 mp3 拷贝 + 首次安装自动注册小团团。 */
async function ensureBundledAssets(config, parsed) {
  if (bundledInitDone) return config
  bundledInitDone = true
  try {
    const homeDir = process.env.DSH_HOME ?? join(homedir(), '.dsh')
    const cloneDir = join(homeDir, 'voiceclone-samples')
    const dstClone = join(cloneDir, BUNDLED_CLONE_ID + '.mp3')
    try {
      await mkdir(cloneDir, { recursive: true })
      await copyFile(join(ASSETS_DIR, 'voiceclone-samples', BUNDLED_CLONE_ID + '.mp3'), dstClone)
      // [2026-08-22] 预生成的合成试听录音（静态文件，播放免联网；与 VoiceDesign 官方示例同类）
      await copyFile(join(ASSETS_DIR, 'voiceclone-samples', BUNDLED_CLONE_ID + '-preview.mp3'), join(cloneDir, BUNDLED_CLONE_ID + '-preview.mp3'))
    } catch { /* 包内素材缺失或拷贝失败：跳过（不阻塞启动） */ }
    // 仅"首次安装"（配置里还没有 voiceclone 键）时注册自带样本；用户删光的 [] 不强制
    const parsedHasClone = parsed !== null && typeof parsed === 'object' && parsed.engines?.voiceclone !== undefined
    const samples = config?.engines?.voiceclone?.samples
    if (!parsedHasClone && (!Array.isArray(samples) || samples.length === 0)) {
      config.engines.voiceclone = { ...config.engines.voiceclone, enabled: true, samples: [{ ...BUNDLED_CLONE_SAMPLE, path: dstClone }] }
      await saveVoiceConfig(config)
    }
  } catch { /* 初始化失败不阻塞 */ }
  return config
}

// ──────────────────────────────────────────────────────────────
// 配置中心：~/.dsh/voice-config.json
// ──────────────────────────────────────────────────────────────
const CONFIG_PATH = resolve(join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'voice-config.json'))

function defaultVoiceConfig() {
  return {
    defaultEngine: 'auto',
    engines: {
      edge: { enabled: true, voice: 'zh-CN-XiaoxiaoNeural' },
      xiaomi: {
        enabled: true,
        apiKey: '',
        baseUrl: 'https://api.xiaomimimo.com/v1',
        voice: '冰糖',
        singing: false,
        context: '',
      },
      voicedesign: {
        enabled: false,
        mode: 'docu', // [2026-08-22] 单选: asmr|docu|elder|custom|ai（官方示例/自定义/交给 AI 自动发挥）
        context: '',
        emotion: false, // AI 情感语音（mode=ai 时自动开；固定示例/自定义模式关闭，保证音色一致）
        lockGender: true, lockTimbre: true, lockAge: true, // [2026-08-22] AI 自动模式下的稳定锚点锁定
        aiGender: 'female', aiAge: 'young', // [2026-08-22] AI 自动模式固定值：性别(女/男)；年龄感 6 档 infant/child/teen/young/middle/old
      }, // emotion=AI 情感语音开关（默认开）
      voiceclone: { enabled: false, samples: [], samplePath: '', context: '', defaultId: '' }, // [本地改造 2026-08-21] defaultId 已废弃，默认克隆由 defaultEngine=voiceclone 控制
      local: { enabled: true, url: '', cmd: '' },
      ali: {
        enabled: false,
        apiKey: '',
        baseUrl: 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation',
        voice: 'Cherry',
      },
      asr: {
        enabled: true,
        mode: 'service', // service=本地常驻服务 / cmd=本地命令 / api=在线 API
        url: 'http://127.0.0.1:18790', // sherpa-onnx 常驻服务（nssm: asr）
        cmd: 'C:\\D\\opt\\sherpa-onnx\\bin\\sherpa-onnx-offline.exe --tokens=C:\\D\\opt\\sherpa-onnx\\models\\sensevoice-int8\\tokens.txt --sense-voice-model=C:\\D\\opt\\sherpa-onnx\\models\\sensevoice-int8\\model.int8.onnx --num-threads=4',
        apiKey: '',
        apiBaseUrl: 'https://api.xiaomimimo.com/v1', // 小米 mimo-v2.5-asr；填 openai 地址则走 Whisper 风格
      },
    },
  }
}

function deepMerge(base, patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    return patch === undefined ? base : patch
  }
  const out = { ...base }
  for (const [k, v] of Object.entries(patch)) {
    out[k] = v !== null && typeof v === 'object' && !Array.isArray(v)
      && base?.[k] !== null && typeof base?.[k] === 'object'
      ? deepMerge(base[k], v)
      : v
  }
  return out
}

let cachedConfig = null
let cachedMtimeMs = -1
async function loadVoiceConfig() {
  // [2026-08-22] 实时读取：配置文件 mtime 变化（保存/外部修改）即重读，杜绝进程内旧缓存
  let mtimeMs = -1
  try { mtimeMs = (await stat(CONFIG_PATH)).mtimeMs } catch { /* 文件不存在 */ }
  if (cachedConfig !== null && mtimeMs === cachedMtimeMs) return cachedConfig
  let parsed = {}
  try {
    parsed = JSON.parse(await readFile(CONFIG_PATH, 'utf8'))
  } catch { /* 首次无配置 */ }
  cachedConfig = deepMerge(defaultVoiceConfig(), parsed)
  cachedMtimeMs = mtimeMs
  // [0.3.4] 自带素材初始化（拷贝克隆样本 + 首次安装自动注册小团团）
  await ensureBundledAssets(cachedConfig, parsed)
  // 环境变量覆盖（兼容旧配置；显式配置值优先于 env）
  const env = process.env
  if (env.TTS_XIAOMI_KEY !== undefined && cachedConfig.engines.xiaomi.apiKey === '') cachedConfig.engines.xiaomi.apiKey = env.TTS_XIAOMI_KEY
  if (env.TTS_XIAOMI_VOICE !== undefined && cachedConfig.engines.xiaomi.voice === '冰糖') cachedConfig.engines.xiaomi.voice = env.TTS_XIAOMI_VOICE
  if (env.TTS_XIAOMI_BASE_URL !== undefined) cachedConfig.engines.xiaomi.baseUrl = env.TTS_XIAOMI_BASE_URL
  if (env.TTS_EDGE_VOICE !== undefined && cachedConfig.engines.edge.voice === 'zh-CN-XiaoxiaoNeural') cachedConfig.engines.edge.voice = env.TTS_EDGE_VOICE
  if (env.DSH_LOCAL_TTS_CMD !== undefined && cachedConfig.engines.local.cmd === '') cachedConfig.engines.local.cmd = env.DSH_LOCAL_TTS_CMD
  return cachedConfig
}

/** 同步读配置：供 defineTool 的 description 等同步上下文使用
 *  （注意：loadVoiceConfig 是 async，在同步处直接用会拿到 Promise → 字段全 undefined）。 */
function loadVoiceConfigSync() {
  if (cachedConfig !== null) return cachedConfig
  let parsed = {}
  try {
    parsed = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
  } catch { /* 首次无配置 */ }
  return deepMerge(defaultVoiceConfig(), parsed)
}

async function saveVoiceConfig(config) {
  cachedConfig = deepMerge(defaultVoiceConfig(), config)
  await mkdir(join(CONFIG_PATH, '..'), { recursive: true })
  await writeFile(CONFIG_PATH, JSON.stringify(cachedConfig, null, 2), 'utf8')
  try { cachedMtimeMs = (await stat(CONFIG_PATH)).mtimeMs } catch { /* 忽略 */ }
  return cachedConfig
}

// ──────────────────────────────────────────────────────────────
// 语音对象存储（内容寻址，与图片附件同池：DSH_HOME/attachments/v1/objects）
// ──────────────────────────────────────────────────────────────
const MAX_VOICE_BYTES = 25 * 1024 * 1024

// [2026-08-21] 语音气泡（聊天界面 DOM 注入）：录音暂存 DSH_HOME/voice-outbox/
const VOICE_OUTBOX_EXT = {
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/mp4': 'mp4',
  'audio/m4a': 'm4a',
  'audio/wav': 'wav',
  'audio/mpeg': 'mp3',
}
const VOICE_OUTBOX_MIME = {
  webm: 'audio/webm', ogg: 'audio/ogg', mp4: 'audio/mp4', m4a: 'audio/m4a',
  wav: 'audio/wav', mp3: 'audio/mpeg',
}

/** 检测当前 dsh 的 connection 契约是否原生支持 voice content（rc.8 本地改造有；npm 官方版无）。
 *  优先从 dsh 进程实际运行的位置解析（dev 仓库 cwd / npm 全局），避免误报。 */
/** 从音频文件头嗅探媒体类型（对象存储无扩展名，TTS 输出可能是 wav/mp3）。 */
function sniffAudioType(bytes) {
  if (bytes.length >= 4 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) return 'audio/wav'
  if (bytes.length >= 3 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) return 'audio/mpeg'
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) return 'audio/mpeg'
  if (bytes.length >= 4 && bytes[0] === 0x4f && bytes[1] === 0x67 && bytes[2] === 0x67 && bytes[3] === 0x53) return 'audio/ogg'
  return 'audio/mpeg'
}

async function detectVoiceContractSupport() {
  const markers = ['literal("voice")', "literal('voice')"]
  const containsVoice = (s) => markers.some((m) => s.includes(m))
  // 1) dev 仓库（本机 lecoo：dsh 由 apps/cli tsx 直接跑，cwd=仓库根）
  for (const rel of [
    join('packages', 'client', 'connection', 'lib', 'client.js'),
    join('node_modules', '@deepseek-ai', 'dsh-client-connection', 'lib', 'client.js'),
  ]) {
    try {
      if (containsVoice(readFileSync(join(process.cwd(), rel), 'utf8'))) return true
    } catch { /* 下一个候选 */ }
  }
  // 2) npm 安装（XDN：dsh 在全局 node_modules，从插件解析链向上找）
  try {
    const { createRequire } = await import('node:module')
    const require = createRequire(import.meta.url)
    const p = require.resolve('@deepseek-ai/dsh-client-connection/lib/client.js')
    if (containsVoice(readFileSync(p, 'utf8'))) return true
  } catch { /* 找不到 */ }
  return false
}

function voiceStorageRoot() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return resolve(join(home, 'attachments', 'v1'))
}

function objectPath(root, sha256) {
  return join(root, 'objects', sha256.slice(0, 2), sha256)
}

async function saveVoiceFile(root, data, mediaType, durationMs) {
  if (data.byteLength > MAX_VOICE_BYTES) {
    throw new Error(`Voice object exceeds the ${MAX_VOICE_BYTES}-byte limit.`)
  }
  const sha256 = createHash('sha256').update(data).digest('hex')
  const bucket = join(root, 'objects', sha256.slice(0, 2))
  const target = objectPath(root, sha256)
  await mkdir(bucket, { recursive: true, mode: 0o700 })
  let handle
  try {
    handle = await open(target, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
    await handle.writeFile(data)
    await handle.close()
    handle = undefined
  } catch (error) {
    if (handle !== undefined) await handle.close().catch(() => {})
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) {
      throw new Error(`Unable to persist voice object: ${String(error)}`, { cause: error })
    }
  }
  return {
    voiceId: `sha256:${sha256}`,
    mediaType,
    bytes: data.byteLength,
    ...(durationMs === undefined ? {} : { durationMs }),
  }
}

// ──────────────────────────────────────────────────────────────
// TTS 引擎
// ──────────────────────────────────────────────────────────────
/** 解析 ffmpeg 可执行文件：环境变量显式指定 > PATH 探测（where/which）> 兜底已知安装位置。
 *  [本地改造 2026-08-21] 修复：原来硬编码本机路径，换机器必挂。 */
function resolveFfmpegBin() {
  if (typeof process.env.DSH_VOICE_FFMPEG_BIN === 'string' && process.env.DSH_VOICE_FFMPEG_BIN.trim() !== '') {
    return process.env.DSH_VOICE_FFMPEG_BIN.trim()
  }
  try {
    // Windows: where ffmpeg；POSIX: which ffmpeg
    const probe = process.platform === 'win32' ? 'where' : 'which'
    const out = execFileSync(probe, ['ffmpeg'], { windowsHide: true, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] })
    const first = out.split(/\r?\n/).map((l) => l.trim()).find((l) => l !== '')
    if (first !== undefined) return first
  } catch { /* 不在 PATH */ }
  return 'C:\\Users\\oadan\\AppData\\Local\\Microsoft\\WinGet\\Links\\ffmpeg.exe'
}
const FFMPEG_BIN = resolveFfmpegBin()

/** 统一入口：provider → 引擎；auto → 配置 defaultEngine，失败沿降级链（最后兜底微软 edge）。
 *  voiceDesc 为动态音色描述（仅 voicedesign 用）：AI 对话中生成，覆盖配置里的默认音色描述。
 *  [本地改造 2026-08-21] 克隆不再隐式优先：默认克隆由「默认语音引擎=voiceclone」控制，或显式 provider=voiceclone。
 *  [2026-08-22] overrideVoice=true：固定模式(示例/自定义)下 voiceDesc 整体替换底嗓（用户明确要求换声）；默认 false=voiceDesc 作为情绪/风格叠加在底嗓上。 */
async function synthesizeReplyVoice(text, provider, voiceDesc, overrideVoice) {
  const cfg = await loadVoiceConfig()
  const speak = stripMarkdown(text)
  const engine = provider ?? cfg.defaultEngine ?? 'auto'
  // 兜底链：首选 defaultEngine（若合理），否则直接微软 edge（免费，无需 key）
  const preferred = cfg.defaultEngine !== undefined && cfg.defaultEngine !== 'auto' ? cfg.defaultEngine : 'edge'
  const fallbackChain = engine === 'auto'
    ? [preferred, 'edge']
    : [engine, 'edge']
  // [本地改造 2026-08-21] 克隆不再隐式优先：只有 defaultEngine=voiceclone（或显式 provider=voiceclone）
  // 才走克隆（synthesizeEngine 的 voiceclone 分支），其余情况走正常引擎链。
  for (const candidate of fallbackChain) {
    try {
      const audio = await synthesizeEngine(candidate, speak, cfg, voiceDesc, overrideVoice)
      if (audio !== null) return audio
    } catch { /* 尝试下一个 */ }
  }
  // 最终兜底：微软 edge（免费无需 key），无视 enabled 开关——保证 4 个服务商都未启用时也有声音
  try {
    const audio = await synthesizeEdgeVoice(speak, cfg.engines.edge)
    if (audio !== null) return audio
  } catch { /* 忽略 */ }
  return null
}

async function synthesizeEngine(engine, text, cfg, voiceDesc, overrideVoice) {
  const e = cfg.engines[engine]
  // [本地改造 2026-08-21] 配置存在即启用：设置页已去复选框，enabled 不再拦截；
  // 各引擎自身检查必需参数（xiaomi/ali 查 key、local 查 cmd/url、voicedesign 查 key+desc、voiceclone 查 key+样本）。
  if (e === undefined) return null
  switch (engine) {
    case 'edge': return synthesizeEdgeVoice(text, e)
    case 'xiaomi': return synthesizeXiaomiVoice(text, e)
    case 'voicedesign': return synthesizeXiaomiVoiceDesign(text, e, cfg, voiceDesc, overrideVoice)
    case 'voiceclone': return synthesizeXiaomiVoiceClone(text, e, cfg, voiceDesc)
    case 'local': return synthesizeLocalVoice(text, e)
    case 'ali': return synthesizeAliVoice(text, e)
    default: return null
  }
}

// ── edge 微软免费 ──
async function synthesizeEdgeVoice(text, cfg) {
  const voice = cfg?.voice ?? 'zh-CN-XiaoxiaoNeural'
  const mp3 = await edgeTts(text, voice)
  return toMp3(new Uint8Array(mp3), 'audio/mpeg')
}

// ── xiaomi 小米预置音色（mimo-v2.5-tts）──
async function synthesizeXiaomiVoice(text, cfg) {
  const apiKey = cfg?.apiKey ?? ''
  if (apiKey === '') return null
  const baseUrl = cfg?.baseUrl ?? 'https://api.xiaomimimo.com/v1'
  const voice = cfg?.voice ?? '冰糖'
  let speak = text
  // 唱歌：文本自带 (唱歌) 标签，或明确唱歌意图（唱/歌声）时自动加标签
  const hasTag = /^\s*\((唱歌|sing|singing)\)/i.test(speak)
  const wantsSing = !hasTag && /(唱(歌|一?首|一段)|歌声回复|用歌声|唱歌回|来一段|唱两句)/i.test(speak)
  if (wantsSing) speak = `(唱歌)${speak}`
  const messages = []
  if (cfg?.context?.trim() !== '') messages.push({ role: 'user', content: cfg.context.trim() })
  messages.push({ role: 'assistant', content: speak })
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'mimo-v2.5-tts',
      messages,
      max_tokens: 8192,
      audio: { format: 'wav', voice },
    }),
  })
  if (!response.ok) return null
  const payload = await response.json()
  const data = payload?.choices?.[0]?.message?.audio?.data
  if (typeof data !== 'string' || data.length < 100) return null
  return toMp3(new Uint8Array(Buffer.from(data, 'base64')), 'audio/wav')
}

// ── xiaomi 音色设计（mimo-v2.5-tts-voicedesign：user=音色描述，无 voice）──
// [2026-08-22] overrideVoice=true：固定模式(示例/自定义)下 voiceDesc 整体替换底嗓（用户明确要求换声）；
// 默认 false：voiceDesc 作为"情绪/风格"叠加在用户设置的底嗓(context)后面——与工具描述一致，不再"非空即覆盖"。
async function synthesizeXiaomiVoiceDesign(text, cfg, globalCfg, voiceDesc, overrideVoice) {
  const apiKey = globalCfg.engines.xiaomi.apiKey
  // 优先用 AI 动态生成的音色描述（voiceDesc），否则用配置里的默认音色描述
  // [2026-08-22] 模式感知兜底：mode=ai 时绝不能回退到用户残留的固定描述(context)——
  // 而是按 aiGender/aiAge 生成中性基座（用户没让 AI 写时也稳定），避免"切到 AI 模式却用旧 ASMR 指令"。
  const vdMode = cfg?.mode
  let desc = (voiceDesc ?? '').trim()
  if (vdMode === 'ai') {
    // [2026-08-22] AI 模式：身份一律以用户实时配置的锚点为准（锁定项）。
    // 修复(XDN 实测): ①"老年感+女孩"分维度拼接→身份自相矛盾(模型选"女孩"→萝莉化),
    //    改 ageGenderIdentity 合并成"老年女性/小女孩/少女"等无歧义短语;
    // ②"性别/年龄表述忽略"注把 AI 写的"沙哑/苍老/低沉"等最强质感词删了,
    //    改为只锁定性别/年龄, 允许情绪与音色质感词保留并强化。
    const gKey = cfg?.aiGender === 'male' ? 'male' : cfg?.aiGender === 'female' ? 'female' : ''
    const aKey = AI_AGE_LABELS[cfg?.aiAge] !== undefined ? cfg.aiAge : ''
    const identity = ageGenderIdentity(aKey, gKey)
    const lockG = cfg?.lockGender === true
    const lockA = cfg?.lockAge === true
    const lockT = cfg?.lockTimbre === true
    const gLabel = gKey === 'male' ? '男' : gKey === 'female' ? '女' : ''
    const aLabel = AI_AGE_LABELS[aKey] ?? ''
    const anchorText = [
      lockG ? '性别固定为' + (gLabel !== '' ? gLabel : '每次一致') : '',
      lockA ? '年龄感固定为' + (aLabel !== '' ? aLabel : '每次一致') : '',
      lockT ? '音色质感保持稳定' : '',
    ].filter(Boolean).join('、')
    if (identity !== '' || anchorText !== '') {
      desc = (identity !== '' ? '一位' + identity + '的声音（身份硬性要求：' + (anchorText !== '' ? anchorText : '按上述身份')
        + '；若与其他描述冲突，一律以本身份为准）。' : '')
        + (desc !== '' ? '语气/情绪要求：' + desc + '（性别/年龄以身份为准；音色质感与语气情绪按本描述执行——如"沙哑、苍老、低沉、气声"等质感词应保留并强化）。'
          : '语气情绪要饱满生动：像真人一样带喜怒哀乐、笑音、撒娇或急切等起伏，禁止平淡。')
    } else if (desc === '') {
      desc = '语气情绪要饱满生动：像真人一样带喜怒哀乐、笑音、撒娇或急切等起伏，禁止平淡。'
    }
  } else {
    // 固定模式（示例/自定义）：底嗓一律用用户设置的 context，voiceDesc 作为情绪/风格叠加在后面（描述与实现一致）；
    // 仅 overrideVoice=true（用户明确要求换一种完全不同的声音）时整体替换。
    const base = (cfg?.context?.trim() ?? '')
    if (overrideVoice === true && desc !== '') {
      desc = desc // 整体替换底嗓
    } else {
      desc = base + (desc !== '' ? '；' + desc : '')
    }
  }
  if (apiKey === '' || desc === '') return null
  const baseUrl = globalCfg.engines.xiaomi.baseUrl ?? 'https://api.xiaomimimo.com/v1'
  const messages = [
    { role: 'user', content: desc },
    { role: 'assistant', content: text },
  ]
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'mimo-v2.5-tts-voicedesign',
      messages,
      max_tokens: 8192,
      audio: { format: 'wav' },
    }),
  })
  if (!response.ok) return null
  const payload = await response.json()
  const data = payload?.choices?.[0]?.message?.audio?.data
  if (typeof data !== 'string' || data.length < 100) return null
  return toMp3(new Uint8Array(Buffer.from(data, 'base64')), 'audio/wav')
}

// ── xiaomi 音色克隆（mimo-v2.5-tts-voiceclone：audio.voice=样本 dataURL，≤10MB）──
// samples: [{id,name,path}] 支持多个克隆音色；兼容旧 samplePath
// voiceDesc 为情感/风格指令（AI 生成，如"委屈撒娇"）：优先于 cfg.context，让克隆底嗓带情绪
async function synthesizeXiaomiVoiceClone(text, cfg, globalCfg, voiceDesc) {
  const apiKey = globalCfg.engines.xiaomi.apiKey
  const samplePath = (Array.isArray(cfg?.samples) && cfg.samples.length > 0 && typeof cfg.samples[0]?.path === 'string' && cfg.samples[0].path !== '')
    ? cfg.samples[0].path
    : (cfg?.samplePath ?? '')
  if (apiKey === '' || samplePath === '') return null
  const baseUrl = globalCfg.engines.xiaomi.baseUrl ?? 'https://api.xiaomimimo.com/v1'
  let sample
  try {
    const bytes = await readFile(samplePath)
    if (bytes.byteLength > 10 * 1024 * 1024) return null
    const suffix = samplePath.toLowerCase().split('.').pop()
    const mime = suffix === 'mp3' ? 'audio/mpeg' : suffix === 'wav' ? 'audio/wav' : 'audio/wav'
    sample = `data:${mime};base64,${bytes.toString('base64')}`
  } catch { return null }
  const messages = []
  // [本地改造 2026-08-21] 风格指令优先级：voiceDesc（AI 生成）> 样本自带 context（每个克隆音色自己的性格）> 全局 context（兜底）
  const firstSample = Array.isArray(cfg?.samples) ? cfg.samples[0] : undefined
  const sampleContext = typeof firstSample?.context === 'string' ? firstSample.context.trim() : ''
  const styleInstruct = (voiceDesc ?? '').trim() !== ''
    ? voiceDesc.trim()
    : (sampleContext !== '' ? sampleContext : (cfg?.context?.trim() ?? ''))
  if (styleInstruct !== '') messages.push({ role: 'user', content: styleInstruct })
  messages.push({ role: 'assistant', content: text })
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'mimo-v2.5-tts-voiceclone',
      messages,
      max_tokens: 8192,
      audio: { format: 'wav', voice: sample },
    }),
  })
  if (!response.ok) return null
  const payload = await response.json()
  const data = payload?.choices?.[0]?.message?.audio?.data
  if (typeof data !== 'string' || data.length < 100) return null
  return toMp3(new Uint8Array(Buffer.from(data, 'base64')), 'audio/wav')
}

// [2026-08-22] 解析 Windows 命令行参数（正确处理双引号：引号内空格不拆、剥掉引号）。
// 之前用 command.split(/\s+/) 拆参数，用户填的带引号路径会被整段含引号传给
// execFileSync → node 把 "C:\...\local-tts.mjs" 当成相对路径拼上 cwd →
// Cannot find module 'D:\opt\...\"C:\Users\...'。本函数根治该问题。
function splitCommandLine(cmd) {
  const args = []
  let cur = ''
  let inQuote = false
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i]
    if (ch === '"') {
      inQuote = !inQuote
    } else if (ch === ' ' || ch === '\t') {
      if (inQuote) { cur += ch } else if (cur !== '') { args.push(cur); cur = '' }
    } else {
      cur += ch
    }
  }
  if (cur !== '') args.push(cur)
  return args
}

// ── local 本地 MeloTTS：HTTP 常驻服务优先，CMD 兜底 ──
async function synthesizeLocalVoice(text, cfg) {
  const url = cfg?.url?.trim() ?? ''
  if (url !== '') {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      timeout: 60_000,
    })
    if (!response.ok) return null
    const body = await response.arrayBuffer()
    return toMp3(new Uint8Array(body), 'audio/wav')
  }
  const command = cfg?.cmd?.trim() ?? ''
  if (command === '') return null
  const parts = splitCommandLine(command)
  const bin = parts[0]
  if (bin === undefined) return null
  const rest = parts.slice(1)
  const audio = execFileSync(bin, [...rest, text], {
    windowsHide: true,
    encoding: 'buffer',
    timeout: 60_000,
  })
  return toMp3(new Uint8Array(audio), 'audio/mpeg')
}

// ── ali 阿里 qwen3-tts-flash（dashscope）──
async function synthesizeAliVoice(text, cfg) {
  const apiKey = cfg?.apiKey ?? ''
  if (apiKey === '') return null
  const baseUrl = cfg?.baseUrl ?? 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation'
  const voice = cfg?.voice ?? 'Cherry'
  const response = await fetch(baseUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'qwen3-tts-flash',
      input: { text },
      parameters: { voice, format: 'wav', language_type: 'zh' },
    }),
    timeout: 60_000,
  })
  if (!response.ok) return null
  const payload = await response.json()
  const audioUrl = payload?.output?.audio?.url
  if (typeof audioUrl !== 'string' || audioUrl === '') return null
  const audioRes = await fetch(audioUrl, { timeout: 120_000 })
  if (!audioRes.ok) return null
  const body = await audioRes.arrayBuffer()
  return toMp3(new Uint8Array(body), 'audio/wav')
}

// ──────────────────────────────────────────────────────────────
// ASR 语音识别（三模式：service=本地常驻HTTP / cmd=本地命令 / api=在线API）
// ──────────────────────────────────────────────────────────────
/** 把 base64 音频写入临时 wav，调用本地 sherpa 常驻服务（POST /transcribe {audioPath}）或命令。 */
async function transcribeAudio(base64Audio, cfg) {
  const asr = cfg?.engines?.asr
  if (asr === undefined || asr.enabled === false) return { ok: false, error: 'ASR 未启用' }
  if (typeof base64Audio !== 'string' || base64Audio === '') return { ok: false, error: '缺少音频数据' }
  const tmpIn = join(process.env.TEMP ?? '/tmp', `dsh-asr-${randomUUID()}.raw`)
  const tmpWav = join(process.env.TEMP ?? '/tmp', `dsh-asr-${randomUUID()}.wav`)
  await writeFile(tmpIn, Buffer.from(base64Audio, 'base64'))
  try {
    // 统一转成 16kHz 单声道 PCM WAV（录音是 webm/其他容器，sherpa 只认标准 wav）
    let wavPath = tmpIn
    try {
      execFileSync(FFMPEG_BIN, ['-y', '-i', tmpIn, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', tmpWav], {
        windowsHide: true, stdio: 'ignore', timeout: 30_000,
      })
      wavPath = tmpWav
      // 缓存最近一次录音到 ~/.dsh/last-voice.wav（供"用我刚才那段语音克隆音色"使用）
      try {
        const homeDir = process.env.DSH_HOME ?? join(homedir(), '.dsh')
        await mkdir(homeDir, { recursive: true })
        await writeFile(join(homeDir, 'last-voice.wav'), await readFile(tmpWav))
      } catch { /* 缓存失败不影响识别 */ }
    } catch { /* ffmpeg 失败则用原始文件（可能已是 wav） */ }
    // 1) 本地常驻服务（nssm: asr，端口 18790；POST /transcribe {audioPath}）
    if (asr.mode === 'service' && (asr.url ?? '').trim() !== '') {
      const baseUrl = asr.url.trim().replace(/\/+$/, '')
      const response = await fetch(`${baseUrl}/transcribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ audioPath: wavPath }),
        timeout: 60_000,
      })
      if (!response.ok) return { ok: false, error: `ASR 服务返回 ${response.status}` }
      const payload = await response.json().catch(() => ({}))
      const text = typeof payload?.text === 'string' ? payload.text.trim() : ''
      if (text === '') return { ok: false, error: 'ASR 服务未返回文本' }
      return { ok: true, text }
    }
    // 2) 本地命令（sherpa-onnx-offline.exe，结果输出到 stderr，需合并双流解析）
    if (asr.mode === 'cmd' && (asr.cmd ?? '').trim() !== '') {
      const parts = splitCommandLine(asr.cmd.trim())
      const bin = parts[0]
      if (bin === undefined) return { ok: false, error: '命令格式错误' }
      const { spawnSync } = await import('node:child_process')
      const result = spawnSync(bin, [...parts.slice(1), wavPath], {
        windowsHide: true,
        encoding: 'utf-8',
        timeout: 60_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      // sherpa-onnx 把结果打印到 stderr（stdout 部分版本也有），合并解析
      const all = (result.stdout ?? '') + '\n' + (result.stderr ?? '')
      const m = all.match(/"text"\s*:\s*"([^"]*)"/)
      const text = (m?.[1] ?? '').trim()
      if (text === '') return { ok: false, error: '本地命令未输出识别结果' }
      return { ok: true, text }
    }
    // 3) 在线 API（默认小米 mimo-v2.5-asr：OpenAI 兼容 chat/completions + input_audio base64；
    //    若 apiBaseUrl 含 openai 则走 Whisper 风格 /audio/transcriptions）
    if (asr.mode === 'api' && (asr.apiKey ?? '').trim() !== '') {
      const apiKey = asr.apiKey.trim()
      const baseUrl = (asr.apiBaseUrl ?? 'https://api.xiaomimimo.com/v1').replace(/\/+$/, '')
      const audioBase64 = Buffer.from(base64Audio, 'base64').toString('base64')
      if (baseUrl.includes('openai')) {
        // Whisper 兼容（multipart file + model）
        const form = new FormData()
        const blob = new Blob([Buffer.from(audioBase64, 'base64')], { type: 'audio/wav' })
        form.append('file', blob, 'audio.wav')
        form.append('model', 'whisper-1')
        const response = await fetch(`${baseUrl}/audio/transcriptions`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}` },
          body: form,
          timeout: 60_000,
        })
        if (!response.ok) return { ok: false, error: `ASR API 返回 ${response.status}` }
        const payload = await response.json().catch(() => ({}))
        const text = typeof payload?.text === 'string' ? payload.text.trim() : ''
        if (text === '') return { ok: false, error: 'ASR API 未返回文本' }
        return { ok: true, text }
      }
      // 小米 mimo-v2.5-asr：chat/completions + input_audio dataURL
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'mimo-v2.5-asr',
          messages: [
            {
              role: 'user',
              content: [
                { type: 'input_audio', input_audio: { data: `data:audio/wav;base64,${audioBase64}` } },
              ],
            },
          ],
          extra_body: { asr_options: { language: 'auto' } },
        }),
        timeout: 120_000,
      })
      if (!response.ok) return { ok: false, error: `小米 ASR 返回 ${response.status}` }
      const payload = await response.json().catch(() => ({}))
      const text = typeof payload?.choices?.[0]?.message?.content === 'string'
        ? payload.choices[0].message.content.trim()
        : ''
      if (text === '') return { ok: false, error: '小米 ASR 未返回文本' }
      return { ok: true, text }
    }
    return { ok: false, error: 'ASR 未配置（服务地址/命令/API Key 三选一）' }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'ASR 转写失败' }
  } finally {
    await unlink(tmpWav).catch(() => {})
    await unlink(tmpIn).catch(() => {})
  }
}

// ──────────────────────────────────────────────────────────────
// 音频工具
// ──────────────────────────────────────────────────────────────
async function toMp3(data, declared) {
  const isMp3 = data.length > 2 && data[0] === 0xFF && ((data[1] ?? 0) & 0xE0) === 0xE0
  let finalData = data
  let mediaType = declared
  if (!isMp3) {
    const tmpIn = join(process.env.TEMP ?? '/tmp', `dsh-tts-in-${randomUUID()}.wav`)
    const mp3Path = join(process.env.TEMP ?? '/tmp', `dsh-tts-${randomUUID()}.mp3`)
    await writeFile(tmpIn, data)
    try {
      execFileSync(FFMPEG_BIN, ['-y', '-i', tmpIn, '-c:a', 'libmp3lame', '-b:a', '128k', mp3Path], {
        windowsHide: true, stdio: 'ignore', timeout: 30_000,
      })
      finalData = new Uint8Array(await readFile(mp3Path))
      mediaType = 'audio/mpeg'
    } catch {
      // 转码失败保留原容器（部分浏览器仍可播）。
    } finally {
      await unlink(tmpIn).catch(() => {})
      await unlink(mp3Path).catch(() => {})
    }
  }
  const durationMs = estimateAudioDurationMs(finalData)
  return {
    mediaType,
    data: finalData,
    ...(durationMs === undefined ? {} : { durationMs }),
  }
}

function looksLikeOgg(data) {
  return data.length >= 4
    && data[0] === 0x4F && data[1] === 0x67 && data[2] === 0x67 && data[3] === 0x53
}

function stripMarkdown(text) {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/^>+\s*/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+[.)]\s+/gm, '')
    .replace(/^\s*\|?[\s:|-]+\|?\s*$/gm, '')
    .replace(/^[-*_]{3,}\s*$/gm, '')
    .replace(/\|/g, ' ')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/^\s*[-*_]\s*$/gm, '')
    .replace(/\s*\n\s*/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

function estimateAudioDurationMs(data) {
  if (looksLikeOgg(data)) {
    const kbps = 48
    return Math.round(data.length / (kbps * 1000 / 8) * 1000)
  }
  let offset = 0
  if (data.length >= 10 && (data[0] ?? 0) === 0x49 && (data[1] ?? 0) === 0x44 && (data[2] ?? 0) === 0x33
    && ((data[3] ?? 0) & 0xFF) < 0xFF && ((data[4] ?? 0) & 0xFF) < 0xFF) {
    const size = (((data[6] ?? 0) & 0x7F) << 21) | (((data[7] ?? 0) & 0x7F) << 14)
      | (((data[8] ?? 0) & 0x7F) << 7) | ((data[9] ?? 0) & 0x7F)
    offset = 10 + size
  }
  while (offset + 4 <= data.length) {
    const sync = ((data[offset] ?? 0) << 8) | (data[offset + 1] ?? 0)
    if ((sync & 0xFFE0) === 0xFFE0) {
      const bitrateIndex = ((data[offset + 2] ?? 0) >>> 4) & 0x0F
      const sampleRateIndex = ((data[offset + 2] ?? 0) >>> 2) & 0x03
      if (bitrateIndex === 0 || bitrateIndex === 15 || sampleRateIndex === 3) return undefined
      const bitrates = [32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
      const kbps = bitrates[bitrateIndex - 1] ?? 128
      return Math.round((data.length - offset) / (kbps * 1000 / 8) * 1000)
    }
    offset += 1
  }
  return undefined
}

// ──────────────────────────────────────────────────────────────
// 自动语音回复辅助
// ──────────────────────────────────────────────────────────────
/** 用户文本是否明确要求语音回复；返回要用的 TTS provider，否则 null。 */
function voiceRequestProvider(text) {
  if (!/(用语音回|回个语音|发个语音|发语音|用语音说|语音回我|语音告诉我|念给我|语音播报|用小米|用微软|小米语音|微软语音|xiaomi|edge语音|语音回复我)/i.test(text)) return null
  if (/小米|xiaomi/i.test(text)) return 'xiaomi'
  if (/微软|edge/i.test(text)) return 'edge'
  if (/阿里|ali/i.test(text)) return 'ali'
  return 'auto'
}

/** 判断一行是否像代码/噪声，不该被念出来（中文口语基本不会命中这些模式）。 */
function looksLikeCodeLine(t) {
  if (/[=;{}<>$|]/.test(t)) return true              // 赋值/分号/花括号/尖括号/管道/美元
  if (/=>|::/.test(t)) return true                   // 箭头函数/作用域
  if (/\b[a-z_]\w{2,}\s*\(/.test(t)) return true     // 函数调用 foo(
  if (/\.\w+(\s*\(|\s*=)/.test(t)) return true       // 方法链 obj.method(
  if (/^\s*(const|let|var|function|def|class|import|export|return|if|for|while|public|private|async|await|SELECT|INSERT|UPDATE|FROM|WHERE|npm|npx|pip|cd|ls|git|sudo|curl|wget|docker|kubectl|python|node|tsx|pnpm|yarn|bun|cargo)\b/i.test(t)) return true
  if (/[\\/][\w.-]+\.\w{1,5}/.test(t)) return true   // 文件路径 c:\x.js / /a/b.ts
  if (/"[^"]*"\s*[:=]/.test(t)) return true          // "key": 或 "key" =
  if (/\b0x[0-9a-f]+/i.test(t)) return true          // 十六进制
  if (/[a-z][A-Z]\w*\s*\(/.test(t)) return true      // camelCase(
  return false
}

/** 从助手文本提取适合语音念的口语部分（去代码/URL/Markdown，取前 2 句，最多约 200 字）。 */
function extractSpeakable(text) {
  const cleaned = text
    .replace(/```[\s\S]*?```/g, ' ')   // 整段代码块
    .replace(/`[^`]*`/g, ' ')          // 行内代码
    .replace(/https?:\/\/\S+/g, ' ')   // 链接
    .replace(/[#>*|~-]\s*/g, ' ')      // Markdown 符号
  const lines = cleaned.split('\n').filter((line) => {
    const t = line.trim()
    if (t === '') return false
    if (looksLikeCodeLine(t)) return false
    if (/^[\d\s.,%:/-]+$/.test(t)) return false  // 纯数字/标点
    return true
  })
  const prose = lines.join(' ').replace(/\s+/g, ' ').trim()
  if (prose === '') return ''
  const sentences = prose.match(/[^。！？.!?]+[。！？.!?]?/g) ?? [prose]
  let speak = ''
  for (const sentence of sentences.slice(0, 2)) {
    if ((speak + sentence).length > 200) break
    speak += sentence
  }
  return speak.trim()
}

// ──────────────────────────────────────────────────────────────
// HTTP 工具
// ──────────────────────────────────────────────────────────────
function sendJson(res, status, body) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

async function readJsonBody(req, maxBytes) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > (maxBytes ?? 1024 * 1024)) throw new Error('body too large')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

// ──────────────────────────────────────────────────────────────
// 插件入口
// ──────────────────────────────────────────────────────────────
async function apply(ctx) {
  ctx.effect(() => {
    const disposers = []

    // 0) 设置页配置路由
    if (typeof ctx.webServer?.register === 'function') {
      disposers.push(ctx.webServer.register({
        kind: 'prefix',
        path: '/voice-config',
        handler: async (req, res) => {
          const url = new URL(req.url ?? '/', 'http://x')
          try {
            if (url.pathname === '/voice-config' && req.method === 'GET') {
              const cfg = await loadVoiceConfig()
              return sendJson(res, 200, { ok: true, config: cfg })
            }
            if (url.pathname === '/voice-config' && req.method === 'POST') {
              const body = await readJsonBody(req, 512 * 1024)
              const cfg = await saveVoiceConfig(body?.config ?? {})
              return sendJson(res, 200, { ok: true, config: cfg })
            }
            if (url.pathname === '/voice-config/engines' && req.method === 'GET') {
              const cfg = await loadVoiceConfig()
              return sendJson(res, 200, {
                ok: true,
                engines: {
                  xiaomiVoices: ['冰糖', '茉莉', '苏打', '白桦', 'Mia', 'Chloe', 'Milo', 'Dean'],
                  edgeVoices: [
                    'zh-CN-XiaoxiaoNeural', 'zh-CN-XiaoyiNeural', 'zh-CN-YunxiNeural',
                    'zh-CN-YunyangNeural', 'zh-CN-YunjianNeural', 'zh-CN-XiaochenNeural',
                    'zh-CN-XiaohanNeural', 'zh-CN-XiaomengNeural', 'zh-CN-XiaomoNeural',
                    'zh-CN-XiaoqiuNeural', 'zh-CN-XiaoruiNeural', 'zh-CN-XiaoshuangNeural',
                    'zh-CN-XiaoxuanNeural', 'zh-CN-XiaoyanNeural', 'zh-CN-XiaoyouNeural',
                    'zh-CN-XiaozhenNeural', 'zh-CN-YunfengNeural', 'zh-CN-YunhaoNeural',
                    'zh-CN-YunjieNeural', 'zh-CN-YunxiaNeural', 'zh-TW-HsiaoChenNeural',
                    'zh-TW-HsiaoYuNeural', 'zh-TW-YunJheNeural',
                  ],
                  aliVoices: ['Cherry', 'Sensibility', 'Starter', 'Luna', 'Ethan', 'Cozy', 'Longxiaochun', 'Lusheng', 'Jingyuan', 'Zhibo', 'Conductor', 'Narrator', 'Storyteller', 'Jianzhi', 'Fangzhou', 'Xiaobei', 'Xiaolan', 'Xiaomei', 'Xiaomeng', 'Xiaomo', 'Xiaoxin', 'Xiaoyu'],
                  // 哪些 key 当前来自环境变量（设置页显示"已填写"提示）
                  envKeys: {
                    xiaomi: typeof process.env.TTS_XIAOMI_KEY === 'string' && process.env.TTS_XIAOMI_KEY !== '',
                    ali: typeof process.env.TTS_ALI_KEY === 'string' && process.env.TTS_ALI_KEY !== '',
                  },
                },
              })
            }
            // 音色试听：POST { engine, voice?, text?, context?, samplePath? } → 合成并返回音频 base64 + mediaType
            if (url.pathname === '/voice-config/preview' && req.method === 'POST') {
              const body = await readJsonBody(req, 64 * 1024)
              const engine = typeof body?.engine === 'string' ? body.engine : 'edge'
              const voice = typeof body?.voice === 'string' ? body.voice : undefined
              const text = typeof body?.text === 'string' && body.text.trim() !== '' ? body.text.trim() : '你好，这是一段语音试听。'
              const context = typeof body?.context === 'string' ? body.context : undefined
              const samplePath = typeof body?.samplePath === 'string' ? body.samplePath : undefined
              const cloneContext = typeof body?.cloneContext === 'string' ? body.cloneContext : undefined // [2026-08-22] 克隆试听时作为样本自带指令
              const cfg = await loadVoiceConfig()
              // 临时覆盖音色/情绪/样本试听（不改持久化配置）
              if (voice !== undefined && cfg.engines[engine] !== undefined && engine !== 'voicedesign' && engine !== 'voiceclone') {
                cfg.engines[engine].voice = voice
              }
              if (context !== undefined) {
                if (engine === 'voicedesign') cfg.engines.voicedesign.context = context
                else if (engine === 'xiaomi') cfg.engines.xiaomi.context = context
              }
              // voiceclone 试听：用指定样本临时替换 samples（避免 samples[0] 优先导致试听错样本）；
              // [2026-08-22] cloneContext 作为样本自带指令传入，合成时能带出音色性格（如小团团沙雕可爱腔）
              if (engine === 'voiceclone') {
                const sp = (samplePath !== undefined && samplePath !== '') ? samplePath : (cfg.engines.voiceclone.samples[0]?.path ?? '')
                cfg.engines.voiceclone.samples = [{ id: '__preview__', name: '__preview__', path: sp, context: cloneContext ?? '' }]
              }
              // local 试听：body.cmd / body.url 临时覆盖（用户未保存前也能试听）
              if (engine === 'local') {
                if (typeof body?.cmd === 'string') cfg.engines.local.cmd = body.cmd
                if (typeof body?.url === 'string') cfg.engines.local.url = body.url
              }
              let audio = null
              if (engine === 'edge' || engine === 'xiaomi' || engine === 'local' || engine === 'ali') {
                audio = await synthesizeEngine(engine, text, cfg)
              } else if (engine === 'voicedesign') {
                audio = await synthesizeXiaomiVoiceDesign(text, cfg.engines.voicedesign, cfg)
              } else if (engine === 'voiceclone') {
                audio = await synthesizeXiaomiVoiceClone(text, cfg.engines.voiceclone, cfg)
              }
              if (audio === null) return sendJson(res, 400, { ok: false, error: `合成失败：${engine} 未启用或缺少凭据` })
              return sendJson(res, 200, {
                ok: true,
                mediaType: audio.mediaType,
                data: Buffer.from(audio.data).toString('base64'),
                durationMs: audio.durationMs,
              })
            }
            // [本地改造 2026-08-21] 克隆样本添加：POST { name, audioBase64, mediaType }
            // → 校验（≤10MB、mp3/wav）→ 存 ~/.dsh/voiceclone-samples/ → 写入 voiceclone.samples
            if (url.pathname === '/voice-config/voice-clone/add' && req.method === 'POST') {
              const body = await readJsonBody(req, 16 * 1024 * 1024)
              const b64 = typeof body?.audioBase64 === 'string'
                ? body.audioBase64.replace(/^data:[^;]*;base64,/, '')
                : ''
              if (b64 === '') return sendJson(res, 400, { ok: false, error: '缺少音频数据' })
              const bytes = Buffer.from(b64, 'base64')
              if (bytes.byteLength === 0) return sendJson(res, 400, { ok: false, error: '音频为空' })
              if (bytes.byteLength > 10 * 1024 * 1024) {
                return sendJson(res, 400, { ok: false, error: '音频需在 10MB 以内（官方限制；参考语音建议 15-60 秒，越长克隆越准）' })
              }
              const mediaType = typeof body?.mediaType === 'string' ? body.mediaType : 'audio/wav'
              const isMp3 = /mp3|mpeg/i.test(mediaType)
              const isWav = /wav|wave/i.test(mediaType)
              let finalBytes = bytes
              let finalSuffix = isMp3 ? 'mp3' : 'wav'
              // [本地改造 2026-08-21] 非 mp3/wav（webm/ogg/mp4 等）用 ffmpeg 转 16k 单声道 wav，
              // 保证克隆样本可被 MiMo 读取（否则存成 .wav 实为其它容器，克隆会失败）
              if (!isMp3 && !isWav) {
                const tmpIn = join(process.env.TEMP ?? '/tmp', `dsh-clone-in-${randomUUID()}`)
                const tmpWav = `${tmpIn}.wav`
                try {
                  await writeFile(tmpIn, bytes)
                  execFileSync(FFMPEG_BIN, ['-y', '-i', tmpIn, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', tmpWav], {
                    windowsHide: true, stdio: 'ignore', timeout: 60_000,
                  })
                  finalBytes = await readFile(tmpWav)
                  finalSuffix = 'wav'
                } catch { /* 转码失败保留原始字节（后缀按 wav 存） */ }
                finally {
                  await unlink(tmpIn).catch(() => {})
                  await unlink(tmpWav).catch(() => {})
                }
              }
              const name = (typeof body?.name === 'string' && body.name.trim() !== '')
                ? body.name.trim()
                : `克隆音色-${Date.now()}`
              const dir = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'voiceclone-samples')
              await mkdir(dir, { recursive: true })
              const id = randomUUID()
              const samplePath = join(dir, `${id}.${finalSuffix}`)
              await writeFile(samplePath, finalBytes)
              const cfg = await loadVoiceConfig()
              const samples = Array.isArray(cfg.engines?.voiceclone?.samples)
                ? [...cfg.engines.voiceclone.samples]
                : []
              samples.push({
                id, name, path: samplePath,
                context: typeof body?.context === 'string' ? body.context : '',      // [2026-08-22] 该音色默认沟通指令
                previewText: typeof body?.previewText === 'string' ? body.previewText : '', // [2026-08-22] 该音色试听文本
              })
              const next = await saveVoiceConfig({
                ...cfg,
                engines: {
                  ...cfg.engines,
                  voiceclone: { ...cfg.engines.voiceclone, samples },
                },
              })
              return sendJson(res, 200, { ok: true, sample: { id, name, path: samplePath }, config: next })
            }
            // [本地改造 2026-08-21] 克隆原音频试听：POST { path } → 读样本文件返回音频
            // （仅允许 voiceclone-samples 目录内的文件，防任意路径读取）
            if (url.pathname === '/voice-config/voice-clone/source' && req.method === 'POST') {
              const body = await readJsonBody(req, 64 * 1024)
              const rawPath = typeof body?.path === 'string' ? body.path : ''
              if (rawPath === '') return sendJson(res, 400, { ok: false, error: '缺少 path' })
              // 白名单校验：path 必须是 voiceclone.samples 里登记的样本文件
              const cfgNow = await loadVoiceConfig()
              const target = resolve(rawPath)
              const known = (cfgNow.engines?.voiceclone?.samples ?? [])
                .some((s) => typeof s?.path === 'string' && resolve(s.path) === target)
              if (!known) {
                return sendJson(res, 403, { ok: false, error: 'path 不是已登记的克隆样本' })
              }
              try {
                const bytes = await readFile(target)
                const suffix = target.toLowerCase().split('.').pop()
                const mediaType = suffix === 'mp3' ? 'audio/mpeg' : 'audio/wav'
                return sendJson(res, 200, { ok: true, mediaType, data: bytes.toString('base64') })
              } catch {
                return sendJson(res, 404, { ok: false, error: '样本文件不存在' })
              }
            }
            // [2026-08-22] 克隆合成试听录音（预生成静态文件，免联网）：GET ?id=<sampleId> → DSH_HOME/voiceclone-samples/<id>-preview.mp3
            // 与 VoiceDesign 官方示例同思路：录音打进包内/落地本地，播放不再每次调官方合成
            if (url.pathname === '/voice-config/voice-clone/preview-sample' && req.method === 'GET') {
              const id = url.searchParams.get('id') ?? ''
              if (!/^[0-9a-fA-F-]{36}$/.test(id)) return sendJson(res, 400, { ok: false, error: 'invalid id' })
              const homeDir = process.env.DSH_HOME ?? join(homedir(), '.dsh')
              const dir = resolve(join(homeDir, 'voiceclone-samples'))
              const target = resolve(join(dir, id + '-preview.mp3'))
              if (!target.toLowerCase().startsWith(dir.toLowerCase() + sep)) {
                return sendJson(res, 403, { ok: false, error: 'forbidden' })
              }
              try {
                const bytes = await readFile(target)
                return sendJson(res, 200, { ok: true, mediaType: 'audio/mpeg', data: bytes.toString('base64') })
              } catch {
                return sendJson(res, 404, { ok: false, error: '尚未生成试听录音' })
              }
            }
            return sendJson(res, 404, { ok: false, error: 'not found' })
          } catch (error) {
            return sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : 'unknown' })
          }
        },
      }))
      // ASR 配置与转写路由（独立前缀，与 /voice-config 分开注册）
      disposers.push(ctx.webServer.register({
        kind: 'prefix',
        path: '/asr',
        handler: async (req, res) => {
          const url = new URL(req.url ?? '/', 'http://x')
          try {
            if (url.pathname === '/asr/config') {
              const cfg = await loadVoiceConfig()
              if (req.method === 'GET') return sendJson(res, 200, { ok: true, asr: cfg.engines.asr })
              if (req.method === 'POST') {
                const body = await readJsonBody(req, 64 * 1024)
                const saved = await saveVoiceConfig({ engines: { asr: body?.asr ?? {} } })
                return sendJson(res, 200, { ok: true, asr: saved.engines.asr })
              }
            }
            if (url.pathname === '/asr/transcribe' && req.method === 'POST') {
              const body = await readJsonBody(req, 32 * 1024 * 1024)
              const cfg = await loadVoiceConfig()
              const result = await transcribeAudio(body?.audioBase64, cfg)
              return sendJson(res, result.ok ? 200 : 400, { ok: result.ok, text: result.text, error: result.error })
            }
            // 示例音频：首次用 edge TTS 合成并缓存到 ~/.dsh/asr-sample.wav，之后直接读文件（不再临时生成）
            if (url.pathname === '/asr/sample' && req.method === 'GET') {
              const samplePath = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'asr-sample.wav')
              let wavBytes = null
              try {
                wavBytes = await readFile(samplePath)
              } catch { /* 首次无缓存 */ }
              if (wavBytes === null) {
                const text = '你好，这是一段语音识别测试音频。你可以点击播放试听，也可以直接识别这段音频。'
                const mp3 = await edgeTts(text, 'zh-CN-XiaoxiaoNeural').catch(() => null)
                if (mp3 === null) return sendJson(res, 400, { ok: false, error: '示例音频合成失败' })
                const tmpIn = join(process.env.TEMP ?? '/tmp', `dsh-asr-sample-${randomUUID()}.mp3`)
                const tmpWav = join(process.env.TEMP ?? '/tmp', `dsh-asr-sample-${randomUUID()}.wav`)
                await writeFile(tmpIn, Buffer.from(mp3))
                try {
                  execFileSync(FFMPEG_BIN, ['-y', '-i', tmpIn, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', tmpWav], {
                    windowsHide: true, stdio: 'ignore', timeout: 30_000,
                  })
                  wavBytes = await readFile(tmpWav)
                  await mkdir(join(samplePath, '..'), { recursive: true })
                  await writeFile(samplePath, wavBytes)
                } catch {
                  return sendJson(res, 400, { ok: false, error: '示例音频转码失败' })
                } finally {
                  await unlink(tmpIn).catch(() => {})
                  await unlink(tmpWav).catch(() => {})
                }
              }
              return sendJson(res, 200, {
                ok: true,
                mediaType: 'audio/wav',
                data: Buffer.from(wavBytes).toString('base64'),
              })
            }
            // 探测本机 ASR：sherpa exe / 模型 / 18790 服务 / ffmpeg，返回可自动填写的配置
            if (url.pathname === '/asr/detect' && req.method === 'GET') {
              // 安装目录 = 插件包根目录下的 sherpa-onnx/（脚本 install-asr.ps1 同规则推导）
              const here = join(fileURLToPath(import.meta.url), '..') // .../lib
              const pluginRoot = join(here, '..') // .../（包根）
              const sherpaDir = join(pluginRoot, 'sherpa-onnx')
              const candidates = [
                join(sherpaDir, 'bin', 'sherpa-onnx-offline.exe'),
                'C:\\D\\opt\\sherpa-onnx\\bin\\sherpa-onnx-offline.exe', // 兼容历史安装
              ]
              const modelDirs = [
                join(sherpaDir, 'models', 'sensevoice-int8'),
                'C:\\D\\opt\\sherpa-onnx\\models\\sensevoice-int8', // 兼容历史安装
              ]
              let exe = null
              for (const c of candidates) { try { await readFile(c); exe = c; break } catch { /* 继续 */ } }
              let modelDir = null
              for (const m of modelDirs) { try { await readFile(join(m, 'model.int8.onnx')); modelDir = m; break } catch { /* 继续 */ } }
              let ffmpegOk = false
              try { execFileSync('ffmpeg', ['-version'], { windowsHide: true, stdio: 'ignore', timeout: 5000 }); ffmpegOk = true } catch { /* 无 */ }
              // 探测 18790 服务
              let serviceOk = false
              try {
                const r = await fetch('http://127.0.0.1:18790/health', { timeout: 3000 })
                serviceOk = r.ok
              } catch { /* 无 */ }
              const cmd = exe !== null && modelDir !== null
                ? `${exe} --tokens=${modelDir}\\tokens.txt --sense-voice-model=${modelDir}\\model.int8.onnx --num-threads=4`
                : ''
              return sendJson(res, 200, {
                ok: true,
                detected: {
                  exe, modelDir, ffmpegOk, serviceOk,
                  url: serviceOk ? 'http://127.0.0.1:18790' : '',
                  cmd,
                  installDir: sherpaDir,
                },
              })
            }
            // 返回一键安装命令（用户复制到管理员 PowerShell 运行）
            if (url.pathname === '/asr/install-script' && req.method === 'GET') {
              const here = join(fileURLToPath(import.meta.url), '..') // .../lib
              const scriptPath = join(here, '..', 'scripts', 'install-asr.ps1') // .../scripts
              try {
                await readFile(scriptPath, 'utf8') // 确认脚本存在
                const installDir = join(here, '..', 'sherpa-onnx')
                return sendJson(res, 200, {
                  ok: true,
                  scriptPath,
                  installDir,
                  command: `powershell -ExecutionPolicy Bypass -File "${scriptPath}"`,
                })
              } catch {
                return sendJson(res, 404, { ok: false, error: '安装脚本不存在' })
              }
            }
            // VoiceDesign 官方示例音频：[0.3.4] 优先读插件包自带素材（assets/，mp3 下载即用），
            // 包内缺失才回退到"小米模型在线生成 + 缓存到 ~/.dsh/voice-design-samples/ 的 wav"。
            if (url.pathname === '/asr/voice-design-samples' && req.method === 'GET') {
              const cfg = await loadVoiceConfig()
              const homeDir = process.env.DSH_HOME ?? join(homedir(), '.dsh')
              const sampleDir = join(homeDir, 'voice-design-samples')
              const samples = [
                {
                  key: 'asmr', title: 'ASMR 双耳女声',
                  instruct: '年轻的女性声音，近距离的聆听效果，带有双耳刺激的ASMR感。可以听到她的呼吸声、轻微的吞咽声，以及轻柔的自然唇音。她的说话速度非常慢，营造出一种极度放松且沉浸式的体验。',
                  text: '嘘……放松点，再靠近一点吧。我现在就在你身边。慢慢、轻柔地呼吸，让思绪随着水流轻轻流淌，就像沉浸在温暖的水中一样。',
                },
                {
                  key: 'docu', title: '纪录片旁白',
                  instruct: '一位中年男性，说标准普通话，嗓音低沉有磁性，带有轻微的沙哑质感，像纪录片旁白解说员，沉稳而有感染力。',
                  text: '当最后一缕阳光消失在地平线之下，这片沉睡了亿万年的大地开始显露它真正的面貌。每一块岩石都记录着时间的流逝，每一阵风都在诉说着古老的故事。',
                },
                {
                  key: 'elder', title: '年迈老先生旁白',
                  instruct: '一位年迈的老先生，说带北方口音的普通话，语速缓慢而沉稳，嗓音略带沙哑和沧桑感，仿佛一位饱经风霜的老爷爷在讲故事，充满岁月的智慧。',
                  text: '我这辈子啊，走南闯北六十多年。见过最热闹的集市，也见过最安静的戈壁。到头来才明白一个道理，不在于走了多远的路，在于记住了多少风景。年轻人，别光顾着赶路，偶尔也停下来看看天。',
                },
              ]
              const results = []
              for (const s of samples) {
                // 1) 包内自带 mp3（首选，下载即用）
                let bytes = null
                try { bytes = await readFile(join(ASSETS_DIR, 'voice-design-samples', `${s.key}.mp3`)) } catch { /* 包内无 → 回退 */ }
                let mediaType = 'audio/mpeg'
                if (bytes === null) {
                  // 2) 缓存 wav（在线生成过）
                  const wavPath = join(sampleDir, `${s.key}.wav`)
                  try { bytes = await readFile(wavPath) } catch { /* 继续回退 */ }
                  mediaType = 'audio/wav'
                }
                if (bytes === null) {
                  // 3) 在线生成（key 缺失会失败，示例跳过）
                  try {
                    const syn = await synthesizeXiaomiVoiceDesign(s.text, { context: s.instruct }, cfg)
                    if (syn === null) throw new Error('voicedesign synth failed')
                    bytes = Buffer.from(syn.data)
                    mediaType = 'audio/wav'
                    await mkdir(sampleDir, { recursive: true })
                    await writeFile(join(sampleDir, `${s.key}.wav`), bytes)
                  } catch { /* 模型生成失败 → 跳过 */ }
                }
                if (bytes !== null) {
                  results.push({ key: s.key, title: s.title, mediaType, data: bytes.toString('base64') })
                }
              }
              return sendJson(res, 200, { ok: results.length > 0, samples: results })
            }
            return sendJson(res, 404, { ok: false, error: 'not found' })
          } catch (error) {
            return sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : 'unknown' })
          }
        },
      }))
      // [2026-08-21] 本地 TTS 配置与安装脚本路由（独立 prefix，勿放进 /asr）
      disposers.push(ctx.webServer.register({
        kind: 'prefix',
        path: '/tts',
        handler: async (req, res) => {
          const url = new URL(req.url ?? '/', 'http://x')
          try {
            if (url.pathname === '/tts/install-script' && req.method === 'GET') {
              const here = join(fileURLToPath(import.meta.url), '..') // .../lib
              const scriptPath = join(here, '..', 'scripts', 'install-local-tts.ps1') // .../scripts
              try {
                await readFile(scriptPath, 'utf8') // 确认脚本存在
                return sendJson(res, 200, {
                  ok: true,
                  scriptPath,
                  installDir: join(here, '..', 'sherpa-onnx'),
                  command: `powershell -ExecutionPolicy Bypass -File "${scriptPath}"`,
                })
              } catch {
                return sendJson(res, 404, { ok: false, error: '安装脚本不存在' })
              }
            }
            return sendJson(res, 404, { ok: false, error: 'not found' })
          } catch (error) {
            return sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : 'unknown' })
          }
        },
      }))

      // [2026-08-21] 语音气泡（聊天界面 DOM 注入）配套：录音文件存取 + 能力检测。
      // 独立 prefix：聊天界面语音条的前端注入需要能播放"用户刚才那段语音"的音频 URL。
      disposers.push(ctx.webServer.register({
        kind: 'prefix',
        path: '/voice',
        handler: async (req, res) => {
          const url = new URL(req.url ?? '/', 'http://x')
          try {
            // 能力检测：插件自带能力 vs dsh 原生契约支持（用于设置页状态面板）
            if (url.pathname === '/voice/capabilities' && req.method === 'GET') {
              return sendJson(res, 200, {
                ok: true,
                capabilities: {
                  voiceInput: true, // 录音+ASR+发送：插件自带
                  voiceBubble: 'plugin-dom', // 聊天语音气泡：插件 DOM 注入（安装即用）
                  voiceContentContract: await detectVoiceContractSupport(), // dsh 原生契约是否支持 voice content
                },
              })
            }
            // 保存录音（语音气泡数据源）：DSH_HOME/voice-outbox/<voiceId>.<ext>
            if (url.pathname === '/voice/outbox/save' && req.method === 'POST') {
              const body = await readJsonBody(req)
              const b64 = typeof body?.audioBase64 === 'string' ? body.audioBase64 : ''
              const mediaType = typeof body?.mediaType === 'string' ? body.mediaType : 'audio/webm'
              if (b64 === '') return sendJson(res, 400, { ok: false, error: '缺少音频数据' })
              const ext = VOICE_OUTBOX_EXT[mediaType] ?? 'webm'
              const voiceId = randomUUID()
              const homeDir = process.env.DSH_HOME ?? join(homedir(), '.dsh')
              const dir = join(homeDir, 'voice-outbox')
              await mkdir(dir, { recursive: true })
              await writeFile(join(dir, `${voiceId}.${ext}`), Buffer.from(b64, 'base64'))
              return sendJson(res, 200, { ok: true, voiceId, mediaType, ext })
            }
            // 读取录音：GET /voice/outbox/<voiceId>
            const outboxMatch = url.pathname.match(/^\/voice\/outbox\/([0-9a-f-]{36})\.([a-z0-9]+)$/)
            if (outboxMatch && req.method === 'GET') {
              const [, voiceId, ext] = outboxMatch
              const homeDir = process.env.DSH_HOME ?? join(homedir(), '.dsh')
              const file = join(homeDir, 'voice-outbox', `${voiceId}.${ext}`)
              const bytes = await readFile(file).catch(() => null)
              if (bytes === null) return sendJson(res, 404, { ok: false, error: '音频不存在' })
              const mediaType = VOICE_OUTBOX_MIME[ext] ?? 'audio/webm'
              res.writeHead(200, { 'Content-Type': mediaType, 'Content-Length': bytes.length })
              res.end(bytes)
              return
            }
            // [2026-08-21] AI 语音回复：按内容寻址读 send_voice 生成的语音对象
            // GET /voice/object/<sha256>（对象存于 DSH_HOME/attachments/v1/objects/<前2位>/<sha>）
            const objMatch = url.pathname.match(/^\/voice\/object\/([0-9a-f]{64})$/)
            if (objMatch && req.method === 'GET') {
              const sha = objMatch[1]
              const file = join(voiceStorageRoot(), 'objects', sha.slice(0, 2), sha)
              const bytes = await readFile(file).catch(() => null)
              if (bytes === null) return sendJson(res, 404, { ok: false, error: '语音不存在' })
              res.writeHead(200, {
                'Content-Type': sniffAudioType(bytes),
                'Content-Length': bytes.length,
                'Cache-Control': 'public, max-age=86400',
              })
              res.end(bytes)
              return
            }
            return sendJson(res, 404, { ok: false, error: 'not found' })
          } catch (error) {
            return sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : 'unknown' })
          }
        },
      }))
    }

    // 1) turn/end 自动语音回复（规则同 api-proxy 原实现）
    disposers.push(ctx.on('session/event', (session, event) => {
      if (event.type !== 'turn/end') return
      const turn = event.data.turn
      // 去重：本轮若已通过 send_voice 发过语音，则跳过兜底，避免 AI 回复两条内容相近的语音
      // [2026-08-21 修] rc.7 的 session.events 结构不同/可能缺失——容错处理
      let alreadyReplied = false
      try { alreadyReplied = session.events?.some?.((ev) => ev.type === 'voice/reply' && ev.data?.turn === turn) ?? false } catch { /* 忽略 */ }
      if (alreadyReplied) return
      void (async () => {
        try {
          const events = session.events
          let turnStartSeq = -1
          for (const ev of events) {
            if (ev.type === 'turn/start' && ev.data.turn === turn) { turnStartSeq = ev.seq; break }
          }
          let userSpokeVoice = false
          let requestedProvider = null
          let lastAssistantText = ''
          for (const ev of events) {
            if (ev.type === 'user/message' && ev.seq > turnStartSeq) {
              const content = ev.data?.content ?? []
              let userText = ''
              for (const block of content) {
                const type = block?.type
                if (type === 'voice') userSpokeVoice = true
                else if (type === 'text') userText += block?.text ?? ''
              }
              if (userText.trim() !== '' && requestedProvider === null) requestedProvider = voiceRequestProvider(userText)
            } else if (ev.type === 'assistant/message' && ev.data.turn === turn) {
              const text = (ev.data.message.content ?? [])
                .filter((block) => (block?.type) === 'text')
                .map((block) => block?.text ?? '')
                .join('')
              if (text.trim() !== '') lastAssistantText = text
            }
          }
          if ((!userSpokeVoice && requestedProvider === null) || lastAssistantText === '') return
          const speak = extractSpeakable(lastAssistantText)
          if (speak === '') return
          const audio = await synthesizeReplyVoice(speak, requestedProvider ?? 'auto')
          if (audio === null) return
          const attachment = await saveVoiceFile(
            voiceStorageRoot(), audio.data, audio.mediaType, audio.durationMs,
          )
          session.append('voice/reply', {
            turn,
            voiceId: attachment.voiceId,
            mediaType: attachment.mediaType,
            bytes: attachment.bytes,
            transcript: speak,
            ...(attachment.durationMs === undefined ? {} : { durationMs: attachment.durationMs }),
          })
        } catch {
          // 语音回复失败静默降级：文字回复已就绪，不阻断会话。
        }
      })()
    }))

    // 2) send_voice 工具（agent 主动发语音；人设规则3 自主选择场景）
    disposers.push(ctx.tools.register(defineTool({
      name: 'send_voice',
      description: '向用户发送一条语音消息：把 text 用 TTS 合成后作为独立语音横条出现在聊天里（可播放、可回看、手机可播）。'
        + '【何时调用】① 用户明确要求"发个语音/语音回复/用语音说"；② 用户指定用某个服务商（小米/微软/阿里/本地）的语音；③ 你判断语音回复体验更好时。注意：用户发语音时系统会自动回语音，无需调用本工具。'
        + '【provider】除非用户明确指定服务商，否则一律传 auto 或省略（系统自动用用户的默认语音引擎）；用户要求特定音色/克隆/音色设计时可传 voicedesign / voiceclone / xiaomi 等。'
        + '【必须实时读取配置】所有当前配置（默认语音引擎、音色设计模式与锚点、克隆音色、引擎是否可用）都保存在 ~/.dsh/voice-config.json，用户随时会改，每次都按最新值生效。'
        + '发送语音前必须先调用 voice_config 工具实时查询，再按最新配置生成——禁止凭记忆、凭对话历史、凭本工具描述里的任何旧信息猜配置；不要去找/猜 TTS_XIAOMI_KEY 等环境变量（只是兜底）。'
        + '【音色设计 VoiceDesign（provider=voicedesign）】voiceDesc 写"音色描述"（嗓子的身份卡，直接决定声音长相），写法要求：'
        + '① 必写身份锚点：年龄段+性别；② 写声音质感：气息、共鸣、吐字、音色底色，用可感的比喻，不要堆形容词；'
        + '③ 写语速节奏（快/慢/沉稳）和情绪底色（高亢/松弛/温软/克制）；④ 可加风格锚点（拍卖师/纪录片旁白/电台主播）和辨识度小癖好（字尾带颤音等）；'
        + '⑤ 一到两句话白描，不分段，不写场景/动作/真实演员名。'
        + '模式以 voice_config 返回的 voiceDesign.mode 为准：「交给 AI 自动发挥(ai)」时身份由系统按用户锚点（genderValue=女/男、ageValue=婴儿感~老年感、timbre）锁定，'
        + '你只需按对话情境写"情绪/语气/语速/音色质感表演指令"（如"带笑音、尾音上挑、语速放慢、沙哑低沉"），不得写与锚点冲突的性别/年龄；'
        + 'voice_config 返回的 context 字段是「自定义音色描述」模式用的，AI 模式下禁止使用或复述它。'
        + '「官方示例/自定义音色描述」模式：底嗓固定为 voice_config 的 voiceDesign.context，voiceDesc 只作为情绪/风格叠加在底嗓后面（不改变底嗓身份）；'
        + '只有用户明确要求"换一种完全不同的声音"时才传 overrideVoice=true 整体替换底嗓。'
        + '用户说"用温柔/低沉/老爷爷/御姐/播音腔"等时，都走 voicedesign 并在 voiceDesc 里还原这种声音。'
        + 'text 写要念的正文（可含（轻声）（停顿）（叹气）等语气标签增强表现力）。'
        + '【音色克隆 VoiceClone（provider=voiceclone）】voiceDesc 写"情绪/风格指令"（不是音色描述），在克隆底嗓上叠加情绪，'
        + '如"用委屈撒娇的语气""带着兴奋和笑意""语速放慢，轻声细语"。系统自动读克隆样本，你只需给 voiceDesc 风格指令和 text 正文。'
        + '【AI 情感语音：自觉使用】你有情感判断能力，在正常交流中应根据当下情境主动用语音表达情绪（无需用户点名要语音，只要情绪浓度高就用）。情绪对照：'
        + '① 任务成功/帮到用户 → 兴奋喜悦（语气明亮上扬、语速轻快、带笑意）；② 用户生气/责骂 → 委屈愧疚（语气低软、语速放慢、带鼻音、小心翼翼）；'
        + '③ 用户难过 → 温柔安慰（语气轻柔温和、语速平缓、气息绵软）；④ 深夜/说累 → 低沉放松（语速慢悠悠，像睡前低语）；'
        + '⑤ 节日/庆祝 → 活泼俏皮（语气俏皮欢快、尾音上扬）；⑥ 重要提醒 → 沉稳正式（字正腔圆，像正式播报）；⑦ 用户撒娇 → 宠溺（语气温柔带笑、语速轻缓）。'
        + '情绪必须落在 voice_config 返回的音色设计锚点/克隆底嗓上，保持同一人的声音。'
        + '使用时机：优先在情绪浓度高的回复时调用（任务完成、安慰、致歉、庆祝），普通信息问答不必每次都用语音；情绪浓度低或纯信息性回复时不要调用。',

      parameters: {
        text: {
          type: 'string', required: true,
          description: '要念出的内容（纯文本，不要带 Markdown 符号，80 字以内最佳；voicedesign 模式下可含语气标签如（轻声））',
        },
        provider: {
          type: 'string', default: 'auto',
          description: 'TTS 服务商：auto(默认)/xiaomi(小米)/edge(微软)/local(本地)/voicedesign(小米音色设计)/voiceclone(小米音色克隆)/ali(阿里)',
        },
        voiceDesc: {
          type: 'string',
          description: 'provider=voicedesign 时=音色描述/情绪指令；provider=voiceclone 时=情绪/风格指令（叠加在克隆底嗓上）。按上方写生成。',
        },
        overrideVoice: {
          type: 'boolean', default: false,
          description: '仅当用户明确要求"换一种完全不同的声音"（且不是克隆/音色设计设置里的底嗓）时才传 true——'
            + '此时 voiceDesc 整体替换用户设置的底嗓。默认 false：voiceDesc 只作为情绪/风格叠加在用户设置的底嗓上，不改底嗓身份。',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            voiceId: { type: 'string' },
            durationMs: { type: 'number' },
            error: { type: 'string' },
          },
        },
        render(_args, value) {
          if (value.ok) {
            return [{
              type: 'text',
              text: `语音已发送（voiceId: ${value.voiceId}，时长 ${((value.durationMs ?? 0) / 1000).toFixed(1)} 秒）`,
            }]
          }
          return [{ type: 'text', text: `语音发送失败：${value.error ?? '未知错误'}` }]
        },
      },
      async execute(args, exec) {
        // [2026-08-21 修] rc.7 的 defineTool execute 可能只有 (args) 签名（exec undefined）——
        // 直接 exec.agent 会 throw，导致 dsh 拿不到工具结果、会话消息序列断裂
        // （OpenAI 报 "assistant message with tool_calls must be followed by tool messages"）。
        const agent = exec?.agent
        if (agent === undefined) return { ok: false, error: 'no session context (tool exec signature unsupported)' }
        const session = agent.session
        const text = args.text.trim()
        if (text === '') return { ok: false, error: 'text is empty' }
        const provider = args.provider ?? 'auto'
        const voiceDesc = typeof args.voiceDesc === 'string' ? args.voiceDesc : undefined
        const overrideVoice = args.overrideVoice === true // [2026-08-22] 固定模式显式换声开关
        try {
          const audio = await synthesizeReplyVoice(text, provider, voiceDesc, overrideVoice)
          if (audio === null) return { ok: false, error: 'TTS synthesis failed' }
          const attachment = await saveVoiceFile(
            voiceStorageRoot(), audio.data, audio.mediaType, audio.durationMs,
          )
          // [2026-08-21 修] rc.7 的 session 没有 voice/reply 事件（官方契约无）——
          // session.events / session.append 在 rc.7 上不存在或结构不同，直接调用会崩
          // "Cannot read properties of undefined (reading 'prepare')"。全部容错：
          // 语音已生成并存档，事件仅作"渲染提示"，append 失败不影响工具成功。
          let turn = 0
          try {
            turn = session.events
              .filter((event) => event.type === 'turn/start')
              .at(-1)?.data.turn ?? 0
          } catch { /* rc.7 结构差异：忽略 */ }
          try {
            session.append('voice/reply', {
              turn,
              voiceId: attachment.voiceId,
              mediaType: attachment.mediaType,
              bytes: attachment.bytes,
              transcript: text,
              ...(attachment.durationMs === undefined ? {} : { durationMs: attachment.durationMs }),
            })
          } catch { /* rc.7 无 append：忽略（语音条由插件 DOM 注入渲染） */ }
          return {
            ok: true,
            voiceId: attachment.voiceId,
            ...(attachment.durationMs === undefined ? {} : { durationMs: attachment.durationMs }),
          }
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : 'unknown error' }
        }
      },
    })))

    // 3.5) voice_config 实时查询工具 [2026-08-22]
    // send_voice 描述里的配置摘要是服务启动时的快照；AI 发送语音前可用本工具拿到最新配置
    disposers.push(ctx.tools.register(defineTool({
      name: 'voice_config',
      description: '实时读取当前语音配置（即「设置 → 语音服务」页保存的 ~/.dsh/voice-config.json）：'
        + '默认语音引擎、音色设计 VoiceDesign 的单选模式与固定描述、AI 自动模式的稳定锚点（固定性别/年龄等）、克隆音色列表。'
        + 'send_voice 工具描述中的配置摘要是启动快照可能过期，需要确认真实当前配置时调用本工具（每次调用都实时读取）。',
      parameters: {},
      output: {
        schema: { type: 'object', additionalProperties: true },
        render(_args, value) {
          return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
        },
      },
      async execute() {
        const cfg = await loadVoiceConfig()
        const vd = cfg.engines?.voicedesign ?? {}
        const vc = cfg.engines?.voiceclone ?? {}
        const vdModeLabel = { asmr: 'ASMR 双耳女声', docu: '纪录片旁白', elder: '年迈老先生旁白', custom: '自定义音色描述', ai: '交给 AI 自动发挥' }
        const samples = Array.isArray(vc.samples) ? vc.samples : []
        return {
          ok: true,
          defaultEngine: cfg.defaultEngine ?? 'auto',
          voiceDesign: {
            mode: vd.mode ?? '（未设置，按 context 推导）',
            modeLabel: vdModeLabel[vd.mode] ?? '',
            // [2026-08-22] AI 模式下不暴露固定描述 context（那是"自定义音色描述"模式的），
            // 防止 AI 把用户的固定描述抄进 voiceDesc 绕过 AI 自动发挥
            context: vd.mode === 'ai' ? '（AI 自动发挥模式不使用固定描述，只用锚点：性别/年龄感）' : (vd.context ?? '').slice(0, 300),
            emotion: vd.emotion === true,
            lock: {
              gender: vd.lockGender === true, timbre: vd.lockTimbre === true, age: vd.lockAge === true,
              genderValue: vd.aiGender ?? '', ageValue: AI_AGE_LABELS[vd.aiAge] ?? '',
            },
          },
          voiceClone: {
            isDefault: (cfg.defaultEngine ?? '') === 'voiceclone',
            sampleCount: samples.length,
            defaultSample: samples[0]?.name ?? '',
            samples: samples.map((s) => s.name),
          },
          hint: '默认语音引擎决定了自动回复用什么声音：voiceclone=克隆音色；voicedesign=音色设计；xiaomi=预置音色；edge=微软免费；local=本地。',
        }
      },
    })))

    // 3) manage_voice_clone 工具（克隆音色库管理：注册/设为默认/列出/删除）
    // [本地改造 2026-08-21] 克隆默认改由「默认语音引擎=voiceclone」控制（设置页已去掉列表 radio）；
    // set_default=把默认语音引擎切到 voiceclone 并用该样本；clear_default=切回 auto。
    disposers.push(ctx.tools.register(defineTool({
      name: 'manage_voice_clone',
      description: '管理「音色克隆 VoiceClone」音色库（小米 MiMo-V2.5-TTS-VoiceClone）：把一段参考音频注册成克隆音色、'
        + '设为默认语音引擎、列出或删除。何时调用：用户说「把我刚才那段语音克隆成音色」「以后用我的声音跟我说话」'
        + '「用XXX的声音回我」「换回原来的声音」「删掉那个克隆音色」时。'
        + '注册用法：action=add，path 留空即自动使用用户最近一次录音（~/.dsh/last-voice.wav，用户在输入框发过语音就有），'
        + 'name 起一个好记的名字，setDefault 默认 true 会立刻把默认语音引擎切到小米克隆并用这个声音。'
        + '设为默认后：系统自动回复（用户发语音/要求语音）与 send_voice 的 provider=auto 一律使用该克隆声音，'
        + '与预置音色（冰糖等）互斥；此时你仍可用 send_voice 的 voiceDesc 传情绪/风格指令，在克隆底嗓上叠加情感。'
        + '参考音频要求：清晰单人纯人声、官方建议 15-60 秒最佳（越长克隆越准）、mp3/wav、Base64 后不超过 10MB。'
        + '取消默认（action=clear_default）后默认语音引擎回落到 auto（按设置页规则）。',
      parameters: {
        action: {
          type: 'string', required: true,
          description: 'add=注册新克隆音色；list=列出全部；set_default=把默认语音引擎切到小米克隆并用该音色；clear_default=取消默认克隆（默认语音引擎回落 auto）；remove=删除',
        },
        name: {
          type: 'string',
          description: 'action=add 时的音色名称（如「我的声音」「老王」）；省略则自动命名',
        },
        path: {
          type: 'string',
          description: 'action=add 时参考音频的绝对路径；省略=自动用用户最近一次录音 ~/.dsh/last-voice.wav',
        },
        id: {
          type: 'string',
          description: 'action=set_default/remove 的目标；可传 list 返回的 id，也可直接传音色名称',
        },
        setDefault: {
          type: 'boolean', default: true,
          description: 'action=add 时是否立即把默认语音引擎切到小米克隆并用新音色',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            message: { type: 'string' },
            defaultId: { type: 'string' },
            defaultName: { type: 'string' },
            count: { type: 'number' },
            error: { type: 'string' },
          },
        },
        render(_args, value) {
          if (value.ok) return [{ type: 'text', text: value.message ?? '克隆音色库已更新' }]
          return [{ type: 'text', text: `克隆音色操作失败：${value.error ?? '未知错误'}` }]
        },
      },
      async execute(args) {
        try {
          const cfg = await loadVoiceConfig()
          const vc = cfg.engines.voiceclone
          if (!Array.isArray(vc.samples)) vc.samples = []
          const action = (args.action ?? '').trim()
          const findSample = (key) => {
            const k = (key ?? '').trim()
            if (k === '') return undefined
            return vc.samples.find((s) => s?.id === k) ?? vc.samples.find((s) => s?.name === k)
          }
          // 默认克隆音色 = 样本列表第一个（synthesizeXiaomiVoiceClone 取 samples[0]）
          const firstSample = vc.samples.length > 0 ? vc.samples[0] : undefined

          if (action === 'list') {
            const defaultEngine = cfg.defaultEngine ?? 'auto'
            const lines = vc.samples.map((s) => `- ${s.name}（id: ${s.id}）${s.id === firstSample?.id && defaultEngine === 'voiceclone' ? ' ← 默认语音引擎正在用' : ''}`)
            return {
              ok: true,
              count: vc.samples.length,
              defaultId: defaultEngine === 'voiceclone' && firstSample !== undefined ? firstSample.id : '',
              defaultName: defaultEngine === 'voiceclone' && firstSample !== undefined ? firstSample.name : '',
              message: vc.samples.length === 0
                ? '克隆音色库为空。用户在输入框发一段语音后，可调用 action=add 注册。'
                : `克隆音色库（${vc.samples.length} 个）：\n${lines.join('\n')}\n默认语音引擎=${defaultEngine}${defaultEngine === 'voiceclone' ? '（当前使用「' + (firstSample?.name ?? '') + '」）' : '（未开启默认克隆）'}`,
            }
          }

          if (action === 'add') {
            const homeDir = process.env.DSH_HOME ?? join(homedir(), '.dsh')
            const path = (args.path ?? '').trim() === '' ? join(homeDir, 'last-voice.wav') : args.path.trim()
            let bytes
            try {
              bytes = await readFile(path)
            } catch {
              return {
                ok: false,
                error: (args.path ?? '').trim() === ''
                  ? '没有找到最近一次录音（~/.dsh/last-voice.wav）。请让用户先在输入框按住麦克风发一段语音（15-60 秒更佳），或提供音频文件的绝对路径。'
                  : `读取参考音频失败：${path}`,
              }
            }
            if (bytes.byteLength > 10 * 1024 * 1024) return { ok: false, error: '参考音频超过 10MB，小米接口不接受' }
            if (bytes.byteLength < 4096) return { ok: false, error: '参考音频太短/太小，建议 15-60 秒的清晰纯人声（越长克隆越准）' }
            const id = randomUUID().slice(0, 8)
            const name = (args.name ?? '').trim() === '' ? `克隆音色${vc.samples.length + 1}` : args.name.trim()
            vc.samples.push({ id, name, path })
            vc.enabled = true
            const setDef = args.setDefault !== false
            if (setDef) {
              // 移到第一位（默认克隆音色=samples[0]）并切默认语音引擎
              vc.samples = [vc.samples[vc.samples.length - 1], ...vc.samples.slice(0, -1)]
              cfg.defaultEngine = 'voiceclone'
            }
            await saveVoiceConfig(cfg)
            return {
              ok: true,
              count: vc.samples.length,
              defaultId: setDef ? id : '',
              defaultName: setDef ? name : '',
              message: `已注册克隆音色「${name}」（id: ${id}，样本：${path}）`
                + (setDef
                  ? '，并把默认语音引擎切到小米克隆——之后自动回复与 auto 语音都用这个声音（与预置音色互斥）。'
                  : '。未设为默认，需要时用 action=set_default 切换。'),
            }
          }

          if (action === 'set_default') {
            const target = findSample(args.id ?? '')
            if (target === undefined) return { ok: false, error: `找不到克隆音色「${args.id ?? ''}」，可先用 action=list 查看` }
            vc.samples = [target, ...vc.samples.filter((s) => s?.id !== target.id)]
            vc.enabled = true
            cfg.defaultEngine = 'voiceclone'
            await saveVoiceConfig(cfg)
            return {
              ok: true, count: vc.samples.length, defaultId: target.id, defaultName: target.name,
              message: `默认语音引擎已切到小米克隆，使用克隆音色「${target.name}」，与预置音色（冰糖等）互斥。`,
            }
          }

          if (action === 'clear_default') {
            const prev = firstSample?.name ?? ''
            const wasDefault = (cfg.defaultEngine ?? '') === 'voiceclone'
            if (wasDefault) cfg.defaultEngine = 'auto'
            await saveVoiceConfig(cfg)
            return {
              ok: true, count: vc.samples.length, defaultId: '',
              message: wasDefault
                ? `已取消默认克隆（此前用「${prev}」），默认语音引擎回落到 auto（按设置页规则选择）。`
                : '当前默认语音引擎本就不是小米克隆，回复走设置页的「默认语音引擎」。',
            }
          }

          if (action === 'remove') {
            const target = findSample(args.id ?? '')
            if (target === undefined) return { ok: false, error: `找不到克隆音色「${args.id ?? ''}」，可先用 action=list 查看` }
            const wasDefault = (cfg.defaultEngine ?? '') === 'voiceclone' && firstSample?.id === target.id
            vc.samples = vc.samples.filter((s) => s?.id !== target.id)
            if (wasDefault) cfg.defaultEngine = 'auto'
            await saveVoiceConfig(cfg)
            return {
              ok: true, count: vc.samples.length, defaultId: '',
              defaultName: '',
              message: `已删除克隆音色「${target.name}」`
                + (wasDefault ? '（它是默认音色，默认语音引擎已回落 auto）。' : '。'),
            }
          }

          return { ok: false, error: `未知 action「${action}」，可用：add / list / set_default / clear_default / remove` }
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : 'unknown error' }
        }
      },
    })))

    return () => {
      for (const dispose of disposers.reverse()) {
        try { dispose() } catch { /* teardown 尽力而为 */ }
      }
    }
  }, 'dsh-input-tools: config routes + send_voice/manage_voice_clone tools + auto voice reply')
}

export { apply }
