import { createRequire } from 'node:module';

// Vite 5 не распознаёт прямой импорт нового встроенного SQLite.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');

export const METRICS = {
  energy: 'энергия, единицы базы',
  income_per_tick: 'энергия/тик',
  units_alive: 'объекты',
  structures: 'объекты',
  towers: 'объекты, включая недострой',
  walls: 'объекты',
  base_hp: 'HP, единицы базы',
  general_hp: 'HP, единицы базы',
  general_alive: 'доля 0/1 на отсечке',
  queue_len: 'объекты',
  upgrade_total_level: 'уровни',
  path_to_enemy: 'доля 0/1 на отсечке',
};
export const MATCH_FIELDS =
  'match_id world_seed ai_seed_0 ai_seed_1 profile_0 profile_1 git_sha git_dirty ticks winner end_reason'.split(
    ' ',
  );
const sourceFields = [
  'db',
  'run',
  'sha',
  'profiles',
  'seedStart',
  'matches',
  'ticksPerSecond',
  'capSeconds',
];
const nonempty = (v) => typeof v === 'string' && v.trim().length > 0;
function fields(object, allowed, label) {
  if (!object || typeof object !== 'object' || Array.isArray(object))
    throw new Error(`Invalid ${label}`);
  for (const key of Object.keys(object))
    if (!allowed.includes(key)) throw new Error(`Unknown ${label}.${key}`);
}
function integer(value, minimum, label) {
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`Invalid ${label}`);
}
export function validateConfig(config) {
  fields(config, ['before', 'after', 'cutoffsSeconds'], 'config');
  for (const name of ['before', 'after']) {
    const source = config[name];
    fields(source, sourceFields, name);
    for (const key of ['db', 'run', 'sha'])
      if (!nonempty(source[key])) throw new Error(`Invalid ${name}.${key}`);
    if (
      !Array.isArray(source.profiles) ||
      source.profiles.length !== 2 ||
      !source.profiles.every(nonempty)
    )
      throw new Error(`Invalid ${name}.profiles`);
    for (const key of ['seedStart', 'matches', 'ticksPerSecond', 'capSeconds'])
      integer(source[key], key === 'seedStart' ? 0 : 1, `${name}.${key}`);
    integer(source.seedStart + source.matches - 1, 0, `${name}.seed range`);
    integer(source.capSeconds * source.ticksPerSecond, 1, `${name}.cap ticks`);
  }
  if (JSON.stringify(config.before.profiles) !== JSON.stringify(config.after.profiles))
    throw new Error('Ordered profiles differ');
  if (config.before.ticksPerSecond !== config.after.ticksPerSecond)
    throw new Error('ticksPerSecond differs');
  const cutoffs = config.cutoffsSeconds === undefined ? [300, 600] : config.cutoffsSeconds;
  if (!Array.isArray(cutoffs) || !cutoffs.length || new Set(cutoffs).size !== cutoffs.length)
    throw new Error('Invalid cutoffsSeconds');
  for (const cutoff of cutoffs) {
    integer(cutoff, 1, 'cutoff seconds');
    integer(cutoff * config.before.ticksPerSecond, 1, 'cutoff ticks');
  }
  return { ...config, cutoffsSeconds: [...cutoffs].sort((a, b) => a - b) };
}

