import cheapMain from './main-provider.mjs';

// Keep the existing read-only credential loader. Only this disposable provider
// route changes: a loopback proxy records the actual child schema, then forwards
// to the same real provider without storing headers, keys, or request payloads.
export default function policyModels(pi) {
  cheapMain({
    registerProvider(name, configuration) {
      pi.registerProvider(name, { ...configuration, baseUrl: process.env.ORACLE_QA_POLICY_PROXY });
    },
  });
}
