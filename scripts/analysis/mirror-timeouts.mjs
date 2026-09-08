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
  attempt: 'match_id tick player spending result note',
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
    return analyzeDatabase(db, options);
  } finally {
    db.close();
  }
}

export function summary(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  const quantile = (p) => {
    if (!sorted.length) return null;
    const index = (sorted.length - 1) * p;
    const lo = Math.floor(index);
    return sorted[lo] + (sorted[Math.ceil(index)] - sorted[lo]) * (index - lo);
  };
  return {
    n: sorted.length,
    mean: sorted.length ? sorted.reduce((a, b) => a + b, 0) / sorted.length : null,
    q1: quantile(0.25),
    median: quantile(0.5),
    q3: quantile(0.75),
  };
}

const metric = (value, observations = 0, reason = null) => ({
  value: Number.isFinite(value) ? value : null,
  observations,
  reason: Number.isFinite(value) ? null : (reason ?? 'missing observations'),
});
const fraction = (numerator, denominator, reason = null) => ({
  ...metric(
    reason || !denominator ? null : numerator / denominator,
    denominator,
    reason ?? 'zero denominator',
  ),
  numerator,
  denominator,
});
const STATE_FIELDS =
  'base_hp units_alive structures towers walls energy income_per_tick queue_len upgrade_total_level general_alive general_hp general_cell path_to_enemy'.split(
    ' ',
  );

function at(samples, tick, step) {
  const candidates = samples.filter((s) => s.tick <= tick && tick - s.tick <= step);
  const last = candidates.at(-1);
  return last && candidates.filter((s) => s.tick === last.tick).length === 1 ? last : null;
}

// Полная сетка нужна именно для долей времени; разность концов не требует промежуточных снимков.
function fullGrid(samples, start, end, step) {
  return (
    start !== null &&
    end >= start &&
    (end - start) % step === 0 &&
    samples.length === (end - start) / step + 1 &&
    samples.every((s, i) => s.tick === start + i * step)
  );
}

export function analyzeSide(data, match, player, window, step) {
  const samples = data.sample.filter((s) => s.tick <= match.ticks);
  const first = samples[0] ?? null;
  const lifetime = window.kind === 'lifetime';
  const point = window.kind === 'point';
  const start = lifetime || window.start === null ? (first?.tick ?? null) : window.start;
  const end = lifetime ? match.ticks : window.end;
  const endedEarly = !lifetime && match.ticks < end;
  const startSample =
    start === null || (!lifetime && window.start === null && start > step)
      ? null
      : at(samples, start, step);
  const endSample = endedEarly ? null : at(samples, end, step);
  const inRange = (r) => r.tick > (lifetime ? -1 : (start ?? 0)) && r.tick <= end;
  const observed = samples.filter(inRange);
  const gridSamples = samples.filter((s) => start !== null && s.tick >= start && s.tick <= end);
  const grid =
    !endedEarly &&
    fullGrid(gridSamples, start, lifetime ? (endSample?.tick ?? end) : end, step) &&
    Boolean(endSample) &&
    (lifetime || window.start !== null || (first && first.tick <= step));
  const reason = endedEarly
    ? 'ended before cutoff'
    : !grid
      ? 'missing, duplicate or irregular second grid'
      : null;
  const metrics = {};
  for (const field of STATE_FIELDS) {
    metrics[`${field}_end`] = metric(
      endSample?.[field],
      endSample ? 1 : 0,
      endedEarly ? 'ended before cutoff' : null,
    );
    if (!point) {
      metrics[`${field}_start`] = metric(startSample?.[field], startSample ? 1 : 0);
      metrics[`${field}_net`] = metric(
        startSample && endSample ? endSample[field] - startSample[field] : null,
        startSample && endSample ? 2 : 0,
      );
    }
  }
  metrics.base_hp_from_first = metric(
    first && endSample ? endSample.base_hp - first.base_hp : null,
    first && endSample ? 2 : 0,
  );
  metrics.base_hp_relative_first = fraction(
    first && endSample ? endSample.base_hp - first.base_hp : 0,
    first?.base_hp ?? 0,
    !endSample ? 'missing endpoint' : null,
  );
  if (point)
    return {
      player,
      start,
      end,
      first: first ? { tick: first.tick, base_hp: first.base_hp } : null,
      endedEarly,
      metrics,
    };
  for (const field of ['towers', 'walls', 'structures', 'units_alive']) {
    const peak = gridSamples.length ? Math.max(...gridSamples.map((s) => s[field])) : null;
    metrics[`${field}_peak`] = metric(peak, gridSamples.length);
    metrics[`${field}_below_peak`] = metric(
      peak !== null && endSample ? peak - endSample[field] : null,
      gridSamples.length,
    );
  }
  metrics.general_dead = fraction(
    observed.filter((s) => s.general_alive === 0).length,
    observed.length,
    reason,
  );
  metrics.no_path = fraction(
    observed.filter((s) => s.path_to_enemy === 0).length,
    observed.length,
    reason,
  );
  const decreases = gridSamples
    .slice(1)
    .filter((s, i) => s.tick - gridSamples[i].tick === step && s.base_hp < gridSamples[i].base_hp);
  metrics.hp_decrease_steps = metric(
    grid ? decreases.length : null,
    Math.max(0, gridSamples.length - 1),
    reason,
  );
  const decisions = data.decision.filter(inRange);
  const attempts = data.attempt.filter(inRange);
  const far = decisions.filter(
    (d) =>
      d.approach_shortest > 0 &&
      d.general_from_home >= 0 &&
      d.general_from_home / d.approach_shortest > 0.5,
  );
  metrics.far_unescorted = fraction(far.filter((d) => d.nearby_units === 0).length, far.length);
  metrics.far_unescorted_with_army = fraction(
    far.filter((d) => d.nearby_units === 0 && d.live_units > 0).length,
    far.length,
  );
  const bought = new Set(attempts.filter((a) => a.result === 'bought').map((a) => a.tick));
  const saving = new Set(
    attempts
      .filter((a) => a.result === 'wait' || a.note === 'saving-for-better')
      .map((a) => a.tick),
  );
  metrics.bought_decisions = fraction(
    decisions.filter((d) => bought.has(d.tick)).length,
    decisions.length,
  );
  metrics.saving_decisions = fraction(
    decisions.filter((d) => saving.has(d.tick)).length,
    decisions.length,
  );
  metrics.impatient_decisions = fraction(
    decisions.filter((d) => d.impatient === 1).length,
    decisions.length,
  );
  metrics.train_accepted = metric(
    data.command.filter((c) => inRange(c) && c.accepted === 1 && c.kind === 2).length,
    data.command.filter(inRange).length,
  );
  const production = {};
  for (const attempt of attempts.filter((a) => a.spending === 'train')) {
    const key = `${attempt.result}: ${attempt.note ?? 'none'}`;
    production[key] = (production[key] ?? 0) + 1;
  }
  if (endedEarly)
    for (const name of Object.keys(metrics))
      metrics[name] = { ...metrics[name], value: null, reason: 'ended before cutoff' };
  return {
    player,
    start,
    end,
    first: first ? { tick: first.tick, base_hp: first.base_hp } : null,
    endedEarly,
    gridComplete: grid,
    sampleCount: observed.length,
    decisionCount: decisions.length,
    productionAttempts: production,
    metrics,
    lastHpDecreaseTick: grid ? (decreases.at(-1)?.tick ?? null) : null,
    noDecreaseTailTicks: grid ? endSample.tick - (decreases.at(-1)?.tick ?? start) : null,
  };
}

