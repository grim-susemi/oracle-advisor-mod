import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { adaptA7Evidence } from './replay-a7-t19a2.mjs';
import { evaluateVerdict, verdictSpec } from './verdict-spec.mjs';
import { READONLY_ORACLE_TOOLS } from '../scripts/oracle-policy.mjs';

const normalized = path => path.replace(/\\/g, '/').toLowerCase();
const files = directory => readdirSync(directory, { withFileTypes: true }).flatMap(entry =>
  entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)]);
const orderedPath = path => /\.ordered\.jsonl(?:\.interrupted)?$/.test(path);

// The a8 child capture is not the driver's receipt-pointer stream. Keep both,
// validate the capture envelope, and delegate only the matching pointer format.
export function adaptA8Evidence(input) {
  const adapted = adaptA7Evidence({ ...input, orderedText: input.driverText });
  let previous = -1, count = 0;
  try {
    if (typeof input.orderedText !== 'string') throw new Error('Missing child capture stream.');
    for (const line of input.orderedText.split(/\r?\n/).filter(line => line.trim())) {
      const record = JSON.parse(line);
      if (!Number.isInteger(record.sequence) || record.sequence <= previous ||
          !['stdout', 'stderr'].includes(record.stream) ||
          typeof record.text !== 'string' || typeof record.timestamp !== 'string' ||
          !Number.isInteger(record.observer_pid) || !Number.isInteger(record.child_pid)) {
        throw new Error('Unknown a8 child capture envelope.');
      }
      previous = record.sequence;
      count++;
    }
    if (!count) throw new Error('Empty child capture stream.');
  } catch (error) {
    adapted.diagnostics.push({ code: 'a8_capture_shape', severity: 'error', message: error.message });
  }
  adapted.schema.child_capture_records = count;
  return adapted;
}

export function replayCase(input, options = {}) {
  let adapted;
  try {
    adapted = input.batch === 'a8' ? adaptA8Evidence(input) : adaptA7Evidence(input);
  } catch (error) {
    adapted = { observation: { case: input.caseName, events: [] }, schema: {},
      diagnostics: [{ code: 'adapter_input_malformed', severity: 'error', message: error.message }] };
  }
  const { observation, schema, diagnostics } = adapted;
  const inputErrors = diagnostics.some(item => item.severity === 'error' &&
    item.code !== 'scenario_events_missing');
  let failure;
  try {
    evaluateVerdict(input.caseName, observation, { ...options, real: true, host: true,
      oracle: observation.oracle_mode, down: input.caseName === 'acceptance-oracle-down' });
  } catch (error) {
    failure = error;
    diagnostics.push({ code: error.code ?? 'predicate_rejected', severity: 'error',
      message: error.message, phase: error.verdict_phase ?? null,
      clause_id: error.verdict_row ?? null });
  }
  const verdict = inputErrors ? 'reject' : failure
    ? failure instanceof TypeError ? 'reject'
      : failure.code === 'scenario_not_reached' || failure.verdict_phase === 'admission'
        ? 'scenario_not_reached' : 'reject'
    : diagnostics.some(item => item.severity === 'error') ? 'reject' : 'accepted';
  return { case: input.caseName, verdict,
    clause_ids: verdictSpec.filter(row => row.cases.includes(input.caseName)).map(row => row.id),
    completed_clause_ids: (observation.verdict_rows ?? []).map(row => row.id),
    reason: diagnostics.filter(item => item.severity === 'error').map(item => item.message).join('; ') ||
      'All final-table predicates passed.',
    diagnostics, schema, evaluator: { invoked: true, failed_clause_id: failure?.verdict_row ?? null,
      phase: failure?.verdict_phase ?? null } };
}

