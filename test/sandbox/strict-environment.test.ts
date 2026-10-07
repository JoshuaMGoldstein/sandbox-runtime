import { describe, expect, test } from 'bun:test'
import { SandboxRuntimeConfigSchema } from '../../src/sandbox/sandbox-config.js'
import { wrapCommandWithSandboxLinux } from '../../src/sandbox/linux-sandbox-utils.js'
import { wrapCommandWithSandboxMacOS } from '../../src/sandbox/macos-sandbox-utils.js'

describe('strict environment configuration', () => {
  test('accepts an explicit clear-environment allowlist', () => {
    const result = SandboxRuntimeConfigSchema.safeParse({
      network: { allowedDomains: [], deniedDomains: [] },
      filesystem: { denyRead: [], allowWrite: [], denyWrite: [] },
      environment: {
        clear: true,
        variables: {
          HOME: '/tmp',
          LANG: 'C.UTF-8',
          PATH: '/usr/bin:/bin',
          TERM: 'xterm-256color',
        },
      },
    })

    expect(result.success).toBe(true)
  })

  test('rejects an allowlist without clear-environment mode', () => {
    const result = SandboxRuntimeConfigSchema.safeParse({
      network: { allowedDomains: [], deniedDomains: [] },
      filesystem: { denyRead: [], allowWrite: [], denyWrite: [] },
      environment: { variables: { PATH: '/usr/bin:/bin' } },
    })

    expect(result.success).toBe(false)
  })

  test('rejects unsafe environment variable names and values', () => {
    const base = {
      network: { allowedDomains: [], deniedDomains: [] },
      filesystem: { denyRead: [], allowWrite: [], denyWrite: [] },
    }

    expect(
      SandboxRuntimeConfigSchema.safeParse({
        ...base,
        environment: { clear: true, variables: { 'BAD=NAME': 'value' } },
      }).success,
    ).toBe(false)
    expect(
      SandboxRuntimeConfigSchema.safeParse({
        ...base,
        environment: { clear: true, variables: { SAFE: 'nul\0value' } },
      }).success,
    ).toBe(false)
  })
})

describe('strict environment compilation', () => {
  const secretName = 'SRT_STRICT_ENV_SENTINEL'
  const secretValue = 'ambient-secret-must-not-appear'
  const variables = {
    HOME: '/tmp',
    PATH: '/usr/bin:/bin',
    TERM: 'xterm-256color',
  }

  test('Linux emits a cleared Bubblewrap environment with only configured base values', async () => {
    process.env[secretName] = secretValue
    try {
      const wrapped = await wrapCommandWithSandboxLinux({
        command: 'printf ok',
        needsNetworkRestriction: false,
        clearEnvironment: true,
        environmentVariables: variables,
        enableWeakerNestedSandbox: true,
      })

      expect(wrapped).toContain('--clearenv')
      for (const [name, value] of Object.entries(variables)) {
        expect(wrapped).toContain('--setenv ' + name + ' ' + value)
      }
      expect(wrapped).not.toContain(secretValue)
    } finally {
      delete process.env[secretName]
    }
  })

  test('macOS emits env -i with only configured base values', () => {
    process.env[secretName] = secretValue
    try {
      const wrapped = wrapCommandWithSandboxMacOS({
        command: 'printf ok',
        needsNetworkRestriction: false,
        readConfig: undefined,
        writeConfig: undefined,
        clearEnvironment: true,
        environmentVariables: variables,
      })

      expect(wrapped).toContain('env -i')
      for (const [name, value] of Object.entries(variables)) {
        expect(wrapped).toContain(name + '=' + value)
      }
      expect(wrapped).not.toContain(secretValue)
    } finally {
      delete process.env[secretName]
    }
  })
})
