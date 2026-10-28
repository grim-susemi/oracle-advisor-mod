import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createFakePi } from './helpers/fake-pi.mjs';
import { registerNature, getNature, noteJobOpen, RING_SIZE } from '../src/nature.mjs';

function setup(sessionId = `s-${Math.random().toString(36).slice(2)}`) {
  const fake = createFakePi({ sessionId });
  const runtime = {};
  registerNature(fake.pi, runtime);
  const task = (input, toolCallId = `t-${Math.random().toString(36).slice(2)}`, extra = {}) =>
    fake.emit('tool_call', { toolName: 'task', toolCallId, input, ...extra });
  const input = (source = 'interactive', text = 'hello') =>
    fake.emit('input', { source, text });
  const start = () => fake.emit('session_start', { reason: 'started' });
  return { fake, runtime, task, input, start, sessionId };
}

describe('nature classification', () => {
  it('design when category is visual-engineering', async () => {
    const { task, runtime, sessionId } = setup();
    await task({ category: 'visual-engineering', prompt: 'draw a button' });
    assert.equal(runtime.nature.forConsult(sessionId, 'work'), 'design');
  });

  it('lowlevel when Loadout line names debugging', async () => {
    const { task, runtime, sessionId } = setup();
    await task({ category: 'deep-low', prompt: 'investigate\nLoadout: debugging\nmore' });
    assert.equal(runtime.nature.forConsult(sessionId, 'work'), 'lowlevel');
  });

  it('mixed when a batch mixes design and lowlevel', async () => {
    const { task, runtime, sessionId } = setup();
    await task({ tasks: [
      { category: 'visual-engineering', prompt: 'a' },
      { category: 'deep-low', prompt: 'b\nLoadout: debugging' },
    ] });
    assert.equal(runtime.nature.forConsult(sessionId, 'work'), 'mixed');
  });

  it('neutral when nothing matches', async () => {
    const { task, runtime, sessionId } = setup();
    await task({ category: 'deep-low', prompt: 'no loadout here' });
    assert.equal(runtime.nature.forConsult(sessionId, 'work'), 'neutral');
  });

  it('reads the Loadout line and ignores armed load_skills', async () => {
    const { task, runtime, sessionId } = setup();
    // An earlier hook armed load_skills=debugging from the category table;
    // without a Loadout line this must stay neutral (not lowlevel).
    await task({ category: 'deep-low', prompt: 'plain work', load_skills: ['debugging'] });
    assert.equal(runtime.nature.forConsult(sessionId, 'work'), 'neutral');
  });

  it('Loadout none with backticks parsed per the arming rule', async () => {
    const { task, runtime, sessionId } = setup();
    await task({ category: 'deep-low', prompt: 'x\nLoadout: `debugging`' });
    assert.equal(runtime.nature.forConsult(sessionId, 'work'), 'lowlevel');
    const s2 = setup();
    await s2.task({ category: 'deep-low', prompt: 'x\nLoadout: none - no skills needed', load_skills: ['debugging'] });
    assert.equal(s2.runtime.nature.forConsult(s2.sessionId, 'work'), 'neutral');
  });

  it('batch items inherit a top-level category', async () => {
    const { task, runtime, sessionId } = setup();
    await task({ category: 'visual-engineering', tasks: [{ prompt: 'a' }, { prompt: 'b' }] });
    assert.equal(runtime.nature.forConsult(sessionId, 'work'), 'design');
  });

  it('an item own category wins over the inherited batch category', async () => {
    const { task, runtime, sessionId } = setup();
    await task({ category: 'visual-engineering', tasks: [{ category: 'deep-low', prompt: 'a' }] });
    assert.equal(runtime.nature.forConsult(sessionId, 'work'), 'neutral');
  });
});

describe('nature recording guards', () => {
  it('ignores nested calls carrying parentToolCallId', async () => {
    const { task, runtime, sessionId } = setup();
    await task(
      { category: 'visual-engineering', prompt: 'nested' },
      'nested-1',
      { parentToolCallId: 'parent-9' },
    );
    assert.equal(runtime.nature.forConsult(sessionId, 'work'), 'neutral');
  });

  it('does not record subagent_type-only calls', async () => {
    const { task, runtime, sessionId } = setup();
    await task({ subagent_type: 'oracle', prompt: 'advise me' });
    await task({ category: 'visual-engineering', prompt: 'real' });
    assert.equal(runtime.nature.forConsult(sessionId, 'work'), 'design');
    // Unrecorded calls must not pollute the ring either: 64 subagent-only
    // calls after a job-opened design record leave the completion intact.
    const s2 = setup();
    noteJobOpen(s2.sessionId);
    await s2.task({ category: 'visual-engineering', prompt: 'kept' });
    for (let i = 0; i < RING_SIZE; i += 1) {
      await s2.task({ subagent_type: 'oracle', prompt: `noise ${i}` }, `noise-${i}`);
    }
    assert.equal(s2.runtime.nature.forConsult(s2.sessionId, 'completion'), 'design');
  });

  it('ignores non-task tools and child sessions', async () => {
    const { task, runtime, sessionId, fake } = setup();
    await fake.emit('tool_call', { toolName: 'read', toolCallId: 'r1', input: { path: 'x' } });
    assert.equal(runtime.nature.forConsult(sessionId, 'work'), 'neutral');
    const child = createFakePi({ sessionKind: 'background', sessionId: 'child-1' });
    const childRuntime = {};
    registerNature(child.pi, childRuntime);
    await child.emit('tool_call', {
      toolName: 'task', toolCallId: 'c1',
      input: { category: 'visual-engineering', prompt: 'x' },
    });
    assert.equal(childRuntime.nature.forConsult('child-1', 'work'), 'neutral');
    assert.equal(runtime.nature.forConsult(sessionId, 'work'), 'neutral');
    await task(null);
    await task({ tasks: 'not-an-array' });
    await task({ tasks: [{ prompt: 'no category' }] });
    assert.equal(runtime.nature.forConsult(sessionId, 'work'), 'neutral');
    void sessionId;
  });

  it('records nothing when the session file sits under senpi-task/children', async () => {
    for (const sessionFile of [
      'owned/senpi-task/children/a/s.jsonl',
      'C:/x/Senpi-Task/Children/a/s.jsonl',
    ]) {
      const childId = `cp-${Math.random().toString(36).slice(2)}`;
      const child = createFakePi({ sessionKind: 'interactive', sessionFile, sessionId: childId });
      const childRuntime = {};
      registerNature(child.pi, childRuntime);
      await child.emit('tool_call', {
        toolName: 'task', toolCallId: 'cp1',
        input: { category: 'visual-engineering', prompt: 'hidden' },
      });
      assert.equal(childRuntime.nature.forConsult(childId, 'work'), 'neutral');
      void child;
    }
  });

  it('ignores extension-source input for the horizon', async () => {
    const { task, input, runtime, sessionId } = setup();
    await task({ category: 'visual-engineering', prompt: 'early' });
    await input('extension', '/oracle status');
    assert.equal(runtime.nature.forConsult(sessionId, 'work'), 'design');
  });
});

