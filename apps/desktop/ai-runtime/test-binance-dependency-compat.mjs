import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const entry = require.resolve('@binance/agentic-wallet');
const source = readFileSync(entry, 'utf8');
// This pinned CLI does not use its declared Zod 3 dependency. If an upstream
// update starts using it, review the scoped Zod 4 override before shipping.
assert.doesNotMatch(source, /zod|ZodArray|ZodSet|too_big/, 'Review the Binance Zod override');
const testDirectory = mkdtempSync(join(tmpdir(), 'fnzsafe-binance-compat-'));
try {
  for (const args of [['--help'], ['wallet', '--help']]) {
    const output = execFileSync(process.execPath, [entry, ...args], {
      cwd: testDirectory,
      env: { PATH: process.env.PATH, BINANCE_BAW_DIR: testDirectory, BINANCE_INSTANCE_ID: 'offline-compatibility-test' },
      encoding: 'utf8', timeout: 10_000,
    });
    assert.match(output, /Usage:/);
    assert.match(output, /Options:/);
  }
  console.log('Binance dependency compatibility checks passed (offline help commands)');
} finally {
  rmSync(testDirectory, { recursive: true, force: true });
}
