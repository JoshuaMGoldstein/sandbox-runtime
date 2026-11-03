import { afterAll, expect, test } from 'bun:test'
import {
  chmodSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  wrapCommandWithSandboxLinux,
  cleanupBwrapMountPoints,
} from '../../src/sandbox/linux-sandbox-utils.js'
import { SeccompConfigSchema } from '../../src/sandbox/sandbox-config.js'

const base = mkdtempSync(join(tmpdir(), 'srt-guest-helper-'))
const helper = join(base, 'helper')
writeFileSync(helper, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
const guest = '/run/zmux/helpers/apply-seccomp' as const
const rg = '/srv/sandbox-runtime/.port-081/provenance/tools/unpacked/usr/bin/rg'
const options = {
  command: 'true',
  needsNetworkRestriction: true,
  readConfig: {
    denyOnly: ['/'],
    allowWithinDeny: ['/usr', '/bin', '/lib', '/lib64'],
  },
  writeConfig: { allowOnly: [], denyWithinAllow: [] },
  ripgrepConfig: { command: rg },
  seccompConfig: { applyPath: helper, guestApplyPath: guest },
}
afterAll(() => {
  cleanupBwrapMountPoints({ force: true })
  rmSync(base, { recursive: true, force: true })
})

test('mounts helper after existing /run tmpfs and invokes guest path', async () => {
  const plan = await wrapCommandWithSandboxLinux(options)
  expect(plan).toContain('--tmpfs /run')
  expect(plan).toContain(`--ro-bind ${helper} ${guest}`)
  expect(plan).toContain('--remount-ro /run')
  expect(plan.indexOf('--tmpfs /run')).toBeLessThan(
    plan.indexOf(`--ro-bind ${helper} ${guest}`),
  )
  expect(plan).toContain(guest)
})
test('rejects missing and non-executable helpers', async () => {
  await expect(
    wrapCommandWithSandboxLinux({
      ...options,
      seccompConfig: {
        ...options.seccompConfig,
        applyPath: join(base, 'missing'),
      },
    }),
  ).rejects.toThrow()
  chmodSync(helper, 0o644)
  try {
    await expect(wrapCommandWithSandboxLinux(options)).rejects.toThrow()
  } finally {
    chmodSync(helper, 0o755)
  }
})
test('rejects conflicting mounts and unmasked /run', async () => {
  await expect(
    wrapCommandWithSandboxLinux({
      ...options,
      explicitMounts: [
        { source: '/tmp', destination: '/run/zmux', mode: 'rw' },
      ],
    }),
  ).rejects.toThrow()
  await expect(
    wrapCommandWithSandboxLinux({ ...options, readConfig: { denyOnly: [] } }),
  ).rejects.toThrow()
})
test('rejects symlink aliases into reserved helper path and /run sockets', async () => {
  const alias = join(base, 'run-alias')
  symlinkSync('/run', alias)
  await expect(
    wrapCommandWithSandboxLinux({
      ...options,
      explicitMounts: [
        {
          source: '/tmp',
          destination: join(alias, 'zmux', 'other'),
          mode: 'ro',
        },
      ],
    }),
  ).rejects.toThrow('conflicts')
  await expect(
    wrapCommandWithSandboxLinux({
      ...options,
      observeSocketPath: '/run/example.sock',
    }),
  ).rejects.toThrow('Socket conflicts')
})

test('schema rejects other guest paths', () => {
  expect(
    SeccompConfigSchema.safeParse({ guestApplyPath: '/run/zmux/../escape' })
      .success,
  ).toBeFalse()
})
