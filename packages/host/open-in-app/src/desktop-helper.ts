/**
 * Windows Session-1 launch bridge for open-in-app.
 *
 * dsh-web runs as an nssm service in session 0. Spawning `explorer.exe` or a
 * GUI from session 0 reports success but the window lands on the invisible
 * service desktop. `win-desktop-helper` (shot-service, :18800) runs in the
 * interactive user session and exposes `GET /app/run` (ShellExecute in
 * session 1). Prefer it on win32; fall back to the in-process launcher when
 * the helper is down so headless hosts still answer the route.
 */

/** Default loopback base of win-desktop-helper. */
const DESKTOP_HELPER_BASE = process.env['DSH_DESKTOP_HELPER_URL'] ?? 'http://127.0.0.1:18800'

/** How one helper launch attempt ended; `unavailable` means fall back locally. */
export type DesktopHelperLaunchOutcome = 'launched' | 'unavailable' | 'failed'

/**
 * Launch one command (or a directory) through win-desktop-helper's session-1
 * ShellExecute endpoint.
 * @param target - executable path or directory to open.
 * @param args - argv for an executable; ignored when `target` is a directory.
 * @param timeoutMs - HTTP deadline for the helper call (AppRun waits up to
 *   ~7.5s for a window, so the default leaves headroom).
 * @returns `launched` on helper ok, `failed` when the helper refused,
 *   `unavailable` when the helper cannot be reached.
 */
export async function launchViaDesktopHelper(
  target: string,
  args: readonly string[],
  timeoutMs = 15000,
): Promise<DesktopHelperLaunchOutcome> {
  const url = new URL('/app/run', DESKTOP_HELPER_BASE)
  url.searchParams.set('path', target)
  if (args.length > 0) {
    // ProcessStartInfo.Arguments splits on bare spaces; quote any arg that
    // carries one so `--cd=C:\Program Files\...` stays a single argv element.
    const quoted = args.map(arg => /\s/.test(arg) && !/^".*"$/.test(arg) ? `"${arg}"` : arg)
    url.searchParams.set('args', quoted.join(' '))
  }
  try {
    const response = await fetch(url, {
      method: 'GET',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: 'application/json' },
    })
    if (!response.ok) return 'failed'
    const body = await response.json() as { ok?: unknown }
    return body.ok === true ? 'launched' : 'failed'
  } catch {
    // Network refusal, timeout, or non-JSON body: the helper is not a usable
    // launch channel right now, so the caller falls back to a local spawn.
    return 'unavailable'
  }
}
