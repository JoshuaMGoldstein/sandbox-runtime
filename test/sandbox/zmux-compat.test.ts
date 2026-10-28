import { afterEach, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { SandboxManager } from '../../src/sandbox/sandbox-manager.js'
import { SandboxRuntimeConfigSchema } from '../../src/sandbox/sandbox-config.js'

const ambient = { ...process.env }
const created: string[] = []
afterEach(async () => {
  await SandboxManager.reset()
  for (const key of Object.keys(process.env))
    if (!(key in ambient)) delete process.env[key]
  Object.assign(process.env, ambient)
  for (const path of created.splice(0))
    rmSync(path, { force: true, recursive: true })
})

function config() {
  return {
    network: { allowedDomains: [], deniedDomains: [], airGapped: true },
    filesystem: {
      denyRead: ['/'],
      allowRead: ['/usr', '/bin', '/lib', '/lib64'],
      allowWrite: [],
      denyWrite: [],
      explicitMounts: [] as Array<{
        source: string
        destination: string
        mode: 'rw' | 'ro'
      }>,
    },
    environment: {
      clear: true as const,
      variables: { PATH: '/usr/bin:/bin', APPROVED: 'approved-value' },
    },
  }
}

test('validates clear environment and air gap contract', () => {
  const cfg = config()
  expect(SandboxRuntimeConfigSchema.safeParse(cfg).success).toBeTrue()
  expect(
    SandboxRuntimeConfigSchema.safeParse({
      ...cfg,
      network: { ...cfg.network, allowedDomains: ['example.com'] },
    }).success,
  ).toBeFalse()
  for (const environment of [
    { clear: false, variables: {} },
    { clear: true, variables: { 'BAD-NAME': 'x' } },
    { clear: true, variables: { GOOD: 'bad\0value' } },
  ]) {
    expect(
      SandboxRuntimeConfigSchema.safeParse({ ...cfg, environment }).success,
    ).toBeFalse()
  }
})

test('air gap never initializes proxy listeners, sockets or encoded ambient values', async () => {
  process.env.SRT_AMBIENT_SECRET = 'DISTINCT_SECRET_081'
  process.env.HTTP_PROXY = 'http://ambient.invalid:9999'
  process.env.HTTPS_PROXY = 'http://ambient.invalid:9998'
  process.env.ALL_PROXY = 'socks5://ambient.invalid:9997'
  process.env.GIT_CONFIG_COUNT = '937'
  const cfg = config()
  await SandboxManager.initialize(cfg, undefined, false)
  expect(SandboxManager.getProxyPort()).toBeUndefined()
  expect(SandboxManager.getLinuxHttpSocketPath()).toBeUndefined()
  expect(SandboxManager.getLinuxSocksSocketPath()).toBeUndefined()
  const wrapped = await SandboxManager.wrapWithSandboxArgv(
    'printf ok',
    '/bin/bash',
  )
  const plan = wrapped.argv.join(' ')
  expect(plan).toContain('--unshare-net')
  expect(plan).toContain('--clearenv')
  expect(plan).toContain('--setenv APPROVED approved-value')
  for (const forbidden of [
    'DISTINCT_SECRET_081',
    'ambient.invalid',
    'socat',
    'claude-http-',
    'claude-socks-',
    '937',
  ])
    expect(plan).not.toContain(forbidden)
  expect(wrapped.env).toEqual(cfg.environment.variables)
})

test('live no-network exact environment, sentinel masks, project rw and runtime ro; sequential cleanup', async () => {
  const base = mkdtempSync('/tmp/zmux-081-')
  const home = mkdtempSync(join(homedir(), '.zmux-081-'))
  created.push(base, home)
  const project = join(base, 'project')
  const runtime = join(base, 'runtime')
  mkdirSync(project)
  mkdirSync(runtime)
  writeFileSync(join(runtime, 'marker'), 'runtime')
  writeFileSync(join(project, 'helper'), '#!/bin/bash\nprintf HELPER_OK')
  chmodSync(join(project, 'helper'), 0o755)
  const secrets = [join(base, 'outside'), join(home, 'secret'), '/etc/hostname']
  for (const [i, path] of secrets.entries()) {
    if (!path.startsWith('/etc/')) writeFileSync(path, 'SECRET')
    symlinkSync(path, join(project, `escape-${i}`))
  }
  process.env.SRT_AMBIENT_SECRET = 'DISTINCT_SECRET_081'
  process.env.HTTP_PROXY = 'http://ambient.invalid:9999'
  for (const deny of ['/', '/**']) {
    const cfg = config()
    cfg.filesystem.denyRead = [deny]
    cfg.filesystem.explicitMounts = [
      { source: project, destination: '/workspace', mode: 'rw' },
      { source: runtime, destination: '/mnt', mode: 'ro' },
    ]
    await SandboxManager.initialize(cfg, undefined, false)
    const command = `cd -- /workspace && test "$PWD" = /workspace && test "$APPROVED" = approved-value && test -z "$SRT_AMBIENT_SECRET$HTTP_PROXY$HTTPS_PROXY$ALL_PROXY" && ./helper && printf ok > result && ! (printf bad > /mnt/marker) && ${secrets.map((path, i) => `! test -r '${path}' && ! test -r /workspace/escape-${i}`).join(' && ')} && printf FINAL_OK`
    const wrapped = await SandboxManager.wrapWithSandboxArgv(
      command,
      '/bin/bash',
    )
    const result = spawnSync(wrapped.argv[0]!, wrapped.argv.slice(1), {
      env: wrapped.env,
      encoding: 'utf8',
      timeout: 15000,
    })
    expect(result.stdout).toContain('HELPER_OK')
    expect(result.stdout).toContain('FINAL_OK')
    expect(result.status).toBe(0)
    await SandboxManager.reset()
  }
})
