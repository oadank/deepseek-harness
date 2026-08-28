/**
 * Boot-time backend resolution for the adaptive directory-picker composition:
 * one pure decision from sampled host facts to a concrete backend kind. The
 * caller samples exactly once per boot, so the mounted capability stays
 * stable for the service lifetime as the seam requires.
 * @module @deepseek-ai/dsh-host-directory-picker-auto/resolve
 */

import type { Config as HttpServerConfig } from '@deepseek-ai/dsh-host-webserver'

/** Concrete interaction backend the resolver chooses between. */
export type DirectoryPickerBackendKind = 'native' | 'browse'

/** Environment keys the resolution reads (a `process.env` subset). */
export type DirectoryPickerEnv = Readonly<
  Partial<
    Record<
      | 'SSH_CONNECTION'
      | 'SSH_TTY'
      | 'DISPLAY'
      | 'WAYLAND_DISPLAY'
      | 'DSH_FORCE_BROWSE_PICKER'
      | 'DSH_FORCE_NATIVE_PICKER',
      string
    >
  >
>

/** Host facts the backend choice is a pure function of, sampled once at boot. */
export interface DirectoryPickerHostFacts {
  /** Effective webserver bind host (the schema's closed loopback/all-interfaces union). */
  bindHost: HttpServerConfig['host']
  /** Host process platform. */
  platform: NodeJS.Platform
  /** Environment sample; SSH marks a remote operator, DISPLAY/WAYLAND_DISPLAY a Linux display. */
  env: DirectoryPickerEnv
  /** Whether a Linux chooser binary the native backend can drive (zenity/kdialog) is on PATH; consulted only when `platform` is linux. */
  linuxChooser: boolean
}

/** An env value counts only when set and non-blank (an empty export is "unset" by shell convention). */
const present = (value: string | undefined): boolean => value !== undefined && value !== ''

/**
 * Resolve which backend serves this boot. `native` requires every signal that
 * the operator can see the host display and the native backend can serve it:
 * a loopback-only bind (an all-interfaces bind admits remote browsers no OS
 * chooser can reach), no SSH launch (under SSH port-forwarding the chooser
 * would open on the unattended server), and a servable display session —
 * assumed on darwin/win32, requiring `DISPLAY`/`WAYLAND_DISPLAY` plus a
 * chooser binary on linux, and never true elsewhere (the native backend
 * drives exactly darwin/win32/linux). Anything ambiguous resolves to
 * `browse`, which works everywhere.
 * @param facts - the sampled host facts.
 * @returns the backend kind to mount.
 */
export function resolveDirectoryPickerBackend(facts: DirectoryPickerHostFacts): DirectoryPickerBackendKind {
  // [本地改造 2026-08-23] 反向开关：DSH_FORCE_NATIVE_PICKER=1 → 强制 native（本地桌面临时恢复原生弹窗）
  if (facts.env.DSH_FORCE_NATIVE_PICKER === '1') return 'native'
  // [本地改造 2026-08-13] DSH_FORCE_BROWSE_PICKER=1 → 强制 browse（浏览器目录树）：
  // Windows nssm 服务跑在 session 0，原生 IFileOpenDialog COM 对话框无交互桌面
  // 弹不出（pick 卡死）。browse 是纯 HTTP 目录列表，session 0 完全可用。
  if (facts.env.DSH_FORCE_BROWSE_PICKER === '1') return 'browse'
  if (facts.bindHost !== '127.0.0.1') return 'browse'
  if (present(facts.env.SSH_CONNECTION) || present(facts.env.SSH_TTY)) return 'browse'
  // [本地改造 2026-08-23] win32 默认回落 browse：绝大多数 Windows 部署是 nssm 服务
  // （session 0 弹不出原生对话框），网页目录树对本地/远程都可用，开箱即用不再踩坑。
  // 需要原生弹窗的桌面用户显式设 DSH_FORCE_NATIVE_PICKER=1。
  if (facts.platform === 'win32') return 'browse'
  if (facts.platform === 'darwin') return 'native'
  if (facts.platform !== 'linux' || !facts.linuxChooser) return 'browse'
  return present(facts.env.DISPLAY) || present(facts.env.WAYLAND_DISPLAY) ? 'native' : 'browse'
}
