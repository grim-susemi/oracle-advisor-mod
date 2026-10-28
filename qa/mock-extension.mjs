export default function mockProvider(pi) {
  if (!process.env.ORACLE_QA_MOCK_URL) return;
  pi.registerProvider('oracle-qa-mock', {
    name: 'Oracle advisor local QA fixture',
    baseUrl: process.env.ORACLE_QA_MOCK_URL,
    api: 'openai-completions',
    apiKey: 'local-fixture-not-a-credential',
    models: [
      ...['main', 'oracle', 'gpt-qa', 'claude-qa'].map(id => ({
        id, name: `QA ${id}`, reasoning: false, input: ['text'],
        contextWindow: 200000, maxTokens: 4096,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        compat: { supportsStore: false, supportsDeveloperRole: false },
      })),
      {
        id: 'gpt-6-astra', name: 'QA gpt-6-astra',
        reasoning: true, input: ['text', 'image'],
        contextWindow: 1048576, maxTokens: 16384,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        thinkingLevelMap: { off: 'none', minimal: null, low: 'low', medium: null, high: 'high', xhigh: null, max: 'max' },
        compat: {
          supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: true,
          maxTokensField: 'max_tokens', supportsStrictMode: false, supportsLongCacheRetention: false,
        },
      },
    ],
  });
}
