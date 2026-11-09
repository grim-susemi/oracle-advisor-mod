import consultQA from './consult-extension.mjs';

export default function autoAtlasQA(pi) {
  pi.on('session_start', () => {
    pi.appendEntry('primary-agent/v1', {
      schemaVersion: 1, agentId: process.env.ORACLE_QA_AUTO_DRIVER,
    });
  });
  consultQA(pi);
}
