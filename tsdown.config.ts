import { readdirSync, existsSync } from 'node:fs'
import { join, relative } from 'node:path'
import { defineConfig } from 'tsdown'
import { typertPlugin } from './packages/typert/generator/lib/types/tsdown-plugin.js'

function isBuildFaceClient(value: unknown): boolean {
  if (value === undefined || value === 'host') return false
  if (value === 'client') return true
  throw new Error(`tsdown: --env.DSH_BUILD_FACE must be host or client, received ${String(value)}`)
}

/** Collect monorepo package dirs that actually emit host `lib/types/index.js`. */
function hostWorkspacePackages(): string[] {
  const root = process.cwd()
  const out: string[] = []
  const push = (dir: string): void => {
    if (existsSync(join(dir, 'package.json')) && existsSync(join(dir, 'lib', 'types', 'index.js'))) {
      out.push(relative(root, dir).replace(/\\/g, '/'))
    }
  }
  const vendor = join(root, 'vendor')
  if (existsSync(vendor)) {
    for (const group of readdirSync(vendor, { withFileTypes: true })) {
      if (group.isDirectory()) push(join(vendor, group.name))
    }
  }
  const packages = join(root, 'packages')
  if (existsSync(packages)) {
    for (const group of readdirSync(packages, { withFileTypes: true })) {
      if (!group.isDirectory()) continue
      const groupPath = join(packages, group.name)
      for (const pkg of readdirSync(groupPath, { withFileTypes: true })) {
        if (pkg.isDirectory()) push(join(groupPath, pkg.name))
      }
    }
  }
  for (const app of ['apps/cli', 'apps/desktop', 'apps/desktop-host']) {
    const dir = join(root, app)
    if (existsSync(join(dir, 'package.json'))) out.push(app)
  }
  return out
}

/**
 * The ordinary workspace build consumes JavaScript emitted by the Host
 * TypeScript project and runs Typert. The Client pass selects packages that
 * declare a browser bundle and lets their package-local configs emit both
 * their Node loader entry and browser artifact.
 */
export default defineConfig(({ env }) => {
  const client = isBuildFaceClient(env?.DSH_BUILD_FACE)
  return {
    workspace: client
      ? ['vendor/*', 'packages/*/*', 'apps/cli']
      : hostWorkspacePackages(),
    entry: client ? '' : ['lib/types/{index,invariant,startup}.js'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
    plugins: client ? [] : [typertPlugin({ mode: 'workspace', faces: ['host'] })],
  }
})