describe('nature freshness horizons', () => {
  it('a work consult ignores records older than the last owner input', async () => {
    const { task, input, runtime, sessionId } = setup();
    await task({ category: 'visual-engineering', prompt: 'early' });
    await input('interactive', '/ulw-execute plan');
    assert.equal(runtime.nature.forConsult(sessionId, 'work'), 'neutral');
    await task({ category: 'deep-low', prompt: 'late\nLoadout: debugging' });
    assert.equal(runtime.nature.forConsult(sessionId, 'work'), 'lowlevel');
  });

  it('a work consult ignores records older than session start', async () => {
    const { task, start, runtime, sessionId } = setup();
    await task({ category: 'visual-engineering', prompt: 'early' });
    await start();
    assert.equal(runtime.nature.forConsult(sessionId, 'work'), 'neutral');
  });

  it('a work consult ignores records older than job open', async () => {
    const { task, runtime, sessionId } = setup();
    await task({ category: 'visual-engineering', prompt: 'early' });
    noteJobOpen(sessionId);
    assert.equal(runtime.nature.forConsult(sessionId, 'work'), 'neutral');
    await task({ category: 'deep-low', prompt: 'late\nLoadout: debugging' });
    assert.equal(runtime.nature.forConsult(sessionId, 'work'), 'lowlevel');
  });

  it('a completion consult needs uniform non-neutral records since job open', async () => {
    const { task, runtime, sessionId } = setup();
    noteJobOpen(sessionId);
    await task({ category: 'deep-low', prompt: 'a\nLoadout: debugging' });
    await task({ category: 'deep-low', prompt: 'b\nLoadout: debugging' });
    assert.equal(runtime.nature.forConsult(sessionId, 'completion'), 'lowlevel');
    const s2 = setup();
    noteJobOpen(s2.sessionId);
    await s2.task({ category: 'deep-low', prompt: 'a\nLoadout: debugging' });
    await s2.task({ category: 'visual-engineering', prompt: 'b' });
    assert.equal(s2.runtime.nature.forConsult(s2.sessionId, 'completion'), 'neutral');
  });

  it('a work consult returns the newest fresh record', async () => {
    const { task, runtime, sessionId } = setup();
    await task({ category: 'visual-engineering', prompt: 'first' });
    await task({ category: 'deep-low', prompt: 'second\nLoadout: debugging' });
    assert.equal(runtime.nature.forConsult(sessionId, 'work'), 'lowlevel');
  });

  it('a completion consult with no records since job open is neutral', async () => {
    const { task, runtime, sessionId } = setup();
    await task({ category: 'visual-engineering', prompt: 'early' });
    noteJobOpen(sessionId);
    assert.equal(runtime.nature.forConsult(sessionId, 'completion'), 'neutral');
  });

  it('a completion consult treats a neutral record as breaking uniformity', async () => {
    const { task, runtime, sessionId } = setup();
    noteJobOpen(sessionId);
    await task({ category: 'visual-engineering', prompt: 'design work' });
    await task({ category: 'deep-low', prompt: 'plain work, no Loadout' });
    assert.equal(runtime.nature.forConsult(sessionId, 'completion'), 'neutral');
    const s2 = setup();
    noteJobOpen(s2.sessionId);
    await s2.task({ category: 'visual-engineering', prompt: 'design only' });
    assert.equal(s2.runtime.nature.forConsult(s2.sessionId, 'completion'), 'design');
  });

  it('ring eviction makes a completion consult unknown but keeps work', async () => {
    assert.equal(RING_SIZE, 64);
    const { task, runtime, sessionId } = setup();
    noteJobOpen(sessionId);
    for (let i = 0; i < RING_SIZE + 1; i += 1) {
      await task({ category: 'deep-low', prompt: `w${i}\nLoadout: debugging` }, `evict-${i}`);
    }
    assert.equal(runtime.nature.forConsult(sessionId, 'completion'), 'neutral');
    assert.equal(runtime.nature.forConsult(sessionId, 'work'), 'lowlevel');
  });

  it('getNature matches forConsult', async () => {
    const { task, sessionId } = setup();
    await task({ category: 'visual-engineering', prompt: 'v' });
    assert.equal(getNature(sessionId, 'work'), 'design');
  });
});
