'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const vm = require('node:vm')

function setupMitPipHilfe(hilfe) {
  const gestartet = []
  const modul = { exports: {} }
  vm.runInNewContext(fs.readFileSync(require('node:path').join(__dirname, 'setup.js'), 'utf8'), {
    module: modul, process, Buffer, setTimeout, clearTimeout,
    require(name) {
      if (name === './paths') return {}
      if (name !== 'child_process') return require(name)
      return { spawn(cmd, args) {
        gestartet.push(args)
        const proc = new EventEmitter()
        proc.stdout = new EventEmitter(); proc.stderr = new EventEmitter()
        process.nextTick(() => {
          if (args.includes('--help')) proc.stdout.emit('data', hilfe)
          proc.emit('close', 0)
        })
        return proc
      } }
    },
  })
  return { lauf: modul.exports.lauf, abbrechen: modul.exports.abbrechen, gestartet }
}

for (const [hilfe, option] of [['Specify progress: on, off', 'off'], ['Specify progress: on, off, raw', 'raw']]) {
  test(`Paketinstallation verwendet ${option} passend zur pip-Hilfe`, async () => {
    const { lauf, gestartet } = setupMitPipHilfe(hilfe)
    assert.equal(await lauf('python', ['-m', 'pip', 'install', 'torch'], () => {}), 0)
    assert.deepEqual(Array.from(gestartet[0]), ['-m', 'pip', 'install', '--help'])
    assert.deepEqual(Array.from(gestartet[1]).slice(-2), ['--progress-bar', option])
  })
}

test('pip-Selbstupgrade braucht keine neue Fortschrittsoption', async () => {
  const { lauf, gestartet } = setupMitPipHilfe('on, off')
  const args = ['-m', 'pip', 'install', '-U', 'pip']
  assert.equal(await lauf('python', args, () => {}), 0)
  assert.deepEqual(Array.from(gestartet[0]), args)
  assert.equal(gestartet.length, 1)
})

test('ein bereits abgebrochener Lauf startet auch keine pip-Sondierung', async () => {
  const { lauf, abbrechen, gestartet } = setupMitPipHilfe('on, off, raw')
  abbrechen()
  assert.equal(await lauf('python', ['-m', 'pip', 'install', 'torch'], () => {}), -1)
  assert.equal(gestartet.length, 0)
})
