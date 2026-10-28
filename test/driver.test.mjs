import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakePi } from './helpers/fake-pi.mjs';
import { registerDriver, getDriver } from '../src/driver.mjs';

function setup(options) {
  const fake = createFakePi({ sessionId: options?.sessionId ?? 'driver-session' });
  fake.ctx.model = options?.model ?? { provider: 'test-provider', id: 'claude-opus-5-5' };
  const runtime = { getSessionStatus: () => options?.session ?? 'lead' };
  registerDriver(fake.pi, runtime);
  return { fake, runtime };
}

const atlasEntry = () => ({ type: 'custom', id: 'e1', customType: 'primary-agent/v1',
  data: { schemaVersion: 1, agentId: 'atlas' } });

test('driver: atlas entry yields agentId atlas with family from ctx.model', async () => {
  const { fake } = setup({ sessionId: 't-atlas', model: { provider: 'test-provider', id: 'gpt-6-astra' } });
  fake.entries.push(atlasEntry());
  await fake.emit('before_agent_start', { type: 'before_agent_start', systemPrompt: '' });
  assert.deepEqual(getDriver(fake.ctx), {
    agentId: 'atlas', modelProvider: 'test-provider', modelId: 'gpt-6-astra', family: 'gpt',
  });
});

test('driver: newest valid entry wins over an older valid entry', async () => {
  const { fake } = setup({ sessionId: 't-newest' });
  fake.entries.push(atlasEntry());
  fake.entries.push({ type: 'custom', id: 'e2', customType: 'primary-agent/v1',
    data: { schemaVersion: 1, agentId: 'prometheus' } });
  await fake.emit('before_agent_start', { type: 'before_agent_start', systemPrompt: '' });
  assert.equal(getDriver(fake.ctx).agentId, 'prometheus');
});

test('driver: no entries yields null agentId with family from ctx.model', async () => {
  const { fake } = setup({ sessionId: 't-empty' });
  await fake.emit('before_agent_start', { type: 'before_agent_start', systemPrompt: '' });
  assert.deepEqual(getDriver(fake.ctx), {
    agentId: null, modelProvider: 'test-provider', modelId: 'claude-opus-5-5', family: 'claude',
  });
});

test('driver: malformed entries are ignored, newest schemaVersion 2 falls back to previous valid entry', async () => {
  const { fake } = setup({ sessionId: 't-malformed' });
  fake.entries.push({ type: 'custom', id: 'e1', customType: 'primary-agent/v1',
    data: { schemaVersion: 1, agentId: 'hephaestus' } });
  fake.entries.push('not-an-object');
  fake.entries.push(null);
  fake.entries.push({ type: 'custom', id: 'e4', customType: 'primary-agent/v1',
    data: { schemaVersion: 2, agentId: 'atlas' } });
  fake.entries.push({ type: 'custom', id: 'e5', customType: 'other/v1',
    data: { schemaVersion: 1, agentId: 'atlas' } });
  await fake.emit('before_agent_start', { type: 'before_agent_start', systemPrompt: '' });
  assert.equal(getDriver(fake.ctx).agentId, 'hephaestus');
});

test('driver: absent ctx.model yields family unknown', async () => {
  const fake = createFakePi({ sessionId: 't-nomodel' });
  delete fake.ctx.model;
  registerDriver(fake.pi, { getSessionStatus: () => 'lead' });
  fake.entries.push(atlasEntry());
  await fake.emit('before_agent_start', { type: 'before_agent_start', systemPrompt: '' });
  assert.deepEqual(getDriver(fake.ctx), {
    agentId: 'atlas', modelProvider: '', modelId: '', family: 'unknown',
  });
});

test('driver: handler is registered without previewSafe and ignores preview passes', async () => {
  const fake = createFakePi({ sessionId: 't-preview' });
  const seen = [];
  const originalOn = fake.pi.on.bind(fake.pi);
  fake.pi.on = (...args) => { seen.push(args); return originalOn(...args); };
  registerDriver(fake.pi, { getSessionStatus: () => 'lead' });
  const registrations = seen.filter(([name]) => name === 'before_agent_start');
  assert.equal(registrations.length, 1);
  assert.notEqual(registrations[0][2]?.previewSafe, true);
  fake.entries.push(atlasEntry());
  await fake.emit('before_agent_start', { type: 'before_agent_start', preview: true, systemPrompt: '' });
  assert.equal(getDriver(fake.ctx), null);
});

test('driver: a child session writes nothing', async () => {
  const { fake } = setup({ session: 'child', sessionId: 't-child' });
  fake.entries.push(atlasEntry());
  await fake.emit('before_agent_start', { type: 'before_agent_start', systemPrompt: '' });
  assert.equal(getDriver(fake.ctx), null);
});

test('driver: session shutdown clears the stored record', async () => {
  const { fake } = setup({ sessionId: 't-shutdown' });
  fake.entries.push(atlasEntry());
  await fake.emit('before_agent_start', { type: 'before_agent_start', systemPrompt: '' });
  assert.equal(getDriver(fake.ctx).agentId, 'atlas');
  await fake.emit('session_shutdown', { type: 'session_shutdown' });
  assert.equal(getDriver(fake.ctx), null);
});

test('driver: records are kept per session id', async () => {
  const first = setup({ sessionId: 't-per-a' });
  const second = setup({ sessionId: 't-per-b' });
  first.fake.entries.push(atlasEntry());
  await first.fake.emit('before_agent_start', { type: 'before_agent_start', systemPrompt: '' });
  assert.equal(getDriver(first.fake.ctx).agentId, 'atlas');
  assert.equal(getDriver(second.fake.ctx), null);
});

