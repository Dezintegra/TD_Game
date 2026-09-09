import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';
import { CommandKind, StructureKind } from '@td/shared';
import type { CombatObservation } from '@td/sim';
import type { MatchHeader } from './records.js';
import { collectAssaultEpisodes } from './assault-episodes.js';

interface DiagnosticMatch {
  header: MatchHeader;
  ticks: number;
  winner: number | null;
}
interface SqliteModule {
  DatabaseSync: new (path: string, options: { readOnly: boolean }) => DatabaseSync;
}
const readOnly = (path: string): DatabaseSync => {
  const { DatabaseSync: Database } = createRequire(import.meta.url)('node:sqlite') as SqliteModule;
  return new Database(path, { readOnly: true });
};
const mean = (values: readonly number[]): number | null =>
  values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
const distribution = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (fraction: number) => {
    if (!sorted.length) return null;
    const index = (sorted.length - 1) * fraction;
    const low = Math.floor(index),
      high = Math.ceil(index);
    return sorted[low]! + (sorted[high]! - sorted[low]!) * (index - low);
  };
  return { n: values.length, mean: mean(values), q1: at(0.25), median: at(0.5), q3: at(0.75) };
};
const matches = (db: DatabaseSync, range: number): Map<number, DiagnosticMatch> => {
  if (!db.prepare("select name from sqlite_master where name='assault_metadata'").get())
    throw new Error('диагностика отсутствует');
  const result = new Map<number, DiagnosticMatch>();
  for (const row of db
    .prepare(
      'select m.*, a.payload from match m left join assault_metadata a using(match_id) order by world_seed',
    )
    .all()) {
    if (typeof row.payload !== 'string') throw new Error('missing diagnostic metadata');
    const h = JSON.parse(row.payload) as MatchHeader;
    if (
      h.traceVersion !== 1 ||
      typeof h.traceEnabled !== 'boolean' ||
      !h.gitSha ||
      h.gitDirty ||
      !h.tickRate ||
      !h.tickCap ||
      !h.tuning ||
      h.tuning.assaultRange !== range ||
      h.effectiveAssaultRange !== range * 4000 ||
      row.ticks === null
    )
      throw new Error('incompatible diagnostic metadata');
    for (const key of [
      'income',
      'speed',
      'towerHealth',
      'baseHealth',
      'unitRadius',
      'map',
    ] as const)
      if (!Number.isFinite(h.tuning[key]) || h.tuning[key] <= 0) throw new Error('missing tuning');
    if (result.has(h.worldSeed)) throw new Error('duplicate world seed');
    result.set(h.worldSeed, {
      header: h,
      ticks: Number(row.ticks),
      winner: row.winner === null ? null : Number(row.winner),
    });
  }
  if (!result.size) throw new Error('no diagnostic matches');
  return result;
};
const compatible = (a: MatchHeader, b: MatchHeader) => {
  const stable = (h: MatchHeader) => [
    h.gitSha,
    h.worldSeed,
    h.aiSeeds,
    h.profiles,
    h.tickRate,
    h.tickCap,
    ...(['income', 'speed', 'towerHealth', 'baseHealth', 'unitRadius', 'map'] as const).map(
      (k) => h.tuning?.[k],
    ),
  ];
  if (JSON.stringify(stable(a)) !== JSON.stringify(stable(b)))
    throw new Error('incompatible paired inputs');
};
const traceSummary = (db: DatabaseSync, match: DiagnosticMatch) => {
  if (!match.header.traceEnabled) return null;
  const events = db
    .prepare(
      "select payload from assault_event where match_id=? and type!='assault-tower' order by tick, sequence",
    )
    .all(match.header.matchId)
    .map((row) => JSON.parse(String(row.payload)) as CombatObservation);
  const episodes = collectAssaultEpisodes(events, match.ticks, match.winner);
  const motions = events.filter((e) => e.type === 'assault-motion');
  const shots = events.filter((e) => e.type === 'assault-shot');
  const reasons: Record<string, number> = {};
  for (const e of motions) reasons[e.reason] = (reasons[e.reason] ?? 0) + 1;
  const outcomes: Record<string, number> = {};
  for (const e of episodes.contacts) outcomes[e.outcome] = (outcomes[e.outcome] ?? 0) + 1;
  const towerIds = new Set(
    events.flatMap((e) =>
      e.type === 'assault-end-tick'
        ? e.participants.filter((p) => p.kind === 'structure').map((p) => p.id)
        : [],
    ),
  );
  const towerShots = shots.filter(
    (e) => e.target.kind === 'structure' && towerIds.has(e.target.id),
  ).length;
  const finished = episodes.sieges.filter((e) => e.demolitionTicks !== null);
  return {
    motionCount: motions.length,
    stopReasonShares: Object.fromEntries(
      Object.entries(reasons).map(([k, v]) => [k, motions.length ? v / motions.length : null]),
    ),
    shotCount: shots.length,
    towerHitShare: shots.length ? towerShots / shots.length : null,
    otherHitShare: shots.length ? (shots.length - towerShots) / shots.length : null,
    contactCount: episodes.contacts.length,
    siegeCount: episodes.sieges.length,
    completedCount: finished.length,
    demolitionMean: mean(finished.map((e) => e.demolitionTicks!)),
    firstHitDelayMean: mean(
      episodes.contacts
        .filter((e) => e.firstTowerHitTick !== null)
        .map((e) => e.firstTowerHitTick! - e.startTick),
    ),
    remainingHpMean: mean(episodes.contacts.map((e) => e.towerHpAtEndOfTick)),
    outcomes,
    nonsiegeDestructionShare: episodes.sieges.length
      ? (episodes.sieges.length - finished.length) / episodes.sieges.length
      : null,
  };
};
const windowSummary = (db: DatabaseSync, match: DiagnosticMatch, from: number, to: number) =>
  [0, 1].map((player) => {
    const args = [match.header.matchId, player, from, to];
    const commands = db
      .prepare(
        'select kind,arg1 from command where match_id=? and player=? and tick>? and tick<=? and accepted=1',
      )
      .all(...args);
    const decisions = db
      .prepare(
        'select escorting,nearby_units from decision where match_id=? and player=? and tick>=? and tick<?',
      )
      .all(...args);
    const spending = db
      .prepare(
        'select spending,result,count(*) as n,sum(price) as quoted_price from attempt where match_id=? and player=? and tick>=? and tick<? group by spending,result order by spending,result',
      )
      .all(...args);
    return {
      player,
      fromTick: from,
      toTick: to,
      builds: commands.filter((c) => c.kind === CommandKind.Build).length,
      walls: commands.filter((c) => c.kind === CommandKind.Build && c.arg1 === StructureKind.Wall)
        .length,
      acceptedNukes: commands.filter((c) => c.kind === CommandKind.LaunchNuke).length,
      escortingShare: mean(decisions.map((d) => Number(d.escorting))),
      nearbyMean: mean(decisions.map((d) => Number(d.nearby_units))),
      spending,
    };
  });