export function aggregateRows(rows) {
  const names = [...new Set(rows.flatMap((r) => r.sides.flatMap((s) => Object.keys(s.metrics))))];
  const metrics = {};
  for (const name of names) {
    const pairs = rows.map((r) => r.sides.map((s) => s.metrics[name]));
    const valid = pairs.filter(
      (pair) => pair.length === 2 && pair.every((m) => Number.isFinite(m?.value)),
    );
    const sides = pairs.flat().filter((m) => Number.isFinite(m?.value));
    const denominator = sides.reduce((sum, m) => sum + (m.denominator ?? 0), 0);
    metrics[name] = {
      ...summary(valid.map((pair) => (pair[0].value + pair[1].value) / 2)),
      sides: sides.length,
      excludedMatches: rows.length - valid.length,
      missingMatches: rows.filter((r) => !r.sides.every((s) => s.endedEarly)).length - valid.length,
      observations: sides.reduce((sum, m) => sum + m.observations, 0),
      pooled: sides.some((m) => 'denominator' in m)
        ? fraction(
            sides.reduce((sum, m) => sum + m.numerator, 0),
            denominator,
          )
        : null,
    };
  }
  return {
    matches: rows.length,
    endedEarly: rows.filter((r) => r.sides.every((s) => s.endedEarly)).length,
    metrics,
  };
}

export function analyzeDatabase(db, options, extraWindows = []) {
  const result = inspectSource(db, options);
  const step = options.ticksPerSecond;
  const windows = [{ name: 'lifetime', kind: 'lifetime' }];
  for (const seconds of [300, 600, 900, 1200]) {
    windows.push({ name: `at-${seconds}s`, kind: 'point', end: seconds * step });
    windows.push({
      name: `${seconds - 300}-${seconds}s`,
      kind: 'interval',
      start: seconds === 300 ? null : (seconds - 300) * step,
      end: seconds * step,
    });
  }
  windows.push(...extraWindows);
  const rows = [];
  for (const match of result.matches) {
    const data = [0, 1].map((player) =>
      Object.fromEntries(
        ['sample', 'decision', 'attempt', 'command'].map((table) => [
          table,
          db
            .prepare(`SELECT * FROM "${table}" WHERE match_id=? AND player=? ORDER BY tick, rowid`)
            .all(match.match_id, player),
        ]),
      ),
    );
    for (const window of windows)
      rows.push({
        match_id: match.match_id,
        world_seed: match.world_seed,
        end_reason: match.end_reason,
        window: window.name,
        sides: data.map((side, player) => analyzeSide(side, match, player, window, step)),
      });
  }
  const cohorts = Object.fromEntries(
    Object.keys(result.groups).map((reason) => [
      reason,
      {
        durationSeconds: summary(
          result.matches.filter((m) => m.end_reason === reason).map((m) => m.seconds),
        ),
        censored: reason === 'timeout',
        windows: Object.fromEntries(
          windows.map((w) => [
            w.name,
            aggregateRows(rows.filter((r) => r.end_reason === reason && r.window === w.name)),
          ]),
        ),
      },
    ]),
  );
  return { ...result, windows, rows, cohorts };
}
