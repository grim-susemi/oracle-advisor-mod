import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import extension, { REGISTRATION_KEY } from '../src/extension.mjs';
import { createFakePi } from './helpers/fake-pi.mjs';

function briefing(pi) {
  pi.on('before_agent_start', event => ({ systemPrompt: `${event.systemPrompt}\nBRIEFING BLOCK` }));
  pi.on('agent_before_settle', event => ({
    entries: [...event.entries, { type: 'custom_message', customType: 'briefing', content: 'briefing settle' }],
  }));
  pi.on('tool_result', event => event.toolName === 'brief' ? {
    content: [...event.content, { type: 'text', text: 'briefing result edit' }],
    details: event.details, structuredContent: event.structuredContent,
  } : undefined);
}

// The installed extension runner threads each returned patch into the next
// handler. Use the same contract rather than invoking every handler on stale data.
async function dispatch(fake, name, event) {
  let current = event;
  for (const handler of fake.handlers.get(name) ?? []) {
    const patch = await handler(current, fake.ctx);
    if (patch) current = { ...current, ...patch };
  }
  return current;
}

for (const order of ['briefing-first', 'advisor-first']) {
  test(`briefing and advisor compose settle, prompt and brief result: ${order}`, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'oracle-coexistence-'));
    const previous = process.env.SENPI_CODING_AGENT_DIR;
    const disabled = process.env.OMO_ORACLE_ADVISOR;
    process.env.SENPI_CODING_AGENT_DIR = directory;
    process.env.OMO_ORACLE_ADVISOR = '1';
    delete globalThis[REGISTRATION_KEY];
    const fake = createFakePi();
    try {
      if (order === 'briefing-first') briefing(fake.pi);
      const runtime = extension(fake.pi);
      if (order === 'advisor-first') briefing(fake.pi);
      await fake.emit('session_start');
      await fake.command('oracle', 'on');
      runtime.ledger.append({ type: 'stop_opened', job_id: 'J1', stop_id: 'S1',
        reasons: [{ text: 'Check acceptance evidence.' }] });
      const original = { type: 'custom_message', customType: 'original', content: 'original' };
      const settled = await dispatch(fake, 'agent_before_settle', { entries: [original] });
      assert.deepEqual(settled.entries.map(entry => entry.customType).sort(),
        ['original', 'briefing', 'oracle-advisor-stop'].sort());
      assert.equal(settled.entries[0], original);
      const prompt = await dispatch(fake, 'before_agent_start', { systemPrompt: 'BASE' });
      assert.match(prompt.systemPrompt, /BASE/);
      assert.match(prompt.systemPrompt, /BRIEFING BLOCK/);
      assert.match(prompt.systemPrompt, /ORACLE STOP/);
      assert.match(prompt.systemPrompt, /oracle_consult/);
      await dispatch(fake, 'tool_call', {
        type: 'tool_call', toolName: 'brief', toolCallId: 'brief-1', input: {},
      });
      const details = { briefing: true }, structuredContent = { original: true };
      const brief = await dispatch(fake, 'tool_result', {
        type: 'tool_result', toolName: 'brief', toolCallId: 'brief-1', isError: false,
        content: [{ type: 'text', text: 'native brief' }], details, structuredContent,
      });
      assert.equal(brief.details, details);
      assert.equal(brief.structuredContent, structuredContent);
      assert.equal(brief.content.length, 3);
      assert.equal(brief.content[0].text, 'native brief');
      assert.ok(brief.content.some(part => part.text === 'briefing result edit'));
      assert.ok(brief.content.some(part => /oracle_consult/.test(part.text)));
      await fake.emit('session_shutdown');
    } finally {
      delete globalThis[REGISTRATION_KEY];
      if (previous === undefined) delete process.env.SENPI_CODING_AGENT_DIR;
      else process.env.SENPI_CODING_AGENT_DIR = previous;
      if (disabled === undefined) delete process.env.OMO_ORACLE_ADVISOR;
      else process.env.OMO_ORACLE_ADVISOR = disabled;
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
