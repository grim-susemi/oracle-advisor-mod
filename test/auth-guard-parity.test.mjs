import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { strictParity } from './auth-guard-parity.mjs';

test('strict parity uses the original dossier branch and consistent trigger failures', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'oracle-strict-parity-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const result = await strictParity(directory);
  assert.equal(result.scenarios, 360);
  assert.equal(result.strict_mismatches, 0);
  const dossier = result.rows.filter(row => row.case === 'dossier-only' &&
    row.mode !== 'scoped' && row.mutation !== 'unchanged');
  assert.equal(dossier.length, 14);
  for (const row of dossier) {
    assert.deepEqual(row.before, { status: 'auth_changed', exit_code: 1 });
    assert.deepEqual(row.after, row.before);
  }
  const triggers = result.rows.filter(row => row.case === 'triggers-real' &&
    row.mode !== 'scoped' && row.mutation !== 'unchanged');
  assert.equal(triggers.length, 14);
  for (const row of triggers) assert.deepEqual(row.after, { status: 'auth_changed', exit_code: 1 });
});
