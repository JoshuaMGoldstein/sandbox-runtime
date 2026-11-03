import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  wrapCommandWithSandboxLinux,
  cleanupBwrapMountPoints,
} from '../../src/sandbox/linux-sandbox-utils.js'
import { isLinux } from '../helpers/platform.js'
import { SandboxManager } from '../../src/sandbox/sandbox-manager.js'
import { existsSync } from 'node:fs'

const base = mkdtempSync(join(tmpdir(), 'srt-scan-failure-'))
const originalCwd = process.cwd()
function scanner(name: string, script: string): string {
  const file = join(base, name)
  writeFileSync(file, '#!/bin/sh\n' + script + '\n')
  chmodSync(file, 0o755)
  return file
}
function wrap(command: string, signal?: AbortSignal): Promise<string> {
  return wrapCommandWithSandboxLinux({
    command: 'touch SHOULD_NOT_RUN',
    needsNetworkRestriction: false,
    writeConfig: { allowOnly: [base], denyWithinAllow: [] },
    ripgrepConfig: { command },
    abortSignal: signal,
  })
}

describe.if(isLinux)('mandatory deny scan fails closed', () => {
  beforeAll(() => process.chdir(base))
  afterAll(() => {
    process.chdir(originalCwd)
    cleanupBwrapMountPoints({ force: true })
    rmSync(base, { recursive: true, force: true })
  })

  test('refuses a missing scanner', async () => {
    // Bun rejection matchers are asynchronous despite their declared return type.
    // eslint-disable-next-line @typescript-eslint/await-thenable
    await expect(wrap(join(base, 'missing'))).rejects.toThrow(
      'Mandatory deny scan failed',
    )
  })

  test('rejects a scanner that fails after manager admission before returning launch argv', async () => {
    const admitted = scanner(
      'admitted-rg',
      "printf 'nested/.bashrc\\n'; exit 2",
    )
    await SandboxManager.initialize(
      {
        network: { allowedDomains: [], deniedDomains: [], airGapped: true },
        filesystem: { denyRead: [], allowWrite: [base], denyWrite: [] },
        ripgrep: { command: admitted },
      },
      undefined,
      false,
    )
    try {
      // Bun rejection matchers are asynchronous despite their declared return type.
      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(
        SandboxManager.wrapWithSandboxArgv('touch SHOULD_NOT_RUN', '/bin/bash'),
      ).rejects.toThrow('Mandatory deny scan failed')
      expect(existsSync(join(base, 'SHOULD_NOT_RUN'))).toBeFalse()
    } finally {
      await SandboxManager.reset()
    }
  })

  test.each([
    [
      'error',
      "printf 'nested/.bashrc\\n'; echo 'Permission denied' >&2; exit 2",
    ],
    ['silent-error', "printf 'nested/.bashrc\\n'; exit 2"],
    ['killed', "printf 'nested/.bashrc\\n'; kill -TERM $$"],
    ['warning', "printf 'nested/.bashrc\\n'; echo warning >&2; exit 0"],
    ['inconsistent', "printf 'nested/.bashrc\\n'; exit 1"],
  ])('refuses %s even after partial output', async (name, script) => {
    // Bun rejection matchers are asynchronous despite their declared return type.
    // eslint-disable-next-line @typescript-eslint/await-thenable
    await expect(wrap(scanner(name, script))).rejects.toThrow(
      'Mandatory deny scan failed',
    )
  })

  test('refuses a scan killed by the ten-second timeout after partial output', async () => {
    // Bun rejection matchers are asynchronous despite their declared return type.
    // eslint-disable-next-line @typescript-eslint/await-thenable
    await expect(
      wrap(scanner('timeout', "printf 'nested/.bashrc\\n'; exec sleep 30")),
    ).rejects.toThrow('Mandatory deny scan failed')
  }, 15000)

  test('preserves abort reason', async () => {
    const controller = new AbortController()
    const reason = new Error('scan cancelled')
    controller.abort(reason)
    // Bun rejection matchers are asynchronous despite their declared return type.
    // eslint-disable-next-line @typescript-eslint/await-thenable
    await expect(
      wrap(scanner('aborted', 'exit 0'), controller.signal),
    ).rejects.toBe(reason)
  })

  test('accepts a successful empty scan and a successful matching scan', async () => {
    expect(await wrap(scanner('empty', 'exit 1'))).toContain('bwrap')
    expect(
      await wrap(scanner('match', "printf 'nested/.bashrc\\n'; exit 0")),
    ).toContain('bwrap')
  })
})
