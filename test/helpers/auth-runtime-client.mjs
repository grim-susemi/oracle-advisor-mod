import { createInterface } from 'node:readline';
import { guardAuth } from '../../qa/harness.mjs';

const attempt = process.env.ORACLE_QA_ATTEMPT_DIR;
await guardAuth(attempt, undefined, { before: true, providers: ['ollama'] });
console.log(JSON.stringify({
  phase: 'baseline',
  computed_locator_undefined: process.env['ORACLE_QA_' + 'LIVE_AGENT'] === undefined,
}));
const input = createInterface({ input: process.stdin });
for await (const phase of input) {
  try {
    await guardAuth(attempt, undefined, { providers: ['ollama'] });
    console.log(JSON.stringify({ phase, admitted: 1 }));
  } catch (error) {
    console.log(JSON.stringify({ phase, admitted: 0, code: error.code }));
  }
  if (phase === 'guarded') break;
}
input.close();
if (process.connected) process.disconnect();
