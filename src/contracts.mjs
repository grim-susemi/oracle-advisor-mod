export const CONSULT_CAP = 4;
export const WORK_CONSULTS = 3;
export const NUDGE_CAP = 3;
export const FAILURE_NUDGES = 2;
export const GATE_TERMINATE_AFTER = 5;
export const OVERRIDE_MIN_REASON = 20;
export const REASON_MAX = 800;
export const VERDICT_REASON_MAX = 240;
export const VERDICT_MAX_BYTES = 4096;

export const LEDGER_ENTRY_TYPE = 'oracle-advisor';
export const LEDGER_ENTRY_TYPES = Object.freeze([
  'job_opened', 'job_paused', 'job_resumed', 'job_ended',
  'consult_reserved', 'consult_started', 'consult_finished', 'consult_interrupted',
  'consult_released', 'consult_effect_recorded', 'oracle_assigned', 'oracle_retired', 'revival_failed', 'stuck_record_retired',
  'verdict_recorded', 'redirect_disposition', 'stop_opened', 'stop_disposition', 'stop_override',
  'seed_bound', 'nudge_recorded', 'gate_blocked', 'progress_recorded', 'trigger_state_recorded',
]);

export const CONSULT_PATHS = Object.freeze(['revival', 'spawn', 'fresh_fallback']);
export const CONSULT_STATUSES = Object.freeze([
  'answered', 'timed_out', 'cancelled', 'oracle_dead', 'unavailable', 'quota',
  'invalid', 'interrupted', 'revival_failed', 'oracle_not_readonly',
]);
export const USAGE_STATUSES = Object.freeze(['actual', 'estimated', 'unknown']);
export const RECEIPT_FIELDS = Object.freeze([
  'job_id', 'job_epoch', 'request_id', 'kind', 'trigger', 'oracle_task_id',
  'oracle_run_epoch', 'path', 'status', 'latency_ms', 'main_cache_wait_exceeded',
  'analysis_chars', 'analysis_path', 'provider_stop_reason', 'engine_completion_chars',
  'model', 'usage_status', 'input_tokens', 'output_tokens', 'reasoning_tokens',
  'verdict', 'verdict_changed_direction', 'same_failure_recurred_after', 'calls_remaining', 'failure_digest', 'redirect_id',
]);
