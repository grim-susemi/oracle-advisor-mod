import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verdictClauses } from '../qa/verdict-clauses.mjs';
import {
  clauseTests, hostAcceptanceClauses, commandAcceptanceClauses,
} from '../qa/verdict-clause-tests.mjs';

const targetTodos = [3, 4, 6, 8, 9, 10, 11, 13, 17, 18];
const sectionNames = {
  Acceptance: 'acceptance',
  'QA happy': 'qa-happy',
  Failure: 'qa-failure',
  'Other oracle users': 'qa-other',
  'Extra QA': 'qa-extra',
};
const planPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..', '..', '\uAE30\uD0C0 \uC791\uC5C5', '.omo', 'plans',
  'piomo-oracle-advisor-mod.md',
);
const substantive = /[^\p{P}\p{Z}\s]/u;
const word = /[\p{L}\p{N}]/u;
const productRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function decodeLiteral(value) {
  return value.replace(/\\(?:u\{([a-f\d]+)\}|u([a-f\d]{4})|x([a-f\d]{2})|([\s\S]))/gi,
    (_match, codePoint, unicode, hex, character) => {
      if (codePoint) return String.fromCodePoint(Number.parseInt(codePoint, 16));
      if (unicode || hex) return String.fromCharCode(Number.parseInt(unicode || hex, 16));
      return ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', 0: '\0' })[character]
        ?? (character === '\n' ? '' : character);
    });
}

