// 一次性脚本：为小团团生成"预生成合成试听录音"（带 persona 指令），落盘三处：
//   1) 源码仓 assets/voiceclone-samples/<id>-preview.mp3（提交，别人下载即可试听）
//   2) 运行时包 assets/voiceclone-samples/<id>-preview.mp3
//   3) DSH_HOME/voiceclone-samples/<id>-preview.mp3（服务静态服务读取处）
// 依赖：dsh-web 服务正在运行（127.0.0.1:3080，含小米 API Key 配置）
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(HERE, '..')
const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const ID = '8da38fcc-b041-4f5b-86b9-901956016f89'

// 1) 从 voice-config.json 取小团团样本（含 context 指令）
const cfg = JSON.parse(await readFile(join(DSH_HOME, 'voice-config.json'), 'utf8'))
const samples = cfg?.engines?.voiceclone?.samples ?? []
const target = samples.find((s) => s.id === ID) ?? samples[0]
if (!target?.path) { console.error('FAIL: 未找到小团团样本'); process.exit(1) }
const context = (target.context ?? '').trim()
console.log('sample:', target.name, '| path:', target.path, '| contextLen:', context.length)

// 2) 从 client.js 提取 CLONE_PREVIEW_TEXT
const clientSrc = await readFile(join(REPO_ROOT, 'lib', 'client.js'), 'utf8')
const m = clientSrc.match(/const CLONE_PREVIEW_TEXT = "([\s\S]*?)";/)
if (!m) { console.error('FAIL: 未找到 CLONE_PREVIEW_TEXT'); process.exit(1) }
const text = m[1]
console.log('previewTextLen:', text.length)

// 3) 调服务合成（带 persona 指令）
const body = { engine: 'voiceclone', samplePath: target.path, text, cloneContext: context }
const r = await fetch('http://127.0.0.1:3080/voice-config/preview', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})
const d = await r.json()
if (!d?.ok) { console.error('FAIL: 合成失败 ->', JSON.stringify(d)); process.exit(1) }
console.log('synth ok, mediaType:', d.mediaType, 'durationMs:', d.durationMs, 'dataLen:', d.data.length)
const bytes = Buffer.from(d.data, 'base64')
const name = ID + '-preview.mp3'

// 4) 落盘三处
const dests = [
  join(REPO_ROOT, 'assets', 'voiceclone-samples', name),
  join(process.env.RUNTIME_PLUGIN ?? join(DSH_HOME, 'profiles', 'node_modules', '@oadank', 'dsh-input-tools'), 'assets', 'voiceclone-samples', name),
  join(DSH_HOME, 'voiceclone-samples', name),
]
for (const p of dests) {
  await mkdir(dirname(p), { recursive: true })
  await writeFile(p, bytes)
  console.log('WROTE', p, bytes.length, 'bytes')
}
console.log('DONE')
