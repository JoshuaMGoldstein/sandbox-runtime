import { afterEach, describe, expect, test } from 'bun:test'
import { SandboxManager } from '../../src/sandbox/sandbox-manager.js'
import {
  SandboxRuntimeConfigSchema,
  type SandboxRuntimeConfig,
} from '../../src/sandbox/sandbox-config.js'

const proxyEnvironmentKeys = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'NO_PROXY',
  'no_proxy',
]

const savedEnvironment = new Map<string, string | undefined>()

function config(): SandboxRuntimeConfig {
  return {
    network: {
      allowedDomains: [],
      deniedDomains: ['*'],
      strictAllowlist: true,
      airGapped: true,
      allowAllUnixSockets: false,
      allowLocalBinding: false,
    },
    filesystem: {
      disabled: false,
      denyRead: ['/**'],
      allowRead: ['/tmp'],
      allowWrite: ['/tmp'],
      denyWrite: [],
      explicitMounts: [
        { source: '/tmp', destination: '/workspace', mode: 'rw' },
      ],
    },
    environment: {
      clear: true,
      variables: {
        HOME: '/tmp',
        PATH: '/usr/bin:/bin',
        TERM: 'xterm-256color',
      },
    },
    allowPty: true,
    enableWeakerNestedSandbox: false,
    enableWeakerNetworkIsolation: false,
  }
}

afterEach(async () => {
  for (const key of proxyEnvironmentKeys) {
    const value = savedEnvironment.get(key)
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  savedEnvironment.clear()
  await SandboxManager.reset()
})

describe('air-gapped network mode', () => {
  test('rejects a non-empty allowlist', () => {
    const result = SandboxRuntimeConfigSchema.safeParse({
      ...config(),
      network: { ...config().network, allowedDomains: ['example.com'] },
    })

    expect(result.success).toBeFalse()
    if (!result.success)
      expect(result.error.issues[0]?.message).toBe(
        'network.airGapped requires an empty allowedDomains list',
      )
  })

  test('emits only an unshared network namespace without proxy bootstrap or inherited proxy values', async () => {
    for (const key of proxyEnvironmentKeys) {
      savedEnvironment.set(key, process.env[key])
      process.env[key] = `http://ambient-${key.toLowerCase()}:9999`
    }

    await SandboxManager.initialize(config(), undefined, false)
    const wrapped = await SandboxManager.wrapWithSandboxArgv(
      'printf air-gapped',
      '/bin/bash',
    )
    const plan = wrapped.argv.join(' ')

    expect(plan).toContain('--unshare-net')
    expect(plan).not.toContain('claude-http-')
    expect(plan).not.toContain('claude-socks-')
    expect(plan).not.toContain('HTTP_PROXY')
    expect(plan).not.toContain('HTTPS_PROXY')
    expect(plan).not.toContain('ALL_PROXY')
    expect(plan).not.toContain('proxyport=')
    expect(plan).not.toContain('socat TCP-LISTEN')
    expect(plan).toContain('--bind /tmp /workspace')
    expect(wrapped.env).not.toHaveProperty('HTTP_PROXY')
    expect(wrapped.env).not.toHaveProperty('HTTPS_PROXY')
  })

  test('rejects unsafe explicit mount destinations', () => {
    for (const explicitMounts of [
      [
        { source: '/tmp', destination: '/workspace', mode: 'rw' },
        { source: '/var/tmp', destination: '/workspace/cache', mode: 'ro' },
      ],
      [{ source: '/tmp/../tmp', destination: '/workspace', mode: 'rw' }],
      [{ source: '/tmp', destination: 'workspace', mode: 'rw' }],
    ]) {
      const result = SandboxRuntimeConfigSchema.safeParse({
        ...config(),
        filesystem: { ...config().filesystem, explicitMounts },
      })
      expect(result.success).toBeFalse()
    }
  })
})
