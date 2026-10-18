// Public metadata from the owner's models-store.json and models.json override.
// The harness passes the one configured key in memory through the host environment.
export default function cheapMain(pi) {
  const key = process.env.ORACLE_QA_MAIN_KEY;
  if (!key) {
    throw new Error('missing_main_credential: live Ollama API key is unavailable');
  }
  pi.registerProvider('ollama', {
    name: 'Ollama cloud (owned QA)',
    api: 'openai-completions',
    baseUrl: 'https://ollama.com/v1',
    apiKey: key,
    models: [{
      id: 'deepseek-v4.1-flash', name: 'deepseek-v4.1-flash',
      reasoning: true, input: ['text', 'image'],
      contextWindow: 1048576, maxTokens: 16384,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      thinkingLevelMap: { off: 'none', minimal: null, low: 'low', medium: null, high: 'high', xhigh: null, max: 'max' },
      compat: {
        supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: true,
        maxTokensField: 'max_tokens', supportsStrictMode: false, supportsLongCacheRetention: false,
      },
    }],
  });
}
