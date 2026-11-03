import { afterEach, describe, expect, test } from 'bun:test'
import { SandboxRuntimeConfigSchema } from '../../src/sandbox/sandbox-config.js'
import { SandboxManager } from '../../src/sandbox/sandbox-manager.js'
import { wrapCommandWithSandboxLinux } from '../../src/sandbox/linux-sandbox-utils.js'

const mounts = [
  { source: '/tmp', destination: '/workspace', mode: 'rw' as const },
]
const config = {
  network: { allowedDomains: [], deniedDomains: [] },
  filesystem: {
    denyRead: [],
    allowWrite: [],
    denyWrite: [],
    explicitMounts: mounts,
  },
}

afterEach(async () => {
  await SandboxManager.reset()
})

describe('explicit mounts', () => {
  test('preserves normalized mounts', () => {
    expect(
      SandboxRuntimeConfigSchema.parse(config).filesystem.explicitMounts,
    ).toEqual(mounts)
  })

  test('rejects relative, non-normalized, NUL, duplicate and overlapping destinations', () => {
    const invalid = [
      [{ source: 'tmp', destination: '/workspace', mode: 'rw' }],
      [{ source: '/tmp/../tmp', destination: '/workspace', mode: 'rw' }],
      [{ source: '/tmp', destination: '/work\0space', mode: 'rw' }],
      [{ source: '/tmp', destination: '/workspace', mode: 'invalid' }],
      [...mounts, ...mounts],
      [
        ...mounts,
        { source: '/tmp', destination: '/workspace/sub', mode: 'ro' },
      ],
      [...mounts, { source: '/tmp', destination: '/', mode: 'ro' }],
      [{ source: '/tmp', destination: '/', mode: 'ro' }, ...mounts],
    ]
    for (const explicitMounts of invalid) {
      expect(
        SandboxRuntimeConfigSchema.safeParse({
          ...config,
          filesystem: { ...config.filesystem, explicitMounts },
        }).success,
      ).toBeFalse()
    }
  })

  test('emits ro/rw binds after policy masks and before sandbox devices', async () => {
    const plan = await wrapCommandWithSandboxLinux({
      command: 'true',
      needsNetworkRestriction: true,
      allowAllUnixSockets: true,
      readConfig: {
        denyOnly: ['/'],
        allowWithinDeny: ['/usr', '/bin', '/lib', '/lib64'],
      },
      writeConfig: { allowOnly: [], denyWithinAllow: [] },
      explicitMounts: [
        ...mounts,
        { source: '/usr', destination: '/runtime', mode: 'ro' },
      ],
    })
    expect(plan).toContain('--unshare-net')
    expect(plan).toContain('--ro-bind /usr /runtime')
    expect(plan.indexOf('--bind /tmp /workspace')).toBeGreaterThan(
      plan.indexOf('--tmpfs /'),
    )
    expect(plan.indexOf('--dev /dev')).toBeGreaterThan(
      plan.indexOf('--ro-bind /usr /runtime'),
    )
  })

  test('forwards the session plan through the manager', async () => {
    await SandboxManager.initialize(config, undefined, false)
    const plan = await SandboxManager.wrapWithSandbox('true', '/bin/bash')
    expect(plan).toContain('--bind /tmp /workspace')
  })
})