export function rawManifest(directory) {
  return files(directory).filter(path => !/[/\\]replay-t19a[23]\.json$/.test(path)).sort()
    .map(path => {
      const bytes = readFileSync(path);
      return { path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
    });
}

export function replayBatch(directory, { batch, ...options } = {}) {
  const root = resolve(directory);
  batch ??= /[/\\]a8$/.test(root) ? 'a8' : 'a7';
  const before = rawManifest(root);
  const summary = JSON.parse(readFileSync(join(root, 'batch-summary.json'), 'utf8'));
  const paths = files(root).filter(orderedPath).sort();
  const catalog = new Map(summary.cases.map(item => [normalized(item.raw_log), item]));
  const inventory = new Map(paths.map(path => [normalized(path), path]));
  for (const item of summary.cases) inventory.set(normalized(item.raw_log), item.raw_log);
  const entries = [];
  for (const path of inventory.values()) {
    const diagnostics = [];
    const interrupted = path.endsWith('.interrupted');
    const base = path.replace(/\.driver\.ordered\.jsonl$/, '.ordered.jsonl');
    const item = catalog.get(normalized(base));
    const caseName = item?.case ?? path.split(/[/\\]/).at(-1)
      .replace(/(?:\.driver)?\.ordered\.jsonl(?:\.interrupted)?$/, '');
    const artifact = item?.artifact ?? base.replace(/\.ordered\.jsonl$/, '.json');
    const load = source => {
      if (typeof source !== 'string' || !normalized(source).startsWith(normalized(root) + '/')) {
        diagnostics.push({ code: 'source_outside_batch', severity: 'error', source,
          message: 'Source is not inside the retained batch.' });
        return null;
      }
      try { return readFileSync(source, 'utf8'); }
      catch (error) {
        diagnostics.push({ code: 'raw_source_missing', severity: 'error', source, message: error.message });
        return null;
      }
    };
    let receipt = {};
    try { receipt = JSON.parse(load(artifact)); }
    catch (error) {
      diagnostics.push({ code: 'receipt_json_malformed', severity: 'error', message: error.message });
    }
    const native = receipt?.native_receipt ?? {};
    const sourcePaths = [...(receipt?.raw_logs?.retained_host_event_logs ?? []),
      ...(native.variants ?? []).map(variant => variant.evidence).filter(Boolean)];
    if (caseName.startsWith('oracle-') &&
        !['oracle-profile-switch', 'oracle-project-override-write'].includes(caseName) && native.run_dir) {
      sourcePaths.push(join(native.run_dir, 'real-provider-schemas.json'));
    }
    const sources = [...new Set(sourcePaths)].map(source => ({ path: source, text: load(source) }));
    const childPath = base;
    const driverPath = base.replace(/\.ordered\.jsonl$/, '.driver.ordered.jsonl');
    const result = replayCase({ batch, caseName, receipt: { ...receipt, artifact },
      orderedText: load(batch === 'a8' ? childPath : path),
      driverText: batch === 'a8' ? load(driverPath) : undefined, sources }, options);
    if (interrupted) diagnostics.push({ code: 'interrupted_capture', severity: 'error',
      message: 'Interrupted capture has no independently identified receipt; not merged with a later run.' });
    if (diagnostics.length) {
      result.verdict = 'reject';
      result.diagnostics.push(...diagnostics);
      result.reason = result.diagnostics.filter(item => item.severity === 'error')
        .map(item => item.message).join('; ');
    }
    entries.push({ ...result, raw_log: path, artifact, driver_log: batch === 'a8' ? driverPath : path });
  }
  const after = rawManifest(root);
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('Retained raw evidence changed during replay.');
  return { schema_version: 1, batch, evaluator: 'qa/verdict-spec.mjs#evaluateVerdict',
    model_runs: 0, native_runs: 0, raw_manifest_before: before, raw_manifest_after: after,
    coverage: { summary_cases: summary.cases.length, discovered_ordered_logs: paths.length,
      replayed_logs: entries.length, raw_files: before.length,
      verdict_counts: Object.fromEntries(['accepted', 'reject', 'scenario_not_reached']
        .map(verdict => [verdict, entries.filter(item => item.verdict === verdict).length])) },
    entries };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const batches = process.argv.slice(2);
  for (const batch of batches.length ? batches : ['a7', 'a8']) {
    if (!['a7', 'a8'].includes(batch)) throw new Error('Expected a7 or a8.');
    const result = replayBatch(join(root, '.omo/evidence', batch), {
      batch, skill: readFileSync(join(root, 'test/fixtures/seed-skill.yaml'), 'utf8'),
      expectedTools: Object.keys(READONLY_ORACLE_TOOLS)
        .filter(name => !['coordination_inspect', 'coordination_ask'].includes(name)).sort(),
    });
    const output = join(root, '.omo/evidence', batch, 'replay-t19a3.json');
    const evidence = join(root, '.omo/evidence/a3/task-19-piomo-oracle-advisor-mod');
    mkdirSync(evidence, { recursive: true });
    writeFileSync(join(evidence, `${batch}-raw-manifest-before.json`),
      JSON.stringify(result.raw_manifest_before, null, 2) + '\n');
    writeFileSync(join(evidence, `${batch}-raw-manifest-after.json`),
      JSON.stringify(result.raw_manifest_after, null, 2) + '\n');
    writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify({ output, ...result.coverage }));
  }
}
