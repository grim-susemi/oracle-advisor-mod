export function decideProbe(observed) {
  const arrival = observed.await.find(item => item.works);
  const stuck = observed.stuck_record.reproduced ||
    observed.revivals.some(item => item.answered && item.status === 'running');
  const policy = observed.policy.schema_valid && observed.policy.exclusive;
  const timeout = observed.provider_idle_timeout;
  return {
    await_mechanism: arrival?.name ?? 'none',
    live_residency: arrival?.independent_of_terminal && stuck ? 'enabled' : 'disabled',
    allowlist_key: policy ? 'tools' : 'unproven',
    allowlist_paths: policy ? observed.policy.paths : [],
    answered_consult_latencies_ms: [
      observed.foreground.latency_ms,
      ...observed.revivals.filter(item => item.answered).map(item => item.latency_ms),
    ].filter(Number.isFinite),
    provider_idle_timeout: {
      applies: timeout.applies, value_ms: timeout.value_ms,
      ...(timeout.installed_host_default_ms === undefined ? {} : { installed_host_default_ms: timeout.installed_host_default_ms }),
      ...(timeout.fixture_value_ms === undefined ? {} : { fixture_value_ms: timeout.fixture_value_ms }),
      ...(timeout.error == null ? {} : { error: timeout.error }),
    },
    abort_propagates: observed.foreground.abort_propagates,
  };
}
