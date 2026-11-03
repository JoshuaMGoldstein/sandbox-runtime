import { spawnSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  cleanupBwrapMountPoints,
  wrapCommandWithSandboxLinux,
} from '../../src/sandbox/linux-sandbox-utils.js'
import { quote } from '../../src/utils/shell-quote.js'

const helper = process.env.SRT_TEST_HELPER
const rg = process.env.SRT_TEST_RG
if (!helper?.startsWith('/') || !rg?.startsWith('/')) {
  throw new Error(
    'Set SRT_TEST_HELPER and SRT_TEST_RG to absolute executable paths',
  )
}
const python = '/usr/bin/python3'
const socketProbe =
  'import socket; s=socket.socket(socket.AF_UNIX, socket.SOCK_STREAM); s.close()'
const deniedProbe =
  'import errno, socket, sys\ntry:\n socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)\nexcept OSError as e:\n sys.exit(0 if e.errno == errno.EPERM else 1)\nsys.exit(1)'
const control = spawnSync(python, ['-c', socketProbe], {
  encoding: 'utf8',
  timeout: 5000,
})
if (control.status !== 0)
  throw new Error(`AF_UNIX positive control failed: ${control.stderr}`)

const dir = mkdtempSync(join(tmpdir(), 'srt-guest-outer-'))
try {
  const guest = '/run/zmux/helpers/apply-seccomp' as const
  const ro = join(dir, 'readonly')
  const rw = join(dir, 'writable')
  mkdirSync(ro)
  mkdirSync(rw)
  writeFileSync(join(ro, 'marker'), 'original')
  const command = [
    `test -x ${guest}`,
    `! test -e ${quote([helper])}`,
    `! touch /run/zmux/helpers/write-probe`,
    `test "$(cat /run/test-ro/marker)" = original`,
    `! touch /run/test-ro/write-probe`,
    `printf written > /run/test-rw/result`,
    `/usr/bin/python3 -c ${quote([deniedProbe])}`,
    'printf SRT_GUEST_TEST_OK',
  ].join(' && ')
  const plan = await wrapCommandWithSandboxLinux({
    command,
    needsNetworkRestriction: true,
    readConfig: {
      denyOnly: ['/'],
      allowWithinDeny: ['/usr', '/bin', '/lib', '/lib64'],
    },
    writeConfig: { allowOnly: [dir], denyWithinAllow: [] },
    ripgrepConfig: { command: rg },
    seccompConfig: { applyPath: helper, guestApplyPath: guest },
    explicitMounts: [
      { source: ro, destination: '/run/test-ro', mode: 'ro' },
      { source: rw, destination: '/run/test-rw', mode: 'rw' },
    ],
  })
  const result = spawnSync('/bin/bash', ['-c', plan], {
    encoding: 'utf8',
    timeout: 20000,
    maxBuffer: 1024 * 1024,
  })
  if (
    result.error ||
    result.status !== 0 ||
    result.stdout !== 'SRT_GUEST_TEST_OK'
  ) {
    throw new Error(
      `sandbox failed: status=${result.status}, signal=${result.signal}, error=${result.error}, stdout=${result.stdout}, stderr=${result.stderr}`,
    )
  }
  if (readFileSync(join(rw, 'result'), 'utf8') !== 'written') {
    throw new Error('Writable /run grant did not reach its source')
  }
  console.log(
    'PASS: host AF_UNIX control; guest helper, host-path hiding, read-only parent, /run ro/rw grants and AF_UNIX denial',
  )
} finally {
  cleanupBwrapMountPoints()
  rmSync(dir, { recursive: true, force: true })
}
