import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test'
import * as which from '../../src/utils/which.js'
import * as platform from '../../src/utils/platform.js'
import { SandboxManager } from '../../src/sandbox/sandbox-manager.js'

let whichSpy: ReturnType<typeof spyOn>
let platformSpy: ReturnType<typeof spyOn>

beforeEach(() => {
  whichSpy = spyOn(which, 'whichSync')
  platformSpy = spyOn(platform, 'getPlatform')
})

afterEach(() => {
  whichSpy.mockRestore()
  platformSpy.mockRestore()
})

describe('SandboxManager dependency checks', () => {
  test('linux does not require ripgrep when the built-in scanner is used', () => {
    platformSpy.mockReturnValue('linux')
    whichSpy.mockImplementation((bin: string) =>
      bin === 'rg' ? null : '/usr/bin/' + bin,
    )

    const result = SandboxManager.checkDependencies()

    expect(result.errors).not.toContain('ripgrep (rg) not found')
  })

  test('async checks match synchronous POSIX checks without ripgrep', async () => {
    platformSpy.mockReturnValue('linux')
    whichSpy.mockImplementation((bin: string) =>
      bin === 'rg' ? null : '/usr/bin/' + bin,
    )

    expect(await SandboxManager.checkDependenciesAsync()).toEqual(
      SandboxManager.checkDependencies(),
    )
  })
})
