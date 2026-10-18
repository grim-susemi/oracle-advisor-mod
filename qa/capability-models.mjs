export default function capabilityModels(pi) {
  pi.registerProvider('oracle-qa-mock', {
    name: 'Oracle capability local fixture',
    baseUrl: process.env.ORACLE_QA_MOCK_URL,
    api: 'openai-completions',
    apiKey: 'local-fixture-not-a-credential',
    models: ['main', 'oracle'].map(id => ({
      id, name: `Capability ${id}`, reasoning: false, input: ['text', 'image'],
      contextWindow: 200000, maxTokens: 4096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      compat: { supportsStore: false, supportsDeveloperRole: false },
    })),
  });
}
