import { createRequire } from 'node:module';

// Vite 5 не распознаёт новый встроенный модуль SQLite при прямом импорте.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');

export const REQUIRED = {
  match:
    'match_id world_seed ai_seed_0 ai_seed_1 profile_0 profile_1 git_sha git_dirty ticks winner end_reason',
  sample:
    'match_id tick player energy income_per_tick units_alive structures towers walls base_hp general_cell general_hp general_alive queue_len upgrade_total_level path_to_enemy',
  decision:
    'match_id tick player impatient live_units nearby_units general_from_home approach_shortest',
  attempt: 'match_id tick player spending result',
  command: 'match_id tick player kind accepted',
};

export function validateOptions(options) {
  for (const key of ['run', 'sha', 'profile']) {
    if (typeof options[key] !== 'string' || !options[key].trim()) throw new Error(`Missing ${key}`);
  }
  for (const key of ['seedStart', 'matches', 'ticksPerSecond', 'capSeconds']) {
    if (!Number.isSafeInteger(options[key]) || options[key] < (key === 'seedStart' ? 0 : 1)) {
      throw new Error(`Invalid ${key}`);
    }
  }
}

export function inspectSource(db, options) {
  validateOptions(options);
  for (const [table, fields] of Object.entries(REQUIRED)) {
    const columns = new Set(
      db
        .prepare(`PRAGMA table_info("${table}")`)
        .all()
        .map((r) => r.name),
    );
    const missing = fields.split(' ').filter((field) => !columns.has(field));
    if (missing.length) throw new Error(`Missing schema ${table}: ${missing.join(', ')}`);
  }
  const matches = db.prepare('SELECT * FROM match ORDER BY world_seed, match_id').all();
  const errors = [];
  if (matches.length !== options.matches)
    errors.push(`Expected ${options.matches} matches, got ${matches.length}`);
  const cap = options.ticksPerSecond * options.capSeconds;
  for (let seed = options.seedStart; seed < options.seedStart + options.matches; seed++) {
    if (matches.filter((m) => m.world_seed === seed).length !== 1)
      errors.push(`Expected one world ${seed}`);
  }
  for (const m of matches) {
    const fail = (reason) => errors.push(`${m.match_id}: ${reason}`);
    if (m.git_sha !== options.sha || m.git_dirty !== 0) fail('revision mismatch or dirty');
    if (m.profile_0 !== options.profile || m.profile_1 !== options.profile)
      fail('profile mismatch');
    if (!Number.isSafeInteger(m.ticks) || m.ticks <= 0 || m.ticks > cap)
      fail('invalid footer ticks');
    if (m.end_reason === 'timeout') {
      if (m.ticks !== cap || m.winner !== null) fail('timeout requires cap ticks and null winner');
    } else if (m.end_reason === 'base-destroyed') {
      if (m.winner !== 0 && m.winner !== 1) fail('base-destroyed requires winner 0 or 1');
    } else fail('missing footer or unknown end_reason');
  }
  if (errors.length) throw new Error(errors.join('\n'));
  const groups = Object.fromEntries(
    ['timeout', 'base-destroyed'].map((reason) => [
      reason,
      matches.filter((m) => m.end_reason === reason).map((m) => m.match_id),
    ]),
  );
  return {
    source: {
      ...options,
      externalParameters: ['run', 'ticksPerSecond', 'capSeconds'],
      verifiedParameters: ['sha', 'profile', 'seedStart', 'matches'],
    },
    matches: matches.map((m) => ({
      ...m,
      seconds: m.ticks / options.ticksPerSecond,
      censored: m.end_reason === 'timeout',
    })),
    groups,
    comparisonAvailable: Object.values(groups).every((g) => g.length > 0),
    timeoutFraction: { numerator: groups.timeout.length, denominator: matches.length },
  };
}

export function analyzeFile(path, options) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return inspectSource(db, options);
  } finally {
    db.close();
  }
}
