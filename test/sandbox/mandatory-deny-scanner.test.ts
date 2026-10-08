import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { linuxGetMandatoryDenyPaths } from '../../src/sandbox/linux-sandbox-utils.js'

const root = join(
  tmpdir(),
  'srt-mandatory-deny-scanner-' + process.pid + '-' + Date.now(),
)
const outside = join(
  tmpdir(),
  'srt-mandatory-deny-scanner-outside-' + process.pid + '-' + Date.now(),
)
let previousCwd: string

function pathsAt(depth: number, allowGitConfig = false): Set<string> {
  return new Set(linuxGetMandatoryDenyPaths(depth, allowGitConfig))
}

describe('Linux built-in mandatory-deny scanner', () => {
  beforeAll(() => {
    previousCwd = process.cwd()
    mkdirSync(root, { recursive: true })
    mkdirSync(outside, { recursive: true })

    writeFileSync(join(root, '.bashrc'), 'dangerous')
    mkdirSync(join(root, 'nested', '.vscode'), { recursive: true })
    writeFileSync(join(root, 'nested', '.vscode', 'settings.json'), '{}')
    mkdirSync(join(root, 'repo', '.git', 'hooks'), { recursive: true })
    writeFileSync(join(root, 'repo', '.git', 'HEAD'), 'ref: refs/heads/main')
    writeFileSync(join(root, 'repo', '.git', 'config'), '[core]')
    writeFileSync(
      join(root, 'repo', '.git', 'hooks', 'pre-commit'),
      '#!/bin/sh',
    )
    mkdirSync(join(root, 'node_modules', 'package', '.vscode'), {
      recursive: true,
    })
    writeFileSync(
      join(root, 'node_modules', 'package', '.vscode', 'settings.json'),
      '{}',
    )
    mkdirSync(join(outside, '.vscode'), { recursive: true })
    writeFileSync(join(outside, '.vscode', 'settings.json'), '{}')
    symlinkSync(outside, join(root, 'linked-outside'))
    process.chdir(root)
  })

  afterAll(() => {
    process.chdir(previousCwd)
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  })

  test('finds nested dangerous directories and Git paths without ripgrep', () => {
    const found = pathsAt(3)

    expect(found).toContain(join(root, '.bashrc'))
    expect(found).toContain(join(root, 'nested', '.vscode'))
    expect(found).toContain(join(root, 'repo', '.git', 'hooks'))
    expect(found).toContain(join(root, 'repo', '.git', 'config'))
  })

  test('does not scan node_modules or follow symlinks', () => {
    const found = pathsAt(4)

    expect(found).not.toContain(
      join(root, 'node_modules', 'package', '.vscode'),
    )
    expect(found).not.toContain(join(root, 'linked-outside', '.vscode'))
    expect(found).not.toContain(join(outside, '.vscode'))
  })

  test('respects mandatory-deny depth boundaries', () => {
    expect(pathsAt(2)).not.toContain(join(root, 'nested', '.vscode'))
    expect(pathsAt(3)).toContain(join(root, 'nested', '.vscode'))
    expect(pathsAt(2)).not.toContain(join(root, 'repo', '.git', 'hooks'))
    expect(pathsAt(3)).toContain(join(root, 'repo', '.git', 'hooks'))
  })

  test('allows nested Git config only when configured', () => {
    expect(pathsAt(3)).toContain(join(root, 'repo', '.git', 'config'))
    expect(pathsAt(3, true)).not.toContain(join(root, 'repo', '.git', 'config'))
  })
})
