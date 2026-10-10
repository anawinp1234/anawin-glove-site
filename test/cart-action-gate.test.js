import test from 'node:test';
import assert from 'node:assert/strict';
import { createCartActionGate } from '../src/cart-action-gate.js';

test('duplicate cart actions are ignored until the active action settles', async () => {
  const run = createCartActionGate();
  let release;
  let started = 0;
  const pending = new Promise(resolve => { release = resolve; });

  const first = run(async () => { started++; await pending; });
  const duplicate = await run(async () => { started++; });
  assert.equal(duplicate, false);
  assert.equal(started, 1);

  release();
  assert.equal(await first, true);
  assert.equal(await run(async () => { started++; }), true);
  assert.equal(started, 2);
});