function testDeclarations(source) {
  const declarations = [];
  const quoted = start => {
    const quote = source[start];
    let end = start + 1;
    while (end < source.length) {
      if (source[end] === '\\') end += 2;
      else if (source[end++] === quote) break;
    }
    return { quote, raw: source.slice(start + 1, end - 1), end };
  };
  for (let index = 0; index < source.length;) {
    if (source.startsWith('//', index)) {
      const newline = source.indexOf('\n', index + 2);
      index = newline < 0 ? source.length : newline + 1;
      continue;
    }
    if (source.startsWith('/*', index)) {
      const end = source.indexOf('*/', index + 2);
      index = end < 0 ? source.length : end + 2;
      continue;
    }
    if ('\'"`'.includes(source[index])) {
      index = quoted(index).end;
      continue;
    }
    const call = source.slice(index).match(
      /^(?:test|it)(?:\.(skip|todo|only))?\s*\(\s*(['"`])/,
    );
    if (!call || /[\w$]/.test(source[index - 1] ?? '')) {
      index++;
      continue;
    }
    const literal = quoted(index + call[0].length - 1);
    index = literal.end;
    if (call[1] === 'skip' || call[1] === 'todo') continue;
    const dynamic = literal.quote === '`' && literal.raw.includes('${');
    const template = dynamic
      ? new RegExp('^' + literal.raw.split(/\$\{[^}]*\}/).map(part =>
        decodeLiteral(part).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\s\\S]*') + '$')
      : undefined;
    declarations.push({ name: decodeLiteral(literal.raw), template });
  }
  return declarations;
}

function parsePlan(source) {
  const sections = [];
  let todo;
  for (const [index, line] of source.split(/\r?\n/).entries()) {
    const heading = line.match(/^- \[[^\]]+\] (\d+)\./);
    if (heading) todo = Number(heading[1]);
    else if (/^## /.test(line)) todo = undefined;
    if (!targetTodos.includes(todo)) continue;
    if (!/^  - (?:Acceptance|QA happy):/.test(line)
      && !line.includes('Extra QA: ')) continue;

    const markers = [...line.matchAll(
      /\b(Acceptance|QA happy|Failure|Other oracle users|Extra QA):\s*/g,
    )];
    for (const [markerIndex, marker] of markers.entries()) {
      const start = marker.index + marker[0].length;
      const end = markers[markerIndex + 1]?.index ?? line.length;
      sections.push({
        todo,
        plan_line: index + 1,
        section: sectionNames[marker[1]],
        body: line.slice(start, end).trim(),
        line,
      });
    }
  }
  return sections;
}

const planSections = parsePlan(await readFile(planPath, 'utf8'));

test('the actual plan supplies Acceptance and QA sections for every scoped todo', () => {
  assert.deepEqual(
    [...new Set(planSections.map(section => section.todo))].sort((a, b) => a - b),
    targetTodos,
  );
  for (const todo of targetTodos) {
    const sections = planSections.filter(section => section.todo === todo);
    assert.ok(sections.some(section => section.section === 'acceptance'),
      `todo ${todo}: missing Acceptance section in ${planPath}`);
    assert.ok(sections.some(section => section.section === 'qa-happy'),
      `todo ${todo}: missing QA happy section in ${planPath}`);
  }
});

test('clause identities point to exact substrings in their actual plan sections', () => {
  assert.ok(Array.isArray(verdictClauses));
  assert.ok(verdictClauses.length > 0);
  const ids = new Set();
  for (const clause of verdictClauses) {
    assert.deepEqual(Object.keys(clause).sort(),
      ['id', 'plan_line', 'quote', 'section', 'todo']);
    assert.equal(typeof clause.id, 'string');
    assert.ok(clause.id.startsWith(
      `t${String(clause.todo).padStart(2, '0')}.${clause.section}.`,
    ), `${clause.id}: identity must name its todo and section`);
    assert.ok(!ids.has(clause.id), `duplicate clause id: ${clause.id}`);
    ids.add(clause.id);
    assert.ok(targetTodos.includes(clause.todo), `${clause.id}: out-of-scope todo`);
    assert.ok(Number.isInteger(clause.plan_line) && clause.plan_line > 0,
      `${clause.id}: plan_line must be a one-based line number`);
    assert.equal(typeof clause.quote, 'string');
    assert.ok(word.test(clause.quote), `${clause.id}: empty or punctuation-only quote`);
    const section = planSections.find(candidate =>
      candidate.todo === clause.todo
      && candidate.plan_line === clause.plan_line
      && candidate.section === clause.section);
    assert.ok(section, `${clause.id}: no matching plan section at line ${clause.plan_line}`);
    assert.ok(section.line.includes(clause.quote),
      `${clause.id}: quote is not an exact substring of plan line ${clause.plan_line}`);
    const start = section.body.indexOf(clause.quote);
    assert.ok(start >= 0, `${clause.id}: quote belongs to a different section`);
    assert.equal(start, section.body.lastIndexOf(clause.quote),
      `${clause.id}: quote must identify one occurrence in its section`);
  }
});

test('semantic rows do not collapse semicolon clauses or distinct named QA cases', () => {
  for (const clause of verdictClauses) {
    const conditions = clause.quote.split(';').filter(part => substantive.test(part));
    assert.ok(conditions.length <= 1,
      `${clause.id}: split semicolon-separated conditions into semantic rows`);
    const cases = [...clause.quote.matchAll(/--case\s+([a-z\d-]+)/g)];
    assert.ok(cases.length <= 1,
      `${clause.id}: distinct QA cases require distinct rows`);
  }
});

test('quotes cover every non-punctuation character of every required plan section', () => {
  for (const section of planSections) {
    const rows = verdictClauses.filter(clause =>
      clause.todo === section.todo
      && clause.plan_line === section.plan_line
      && clause.section === section.section);
    assert.ok(rows.length > 0,
      `todo ${section.todo} line ${section.plan_line} ${section.section}: missing rows`);
    const covered = new Uint8Array(section.body.length);
    for (const row of rows) {
      const start = section.body.indexOf(row.quote);
      assert.ok(start >= 0, `${row.id}: quote does not occur in this section`);
      covered.fill(1, start, start + row.quote.length);
    }
    const gaps = [];
    for (let index = 0; index < section.body.length; index++) {
      if (!covered[index] && substantive.test(section.body[index])) {
        gaps.push({ column: index + 1, character: section.body[index] });
      }
    }
    assert.deepEqual(gaps, [],
      `todo ${section.todo} line ${section.plan_line} ${section.section}: unquoted content`);
  }
});

test('each Acceptance behavior names existing, clause-specific unit test declarations', async () => {
  assert.deepEqual(hostAcceptanceClauses, [
    't13.acceptance.acceptance-exit',
    't13.acceptance.observed-effect-fields',
  ], 'only the owned acceptance flow and effect summary use host proof contexts');
  assert.deepEqual(commandAcceptanceClauses, {
    't17.acceptance.check-exit': 'npm run check',
    't18.acceptance.check-exit': 'npm run check',
  }, 'a unit-test result must not substitute for the actual check/build command');
  const acceptanceIds = verdictClauses.filter(clause => clause.section === 'acceptance')
    .map(clause => clause.id);
  const routedIds = [
    ...Object.keys(clauseTests), ...hostAcceptanceClauses, ...Object.keys(commandAcceptanceClauses),
  ];
  assert.equal(new Set(routedIds).size, routedIds.length,
    'each Acceptance clause needs exactly one proof context');
  assert.deepEqual(routedIds.sort(), acceptanceIds.sort(),
    'Acceptance proof mappings must cover exactly the Acceptance clause IDs');
  const declarationsByFile = new Map();
  for (const [id, proofs] of Object.entries(clauseTests)) {
    assert.ok(Array.isArray(proofs) && proofs.length > 0, `${id}: missing proof tests`);
    const identities = new Set();
    for (const proof of proofs) {
      assert.deepEqual(Object.keys(proof).sort(),
        proof.pattern === undefined ? ['file', 'name'] : ['file', 'name', 'pattern'],
        `${id}: proof entries contain only file, name and optional pattern`);
      assert.ok(typeof proof.file === 'string'
        && proof.file.startsWith('test/') && proof.file.endsWith('.test.mjs')
        && !proof.file.includes('\\') && !proof.file.split('/').includes('..'),
      `${id}: proof file must name a product test source`);
      assert.ok(typeof proof.name === 'string' && proof.name.trim().length > 0,
        `${id}: proof name must identify an actual test`);
      if (proof.pattern !== undefined) assert.equal(typeof proof.pattern, 'boolean');
      const identity = JSON.stringify(proof);
      assert.ok(!identities.has(identity), `${id}: duplicate proof test`);
      identities.add(identity);
      if (!declarationsByFile.has(proof.file)) {
        const source = await readFile(resolve(productRoot, proof.file), 'utf8');
        declarationsByFile.set(proof.file, testDeclarations(source));
      }
      const declarations = declarationsByFile.get(proof.file);
      if (proof.pattern) {
        assert.ok(proof.name.startsWith('^') && proof.name.endsWith('$'),
          `${id}: test-name patterns must be anchored`);
        const expression = new RegExp(proof.name);
        assert.ok(declarations.some(declaration => expression.test(declaration.name)
          || declaration.template?.test(proof.name.slice(1, -1))),
        `${id}: no source test declaration matches ${proof.file} ${proof.name}`);
      } else {
        assert.ok(declarations.some(declaration => declaration.name === proof.name
          || declaration.template?.test(proof.name)),
        `${id}: no source test declaration matches ${proof.file} ${proof.name}`);
      }
    }
  }
});

test('every semantic clause has its own verdict predicates and evidence contract', async () => {
  const { verdictSpec } = await import('../qa/verdict-spec.mjs');
  assert.ok(Array.isArray(verdictSpec), 'verdictSpec must be an array of clause rows');
  const byId = new Map();
  for (const row of verdictSpec) {
    assert.equal(typeof row.id, 'string', 'verdict row requires a clause id');
    assert.ok(!byId.has(row.id), `duplicate verdict row: ${row.id}`);
    byId.set(row.id, row);
  }
  assert.deepEqual([...byId.keys()].sort(), verdictClauses.map(clause => clause.id).sort(),
    'verdictSpec and the clause manifest must have the same identities');
  for (const clause of verdictClauses) {
    const row = byId.get(clause.id);
    assert.ok(row, `${clause.id}: missing verdict row`);
    for (const field of ['todo', 'plan_line', 'quote', 'section']) {
      assert.equal(row[field], clause[field], `${clause.id}: stale ${field}`);
    }
    if (clauseTests[clause.id]) {
      assert.deepEqual(row.cases, ['unit-acceptance'],
        `${clause.id}: unit-only Acceptance proof cannot come from a happy host case`);
    }
    assert.equal(typeof row.admission, 'function',
      `${clause.id}: missing admission predicate`);
    assert.equal(typeof row.behavioral, 'function',
      `${clause.id}: missing behavioral predicate`);
    assert.ok(Array.isArray(row.evidence_fields) && row.evidence_fields.length > 0,
      `${clause.id}: missing evidence fields`);
    for (const field of row.evidence_fields) {
      assert.ok(typeof field === 'string' && field.trim().length > 0,
        `${clause.id}: evidence fields must be nonempty names`);
    }
    assert.equal(new Set(row.evidence_fields).size, row.evidence_fields.length,
      `${clause.id}: duplicate evidence fields`);
  }
});
