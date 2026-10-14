const test = require('node:test');
const assert = require('node:assert/strict');
const {spawnSync} = require('node:child_process');
const path = require('node:path');

const executable = path.resolve(__dirname, '../native/asio-probe/build/asio-probe.exe');
const run = (...args) => spawnSync(executable, args, {encoding: 'utf8', timeout: 5000, windowsHide: true});

if (process.platform === 'win32') test('ASIO probe lists the registered drivers without opening them', () => {
  const result = run('--list');
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  const output = JSON.parse(result.stdout);
  assert.equal(output.operation, 'list');
  assert.ok(Array.isArray(output.drivers));
  const names = new Set();
  for (const driver of output.drivers) {
    assert.equal(typeof driver.registryName, 'string');
    assert.match(driver.clsid, /^\{[0-9a-f-]{36}\}$/i);
    assert.ok(!names.has(driver.registryName));
    names.add(driver.registryName);
  }
});

if (process.platform === 'win32') test('ASIO probe rejects an unknown exact registry name', () => {
  const result = run('--inspect', '__aural_missing_asio_driver__');
  assert.equal(result.status, 2, result.stderr || result.error?.message);
  const output = JSON.parse(result.stdout);
  assert.equal(output.error, 'driver not found');
  assert.equal(output.registryName, '__aural_missing_asio_driver__');
});