export function inspectSource(db, options, label) {
  const columns = {};
  for (const [table, required] of [
    ['match', MATCH_FIELDS],
    ['sample', ['match_id', 'tick', 'player']],
  ]) {
    columns[table] = new Set(
      db
        .prepare(`PRAGMA table_info("${table}")`)
        .all()
        .map((r) => r.name),
    );
    const missing = required.filter((field) => !columns[table].has(field));
    if (missing.length) throw new Error(`${label}: missing schema ${table}: ${missing.join(', ')}`);
  }
  const matches = db
    .prepare(`SELECT ${MATCH_FIELDS.join(', ')} FROM match ORDER BY world_seed`)
    .all();
  if (matches.length !== options.matches)
    throw new Error(`${label}: expected ${options.matches} matches, got ${matches.length}`);
  const seen = new Set();
  const ids = new Set();
  for (const m of matches) {
    const fail = (reason) => {
      throw new Error(`${label}: ${m.match_id}: ${reason}`);
    };
    if (
      !Number.isSafeInteger(m.world_seed) ||
      m.world_seed < options.seedStart ||
      m.world_seed > options.seedStart + options.matches - 1 ||
      seen.has(m.world_seed)
    )
      fail('invalid or duplicate world_seed');
    seen.add(m.world_seed);
    if (!nonempty(m.match_id) || ids.has(m.match_id)) fail('invalid or duplicate match_id');
    ids.add(m.match_id);
    if (![m.ai_seed_0, m.ai_seed_1].every((seed) => Number.isSafeInteger(seed) && seed >= 0))
      fail('invalid AI seed');
    if (m.git_sha !== options.sha || m.git_dirty !== 0) fail('revision mismatch or dirty');
    if (m.profile_0 !== options.profiles[0] || m.profile_1 !== options.profiles[1])
      fail('profile mismatch');
    const cap = options.capSeconds * options.ticksPerSecond;
    if (!Number.isSafeInteger(m.ticks) || m.ticks <= 0 || m.ticks > cap)
      fail('invalid footer ticks');
    if (m.end_reason === 'timeout') {
      if (m.ticks !== cap || m.winner !== null) fail('timeout requires cap ticks and null winner');
    } else if (m.end_reason === 'base-destroyed') {
      if (m.winner !== 0 && m.winner !== 1) fail('base-destroyed requires winner 0 or 1');
    } else fail('missing footer or unknown end_reason');
  }
  return { options, matches, sampleColumns: columns.sample };
}

function readObservation(query, match, player, tick, step, columns) {
  // Только секундное окно точки: многомиллионная история решений не нужна.
  const rows = query.all(
    match.match_id,
    player,
    Math.max(0, tick - step),
    Math.min(tick, match.ticks),
  );
  const last = rows.at(-1);
  const selected = last ? rows.filter((row) => row.tick === last.tick) : [];
  const reason = !last
    ? 'missing-or-stale-sample'
    : selected.length !== 1
      ? 'duplicate-sample'
      : !Number.isSafeInteger(last.tick)
        ? 'invalid-sample-tick'
        : null;
  const metrics = {};
  for (const metric of Object.keys(METRICS)) {
    const why = !columns.has(metric)
      ? 'missing-column'
      : (reason ?? (!Number.isFinite(last[metric]) ? 'invalid-value' : null));
    metrics[metric] = { value: why ? null : last[metric], reason: why };
  }
  return { player, tick: last?.tick ?? null, selectedRows: selected.length, reason, metrics };
}

function aggregate(worlds, metric, side) {
  const pairs = [];
  const excluded = [];
  for (const world of worlds) {
    const players = side === 'both' ? [0, 1] : [side];
    const reasons = [];
    const values = {};
    const ticks = {};
    for (const source of ['before', 'after']) {
      values[source] = [];
      ticks[source] = [];
      for (const player of players) {
        const sample = world[source][player];
        const value = sample.metrics[metric];
        if (value.reason) reasons.push({ source, player, reason: value.reason });
        values[source].push(value.value);
        ticks[source].push(sample.tick);
      }
    }
    if (reasons.length) {
      excluded.push({ world_seed: world.world_seed, reasons });
      continue;
    }
    const a = values.before.reduce((sum, v) => sum + v / players.length, 0);
    const b = values.after.reduce((sum, v) => sum + v / players.length, 0);
    pairs.push({
      world_seed: world.world_seed,
      matchIds: world.matchIds,
      ticks,
      values,
      before: a,
      after: b,
      delta: b - a,
    });
  }
  const mean = (key) =>
    pairs.length ? pairs.reduce((sum, pair) => sum + pair[key] / pairs.length, 0) : null;
  return {
    metric,
    unit: METRICS[metric],
    side,
    n: pairs.length,
    meanA: mean('before'),
    meanB: mean('after'),
    meanDelta: mean('delta'),
    reason: pairs.length
      ? null
      : worlds.length
        ? 'нет годных наблюдений'
        : 'нет общих доживших миров',
    pairs,
    excluded,
  };
}

