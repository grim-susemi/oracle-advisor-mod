// Pure modules for R3 advisor seams: driver reading, nature classification,
// routing validation and advisor resolution. No host access.

import { readFileSync } from 'node:fs';

const VALID_AGENT_IDS = new Set(['sisyphus', 'hephaestus', 'prometheus', 'atlas']);
const PROFILE_NAME_RE = /^[a-z][a-z0-9-]{0,31}$/;
const PIN_GRAMMAR_RE = /^[a-z0-9_.-]+\/([a-z0-9_.-]+)(?::[a-z0-9_.-]+)?$/i;
const LOADOUT_PREFIX = 'Loadout:';
const LINE_BREAK_SPLIT = /(\r\n|[\n\r\u2028\u2029])/;
const LINE_BREAK_SEARCH = /[\n\r\u2028\u2029]/;
const NOT_LINE_BREAK = /[^\n\r\u2028\u2029]/;
const WHITESPACE = /\s/;
const LOADOUT_NONE_RE = /^none(?:\s+-\s*.*)?$/;
const FAMILIES = ['claude', 'gpt', 'other'];

export function loadTaskNature() {
  return JSON.parse(readFileSync(new URL('../config/task-nature.json', import.meta.url), 'utf8'));
}

export function loadDefaultRouting() {
  return JSON.parse(readFileSync(new URL('../config/routing.default.json', import.meta.url), 'utf8'));
}

export function familyOf(modelId) {
  if (typeof modelId !== 'string' || modelId.length === 0) return 'unknown';
  const lower = modelId.toLowerCase();
  if (lower.includes('claude')) return 'claude';
  if (lower.startsWith('gpt-')) return 'gpt';
  return 'other';
}

export function readDriver(branch) {
  if (!Array.isArray(branch)) return null;
  for (let i = branch.length - 1; i >= 0; i -= 1) {
    const entry = branch[i];
    if (entry?.type === 'custom' && entry.customType === 'primary-agent/v1') {
      const data = entry.data;
      if (data && typeof data === 'object' && !Array.isArray(data) &&
          data.schemaVersion === 1 && VALID_AGENT_IDS.has(data.agentId)) {
        return { schemaVersion: 1, agentId: data.agentId };
      }
    }
  }
  return null;
}

function validateProfiles(profiles, profileNames) {
  if (!profiles || typeof profiles !== 'object' || Array.isArray(profiles)) {
    return 'profiles must be an object';
  }
  for (const [name, prof] of Object.entries(profiles)) {
    if (!PROFILE_NAME_RE.test(name)) return `invalid profile name: ${name}`;
    if (!prof || typeof prof !== 'object' || Array.isArray(prof)) return `profile ${name} must be an object`;
    for (const pk of Object.keys(prof)) {
      if (pk !== 'model' && pk !== 'family') return `invalid key in profile ${name}: ${pk}`;
    }
    if (prof.model !== undefined) {
      if (typeof prof.model !== 'string') return `profile ${name}.model must be a string`;
      const match = PIN_GRAMMAR_RE.exec(prof.model);
      if (!match) return `profile ${name}.model does not match pin grammar provider/model[:level]: ${prof.model}`;
      if (!FAMILIES.includes(prof.family)) {
        return `profile ${name}.family required and must be claude, gpt, or other when model is set`;
      }
      const detected = familyOf(match[1]);
      if (detected !== prof.family) {
        return `profile ${name}.family "${prof.family}" does not match detected family "${detected}" for model ${match[1]}`;
      }
    }
    profileNames.add(name);
  }
  return null;
}

function validateMapping(mapping, path, profileNames) {
  if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) return `${path} must be an object`;
  const keys = Object.keys(mapping);
  if (keys.length !== 2 || !keys.includes('work') || !keys.includes('completion')) {
    return `${path} must contain exactly work and completion`;
  }
  if (typeof mapping.work !== 'string' || !profileNames.has(mapping.work)) {
    return `${path}.work must name an existing profile`;
  }
  if (typeof mapping.completion !== 'string' || !profileNames.has(mapping.completion)) {
    return `${path}.completion must name an existing profile`;
  }
  return null;
}

export function validateRouting(json) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    return { valid: false, error: 'routing table must be a non-null object' };
  }
  const allowed = new Set(['v', 'profiles', 'by_family', 'by_agent', 'by_nature']);
  for (const k of Object.keys(json)) {
    if (!allowed.has(k)) return { valid: false, error: `unknown top-level key: ${k}` };
  }
  if (json.v !== 1) return { valid: false, error: `unsupported version: ${json.v}` };

  const profileNames = new Set();
  const profErr = validateProfiles(json.profiles, profileNames);
  if (profErr) return { valid: false, error: profErr };

  if (!json.by_family || typeof json.by_family !== 'object' || Array.isArray(json.by_family)) {
    return { valid: false, error: 'by_family must be an object' };
  }
  const famKeys = Object.keys(json.by_family);
  if (famKeys.length !== 3 || !FAMILIES.every(k => famKeys.includes(k))) {
    return { valid: false, error: 'by_family must contain exactly claude, gpt, other' };
  }
  for (const fam of FAMILIES) {
    const err = validateMapping(json.by_family[fam], `by_family.${fam}`, profileNames);
    if (err) return { valid: false, error: err };
  }

  if (!json.by_agent || typeof json.by_agent !== 'object' || Array.isArray(json.by_agent)) {
    return { valid: false, error: 'by_agent must be an object' };
  }
  for (const [id, m] of Object.entries(json.by_agent)) {
    if (!VALID_AGENT_IDS.has(id)) return { valid: false, error: `invalid agent id in by_agent: ${id}` };
    const err = validateMapping(m, `by_agent.${id}`, profileNames);
    if (err) return { valid: false, error: err };
  }

  if (!json.by_nature || typeof json.by_nature !== 'object' || Array.isArray(json.by_nature)) {
    return { valid: false, error: 'by_nature must be an object' };
  }
  const natureKeys = Object.keys(json.by_nature);
  if (natureKeys.length !== 2 || !natureKeys.includes('design') || !natureKeys.includes('lowlevel')) {
    return { valid: false, error: 'by_nature must contain exactly design and lowlevel' };
  }
  for (const n of ['design', 'lowlevel']) {
    if (typeof json.by_nature[n] !== 'string' || !profileNames.has(json.by_nature[n])) {
      return { valid: false, error: `by_nature.${n} must name an existing profile` };
    }
  }
  return { valid: true, error: null };
}

