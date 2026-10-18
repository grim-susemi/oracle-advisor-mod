export default function mockProvider(pi) {
  if (!process.env.ORACLE_QA_MOCK_URL) return;
  pi.registerProvider('oracle-qa-mock', {
    name: 'Oracle advisor local QA fixture',
    baseUrl: process.env.ORACLE_QA_MOCK_URL,
    api: 'openai-completions',
    apiKey: 'local-fixture-not-a-credential',
    models: ['main', 'oracle'].map(id => ({
      id, name: `QA ${id}`, reasoning: false, input: ['text'],
      contextWindow: 200000, maxTokens: 4096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      compat: { supportsStore: false, supportsDeveloperRole: false },
    })),
  });
}
