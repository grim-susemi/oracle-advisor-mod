import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

export const installedLoaderPath = 'C:/Users/USER/.omo-stable-500/staging/memory-rollback-5.1.34-r1/package/plugin/runtime/task-config/index.js';
const source = readFileSync(installedLoaderPath, 'utf8');
export const installedLoaderHash = createHash('sha256').update(source).digest('hex');
// Execute the installed bundle unchanged, adding only test-visible exports.
// No installed file, config, credential, host process, or provider is modified.
export const installedLoader = await import('data:text/javascript;base64,' + Buffer.from(source +
  ';export {loadOmoConfig};').toString('base64'));
