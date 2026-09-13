import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSchedulingStore } from './scheduling-store.mjs';
import {
  emptyScheduling,
  recordLaunch,
  reconcileLaunches,
  workLane,
  workKindProblem,
} from './scheduling.mjs';
import { parseCard, metaOf, joinDescription } from './card.mjs';

const at = '2026-09-12T20:00:00Z';
const game = {
  id: '0011-game',
  type: 'feature',
  categories: ['ux'],
  scheduling: { lane: 'game', selectedAt: at, reason: 'игровой ход' },
};

describe('направление по результату', () => {
  it('инструменты и прогоны не занимают игровую квоту', () => {
    expect(workLane(game)).toBe('game');
    expect(workLane({ ...game, type: 'run' })).toBe('service');
    expect(workLane({ ...game, area: 'pipeline' })).toBe('service');
    expect(workLane({ ...game, categories: ['ux', 'infrastructure'] })).toBe('service');
    expect(
      workLane({ ...game, categories: [], workKind: 'game', workReason: 'Читаемая миникарта' }),
    ).toBe('game');
    expect(workKindProblem({ ...game, workKind: 'game' })).toContain('обоснование');
  });
  it('метаданные переживают запись и чтение Trello', () => {
    const source = { ...game, workKind: 'game', workReason: 'Статистика для игрока' };
    const parsed = parseCard(
      {
        id: '6a981dc012e0a4bfb4d3c087',
        name: 'Статистика',
        desc: joinDescription('Описание', metaOf(source)),
        idLabels: ['f'],
        idList: 'n',
        pos: 1,
      },
      { stateByList: new Map([['n', 'new']]), labelKeyById: new Map([['f', 'feature']]) },
    );
    expect(parsed.task).toMatchObject({
      workKind: 'game',
      workReason: source.workReason,
      scheduling: game.scheduling,
    });
  });
});

describe('учёт фактического первого запуска', () => {
  it('после остановки между порождением и записью восстанавливает ход и пробу из дескриптора', () => {
    const source = {
      ...game,
      status: 'design',
      pipelineIncident: {
        id: 'incident',
        openedAt: at,
        check: { stage: 'design' },
        verifiedAt: null,
      },
    };
    const initial = emptyScheduling();
    expect(reconcileLaunches(initial, [source], () => null)).toBe(initial);
    expect(reconcileLaunches(initial, [source], () => '2026-09-11T20:00:00Z')).toBe(initial);
    const restored = reconcileLaunches(initial, [source], () => at);
    expect(restored).toMatchObject({
      next: 'service',
      admissions: { [game.id]: { lane: 'game', at } },
      probes: { incident: at },
    });
    expect(reconcileLaunches(restored, [source], () => at)).toBe(restored);
  });
  it('старый этап и продолжение не расходуют ход новых карточек', () => {
    const initial = emptyScheduling();
    expect(recordLaunch(initial, { ...game, scheduling: undefined }, at).next).toBe('game');
    const after = recordLaunch(initial, game, at);
    expect(after.next).toBe('service');
    const service = { id: '0012-service', type: 'feature', scheduling: { lane: 'service' } };
    const afterService = recordLaunch(after, service, at);
    expect(recordLaunch(afterService, game, at).next).toBe('game');
    expect(Object.keys(afterService.admissions)).toHaveLength(2);
    expect(initial.admissions).toEqual({});
  });
  it('отказ без записи и новый экземпляр сохраняют игровой ход; повторы идемпотентны', () => {
    const root = mkdtempSync(join(tmpdir(), 'td-scheduling-'));
    const config = { paths: { local: '.' } };
    try {
      const first = createSchedulingStore(root, config);
      expect(first.read().next).toBe('game');
      expect(createSchedulingStore(root, config).read().next).toBe('game');
      first.launched(game, at);
      const restarted = createSchedulingStore(root, config);
      expect(restarted.read().next).toBe('service');
      restarted.launched(game, at);
      expect(Object.keys(restarted.read().admissions)).toHaveLength(1);
      restarted.recovered('incident-1');
      expect(restarted.read().next).toBe('game');
      restarted.launched({ ...game, id: '0013-game' }, at);
      restarted.recovered('incident-1');
      expect(restarted.read().next).toBe('service');
      writeFileSync(join(root, 'scheduling.json'), '{broken');
      expect(restarted.read().error).toContain('scheduling.json');
      expect(() => restarted.launched(game, at)).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