export function analyzeDatabases(beforeDb, afterDb, rawConfig) {
  const config = validateConfig(rawConfig);
  const sources = {};
  const queries = {};
  for (const [name, db] of [
    ['before', beforeDb],
    ['after', afterDb],
  ]) {
    sources[name] = inspectSource(db, config[name], name);
    const available = Object.keys(METRICS).filter((key) => sources[name].sampleColumns.has(key));
    queries[name] = db.prepare(
      `SELECT tick${available.map((key) => `, ${key}`).join('')} FROM sample WHERE match_id = ? AND player = ? AND tick >= ? AND tick <= ? ORDER BY tick`,
    );
  }
  const indexes = Object.fromEntries(
    Object.entries(sources).map(([name, source]) => [
      name,
      new Map(source.matches.map((m) => [m.world_seed, m])),
    ]),
  );
  const seeds = [...new Set([...indexes.before.keys(), ...indexes.after.keys()])].sort(
    (a, b) => a - b,
  );
  const inventory = seeds.map((world_seed) => {
    const before = indexes.before.get(world_seed) ?? null;
    const after = indexes.after.get(world_seed) ?? null;
    const reason = !before
      ? 'after-only'
      : !after
        ? 'before-only'
        : before.ai_seed_0 !== after.ai_seed_0 || before.ai_seed_1 !== after.ai_seed_1
          ? 'ai-seed-mismatch'
          : null;
    return { world_seed, before, after, reason };
  });
  const cutoffs = config.cutoffsSeconds.map((seconds) => {
    const tick = seconds * config.before.ticksPerSecond;
    const worlds = [];
    const excluded = [];
    for (const pair of inventory) {
      const reasons = pair.reason ? [pair.reason] : [];
      for (const name of ['before', 'after'])
        if (pair[name] && pair[name].ticks < tick) reasons.push(`${name}-ended-before-cutoff`);
      if (reasons.length) {
        excluded.push({ world_seed: pair.world_seed, reasons });
        continue;
      }
      const world = {
        world_seed: pair.world_seed,
        matchIds: { before: pair.before.match_id, after: pair.after.match_id },
      };
      for (const name of ['before', 'after'])
        world[name] = [0, 1].map((player) =>
          readObservation(
            queries[name],
            pair[name],
            player,
            tick,
            config.before.ticksPerSecond,
            sources[name].sampleColumns,
          ),
        );
      worlds.push(world);
    }
    return {
      seconds,
      tick,
      survivorBefore: sources.before.matches.filter((m) => m.ticks >= tick).length,
      survivorAfter: sources.after.matches.filter((m) => m.ticks >= tick).length,
      commonSurvivors: worlds.length,
      excluded,
      worlds,
      metrics: Object.keys(METRICS).flatMap((metric) =>
        [0, 1, 'both'].map((side) => aggregate(worlds, metric, side)),
      ),
    };
  });
  return {
    sources: Object.fromEntries(
      Object.entries(sources).map(([name, source]) => [
        name,
        {
          ...source.options,
          externalParameters: ['run', 'ticksPerSecond', 'capSeconds'],
          verifiedParameters: [
            'sha',
            'profiles',
            'seedStart',
            'matches',
            'git_dirty',
            'ai_seed_0',
            'ai_seed_1',
            'footer',
          ],
        },
      ]),
    ),
    inventory,
    cutoffs,
  };
}

export function analyzeFiles(config) {
  validateConfig(config);
  const before = new DatabaseSync(config.before.db, { readOnly: true });
  try {
    const after = new DatabaseSync(config.after.db, { readOnly: true });
    try {
      return analyzeDatabases(before, after, config);
    } finally {
      after.close();
    }
  } finally {
    before.close();
  }
}
