import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export function typedError(code, message = code) {
  return Object.assign(new Error(message), { code });
}
export function writeJson(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
}
export function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}
export function withSafety(attemptDir, mutate) {
  mkdirSync(attemptDir, { recursive: true });
  const lock = join(attemptDir, 'real-model-safety.lock');
  const fd = openSync(lock, 'wx');
  try {
    const path = join(attemptDir, 'real-model-safety.json');
    const state = existsSync(path) ? readJson(path) : { real_oracle_runs: 0, blocked: false };
    const result = mutate(state);
    writeJson(path, state);
    return result;
  } finally {
    closeSync(fd);
    unlinkSync(lock);
  }
}