function extractFirstLoadout(prompt) {
  if (typeof prompt !== 'string') return null;
  const parts = prompt.split(LINE_BREAK_SPLIT);
  let offset = 0;
  for (let i = 0; i < parts.length; i += 2) {
    const line = parts[i];
    const content = line.trimStart();
    if (content.startsWith(LOADOUT_PREFIX)) {
      const colonEnd = offset + line.length - content.length + LOADOUT_PREFIX.length;
      let cur = colonEnd;
      while (cur < prompt.length && WHITESPACE.test(prompt[cur])) cur += 1;
      if (cur < prompt.length) {
        const rest = prompt.slice(cur);
        const end = rest.search(LINE_BREAK_SEARCH);
        return end === -1 ? rest : rest.slice(0, end);
      }
      return NOT_LINE_BREAK.test(prompt.slice(colonEnd)) ? ' ' : null;
    }
    offset += line.length + (parts[i + 1]?.length ?? 0);
  }
  return null;
}

function parseLoadoutSkills(loadoutValue) {
  if (loadoutValue === null) return null;
  const trimmed = loadoutValue.trim();
  if (LOADOUT_NONE_RE.test(trimmed)) return [];
  return trimmed.split(',').map(s => s.replaceAll('`', '').trim()).filter(s => s.length > 0);
}

function classifySingleItem(item, table) {
  if (!item || typeof item !== 'object' || typeof item.category !== 'string') return 'neutral';
  const category = item.category.trim();
  const prompt = typeof item.prompt === 'string' ? item.prompt : '';
  const skills = parseLoadoutSkills(extractFirstLoadout(prompt));

  const desCats = new Set(table?.design?.categories ?? []);
  const desSkills = new Set(table?.design?.skills ?? []);
  const lowCats = new Set(table?.lowlevel?.categories ?? []);
  const lowSkills = new Set(table?.lowlevel?.skills ?? []);

  let isDesign = Boolean(category && desCats.has(category));
  let isLow = Boolean(category && lowCats.has(category));
  if (skills) {
    for (const s of skills) {
      if (desSkills.has(s)) isDesign = true;
      if (lowSkills.has(s)) isLow = true;
    }
  }
  if (isDesign && isLow) return 'mixed';
  if (isDesign) return 'design';
  if (isLow) return 'lowlevel';
  return 'neutral';
}

export function classifyNature(taskArgs, table) {
  if (!taskArgs || typeof taskArgs !== 'object') return 'neutral';
  const items = Array.isArray(taskArgs.tasks) ? taskArgs.tasks : [taskArgs];
  let hasDesign = false;
  let hasLow = false;
  let hasMixed = false;
  for (const item of items) {
    const n = classifySingleItem(item, table);
    if (n === 'mixed') hasMixed = true;
    else if (n === 'design') hasDesign = true;
    else if (n === 'lowlevel') hasLow = true;
  }
  if (hasMixed || (hasDesign && hasLow)) return 'mixed';
  if (hasDesign) return 'design';
  if (hasLow) return 'lowlevel';
  return 'neutral';
}

export function resolveAdvisor({ kind, mainFamily, driver, nature, table }) {
  if (!table || typeof table !== 'object') {
    return { profile: null, model: null, source: 'legacy', reason: 'table_absent' };
  }
  const format = (p, source, reason) => ({
    profile: p,
    model: table.profiles?.[p]?.model ?? null,
    source,
    reason,
  });

  // 1. Task Nature (design or lowlevel)
  if ((nature === 'design' || nature === 'lowlevel') && table.by_nature?.[nature]) {
    const p = table.by_nature[nature];
    if (table.profiles?.[p]) return format(p, 'by_nature', nature);
  }
  // 2. Per-Agent Override
  if (driver && table.by_agent?.[driver]?.[kind]) {
    const p = table.by_agent[driver][kind];
    if (table.profiles?.[p]) return format(p, 'by_agent', `${driver}:${kind}`);
  }
  // 3. Main-Model Family
  if (FAMILIES.includes(mainFamily) && table.by_family?.[mainFamily]?.[kind]) {
    const p = table.by_family[mainFamily][kind];
    if (table.profiles?.[p]) return format(p, 'by_family', `${mainFamily}:${kind}`);
  }
  // 4. Fallback / legacy dispatch
  return { profile: null, model: null, source: 'legacy', reason: mainFamily === 'unknown' ? 'family_unknown' : 'fallback' };
}