export const compareAssaultDatabases = (beforePath: string, afterPath: string) => {
  const before = readOnly(beforePath);
  const after = readOnly(afterPath);
  try {
    const a = matches(before, 0.5),
      b = matches(after, 1);
    const common = [...a.keys()].filter((seed) => b.has(seed));
    if (!common.length) throw new Error('no paired worlds');
    const excluded = [...new Set([...a.keys(), ...b.keys()])].filter(
      (seed) => !a.has(seed) || !b.has(seed),
    );
    const worlds = common.map((seed) => {
      const left = a.get(seed)!,
        right = b.get(seed)!;
      compatible(left.header, right.header);
      const traced = left.header.traceEnabled === true && right.header.traceEnabled === true;
      const rate = left.header.tickRate!;
      const windows = [
        [0, 300 * rate],
        [300 * rate, 600 * rate],
      ].map(([from, to]) => ({
        from: from!,
        to: to!,
        included: left.ticks >= to! && right.ticks >= to!,
        before:
          left.ticks >= to! && right.ticks >= to! ? windowSummary(before, left, from!, to!) : null,
        after:
          left.ticks >= to! && right.ticks >= to! ? windowSummary(after, right, from!, to!) : null,
      }));
      const cutoffs = [300, 600].map((seconds) => {
        const tick = seconds * rate;
        if (left.ticks < tick || right.ticks < tick)
          return { seconds, included: false, reason: 'early-end', before: null, after: null };
        const get = (db: DatabaseSync, m: DiagnosticMatch) =>
          db
            .prepare(
              'select s.player,s.units_alive,s.towers,a.ready,a.under_construction from sample s join assault_sample a using(match_id,tick,player) where s.match_id=? and s.tick=? order by s.player',
            )
            .all(m.header.matchId, tick);
        const l = get(before, left),
          r = get(after, right);
        if (l.length !== 2 || r.length !== 2) throw new Error('missing exact cutoff');
        return { seconds, included: true, reason: null, before: l, after: r };
      });
      const leftTrace = traceSummary(before, left),
        rightTrace = traceSummary(after, right);
      return {
        seed,
        traced,
        durationDeltaSeconds: (right.ticks - left.ticks) / rate,
        before: {
          header: left.header,
          ticks: left.ticks,
          trace: leftTrace,
          totals: windowSummary(before, left, 0, left.ticks),
        },
        after: {
          header: right.header,
          ticks: right.ticks,
          trace: rightTrace,
          totals: windowSummary(after, right, 0, right.ticks),
        },
        windows,
        cutoffs,
      };
    });
    const traced = worlds.filter((w) => w.traced);
    const deltas = (
      key: 'demolitionMean' | 'towerHitShare' | 'firstHitDelayMean' | 'remainingHpMean',
    ) =>
      distribution(
        traced.flatMap((w) => {
          const l = w.before.trace?.[key],
            r = w.after.trace?.[key];
          return typeof l === 'number' && typeof r === 'number' ? [r - l] : [];
        }),
      );
    return {
      version: 1,
      sources: { before: beforePath, after: afterPath },
      pairedWorlds: worlds.length,
      tracedWorlds: traced.length,
      excludedSeeds: excluded,
      durationDeltaSeconds: distribution(worlds.map((w) => w.durationDeltaSeconds)),
      traceDeltas: {
        demolitionTicks: deltas('demolitionMean'),
        towerHitShare: deltas('towerHitShare'),
        firstHitDelayTicks: deltas('firstHitDelayMean'),
        remainingHp: deltas('remainingHpMean'),
      },
      cutoffCounts: [300, 600].map((seconds) => ({
        seconds,
        n: worlds.filter((w) => w.cutoffs.some((c) => c.seconds === seconds && c.included)).length,
      })),
      limitations: [
        'Трассированное подмножество не представляет автоматически всю пачку.',
        'Остановка и сопровождение ИИ — разные каналы; корреляция не доказывает причину исторических +98 секунд.',
      ],
      worlds,
    };
  } finally {
    before.close();
    after.close();
  }
};

export const assaultReportMarkdown = (report: ReturnType<typeof compareAssaultDatabases>): string =>
  `# Диагностика дальности Assault\n\nПарных миров: ${report.pairedWorlds}; с парной трассой: ${report.tracedWorlds}.\n\n` +
  `Медиана изменения длительности: ${report.durationDeltaSeconds.median} с.\n\n` +
  `Подробные парные факты и размеры выборок:\n\n\`\`\`json\n${JSON.stringify(report, null, 2)}\n\`\`\`\n`;
