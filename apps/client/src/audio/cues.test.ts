import { describe, expect, it } from 'vitest';
import {
  BLAST_LIFETIME_TICKS,
  BlastKind,
  CommandKind,
  MAP_HEIGHT_CELLS,
  MAP_WIDTH_CELLS,
  StructureKind,
  UnitType,
  asPlayerId,
  asTickNumber,
} from '@td/shared';
import type { Command, PlayerId } from '@td/shared';
import { createWorld, step } from '@td/sim';
import type { WorldState } from '@td/sim';
import { createCueFeed, cueLifetimeTicks } from './cues.js';
import type { Cue } from './cues.js';
import { SOUNDS, Sound } from './sounds.js';

/**
 * Проверка на настоящей симуляции, а не на выдуманных снимках мира.
 *
 * Выдуманный снимок проверяет только то, что мы правильно поняли типы.
 * Ошибки, которые здесь ловятся, другие: не то поле, не тот хеш,
 * постройка не опознана стрелком, повтор после отката. Все они видны
 * лишь тогда, когда мир настоящий — со своими записями, своими сроками
 * и своим переигрыванием.
 */

const PLAYER_ONE = asPlayerId(0);
const PLAYER_TWO = asPlayerId(1);

const train = (player: PlayerId, tick: number, unitType: UnitType): Command => ({
  kind: CommandKind.TrainUnit,
  player,
  tick: asTickNumber(tick),
  unitType,
});

const target = (player: PlayerId, tick: number, cell: number): Command => ({
  kind: CommandKind.SetTarget,
  player,
  tick: asTickNumber(tick),
  cell,
});

/**
 * Матч, в котором стороны действительно встречаются.
 *
 * Обе заказывают войска и назначают целью чужую базу; дальше войска
 * сами доходят до встречи и начинают стрелять и гибнуть.
 */
const playMatch = (ticks: number, onTick: (world: WorldState) => void, seed = 4242): WorldState => {
  let world = createWorld(seed);

  const enemyBase = (player: PlayerId): number => world.map.baseCells[player === 0 ? 1 : 0] ?? 0;

  const commands: Command[] = [
    target(PLAYER_ONE, 1, enemyBase(PLAYER_ONE)),
    target(PLAYER_TWO, 1, enemyBase(PLAYER_TWO)),
  ];

  for (let order = 0; order < 8; order += 1) {
    commands.push(train(PLAYER_ONE, 2 + order, UnitType.Assault));
    commands.push(train(PLAYER_TWO, 2 + order, UnitType.Assault));
  }

  for (let tick = 0; tick < ticks; tick += 1) {
    const due = commands.filter((command) => command.tick === world.tick);
    world = step(world, due);
    onTick(world);
  }

  return world;
};

describe('вывод событий из мира', () => {
  it('на пустом мире ничего не звучит', () => {
    const feed = createCueFeed();
    const world = createWorld(1);

    // Первый кадр молчит всегда, второй — потому что событий нет.
    expect(feed.accept(world, true)).toEqual([]);
    expect(feed.accept(world, false)).toEqual([]);
  });

  it('за живой матч звучат и выстрелы, и гибель', () => {
    const feed = createCueFeed();
    const heard = new Map<Sound, number>();

    let first = true;
    playMatch(900, (world) => {
      for (const cue of feed.accept(world, first)) {
        heard.set(cue.sound, (heard.get(cue.sound) ?? 0) + 1);
      }
      first = false;
    });

    // Ровно то, ради чего всё затевалось: бой слышен.
    expect(heard.get(Sound.BoltUnit) ?? 0).toBeGreaterThan(20);
    expect(heard.get(Sound.BlastUnit) ?? 0).toBeGreaterThan(0);
  });

  it('каждое событие звучит ровно один раз, сколько бы кадров его ни видели', () => {
    // Главная опасность всего модуля. Клиент рисует предсказанный мир
    // по нескольку кадров на тик, и без защиты один выстрел прозвучал бы
    // столько раз, сколько его успели показать.
    const feed = createCueFeed();
    const keys = new Set<number>();
    let duplicates = 0;
    let total = 0;

    let first = true;
    // Девятьсот тиков — полминуты матча. Раньше войска попросту
    // не встречаются: им надо пересечь половину карты.
    playMatch(900, (world) => {
      // Каждый тик отрисовывается ЧЕТЫРЕЖДЫ — так и бывает при шестидесяти
      // кадрах на тридцати тиках, да ещё и с пересборкой предсказания.
      for (let frame = 0; frame < 4; frame += 1) {
        for (const cue of feed.accept(world, first)) {
          total += 1;
          if (keys.has(cue.key)) duplicates += 1;
          keys.add(cue.key);
        }
        first = false;
      }
    });

    expect(total).toBeGreaterThan(30);
    expect(duplicates).toBe(0);
  });

  it('откат тика не заставляет событие прозвучать заново', () => {
    // Номер тика умеет уменьшаться: предсказание пересобирается,
    // и мир на кадре бывает младше, чем на предыдущем.
    const feed = createCueFeed();
    const snapshots: WorldState[] = [];

    let first = true;
    playMatch(400, (world) => {
      feed.accept(world, first);
      first = false;
      snapshots.push(world);
    });

    const withShots = snapshots.filter((world) => world.shots.length > 0);
    expect(withShots.length).toBeGreaterThan(5);

    // Переигрываем последнюю сотню кадров задом наперёд и заново.
    let replayed = 0;
    for (const world of [...withShots].reverse()) replayed += feed.accept(world, false).length;
    for (const world of withShots) replayed += feed.accept(world, false).length;

    expect(replayed).toBe(0);
  });

  it('молчаливый кадр запоминает событие, но не играет его', () => {
    const seen: WorldState[] = [];
    playMatch(900, (world) => seen.push(world));

    const busy = seen.find((world) => world.shots.length > 0);
    expect(busy).toBeDefined();
    if (busy === undefined) return;

    const quiet = createCueFeed();
    expect(quiet.accept(busy, true)).toEqual([]);
    // Тот же мир вторым кадром — уже не молчаливым — всё равно молчит:
    // ключи запомнены.
    expect(quiet.accept(busy, false)).toEqual([]);
  });

  it('выстрел постройки отличается от выстрела машины', () => {
    // Одна сторона строит башню у себя и ждёт; вторая идёт на неё.
    // Башня стреляет из центра клетки, машина — почти никогда, и по этому
    // они и различаются.
    const feed = createCueFeed();
    const heard = new Set<Sound>();

    let world = createWorld(77);
    const base = world.map.baseCells[0] ?? 0;

    const commands: Command[] = [
      target(PLAYER_TWO, 1, base),
      {
        kind: CommandKind.Build,
        player: PLAYER_ONE,
        tick: asTickNumber(1),
        // Клетка перед своей базой: там войско противника и пройдёт.
        cell: base + 4,
        structure: StructureKind.TowerBasic,
      },
    ];
    for (let order = 0; order < 10; order += 1) {
      commands.push(train(PLAYER_TWO, 2 + order, UnitType.Assault));
    }

    let first = true;
    for (let tick = 0; tick < 1500; tick += 1) {
      world = step(
        world,
        commands.filter((command) => command.tick === world.tick),
      );
      for (const cue of feed.accept(world, first)) heard.add(cue.sound);
      first = false;
    }

    expect(heard.has(Sound.BoltUnit)).toBe(true);
    expect(heard.has(Sound.BoltTower)).toBe(true);
  });

  it('память не растёт вместе с матчем', () => {
    // Без уборки к концу матча в множестве были бы сотни тысяч ключей.
    const feed = createCueFeed();

    let first = true;
    playMatch(1800, (world) => {
      feed.accept(world, first);
      first = false;
    });

    const stored = feed.size;
    expect(stored).toBeGreaterThan(0);
    // Хранится только недавнее: запас — десять сроков жизни самой долгой
    // записи, то есть полсотни секунд, а матч шёл минуту.
    expect(stored).toBeLessThan(4000);
  });

  it('положение события лежит внутри карты', () => {
    const feed = createCueFeed();
    const outside: Cue[] = [];

    let first = true;
    playMatch(600, (world) => {
      for (const cue of feed.accept(world, first)) {
        // Границы берутся из размера карты, а не вписаны числом. Вписанное
        // 48 пережило уменьшение карты до 38 молча: событие за краем поля
        // проверку по-прежнему проходило, и ловить ей стало нечего.
        const beyond =
          cue.cellX < 0 ||
          cue.cellY < 0 ||
          cue.cellX >= MAP_WIDTH_CELLS ||
          cue.cellY >= MAP_HEIGHT_CELLS;
        if (beyond) outside.push(cue);
      }
      first = false;
    });

    expect(outside).toEqual([]);
  });
});

describe('сроки жизни', () => {
  it('у каждого звука события есть срок, кроме ротора', () => {
    for (const sound of SOUNDS) {
      const ticks = cueLifetimeTicks(sound);
      if (sound === Sound.Rotor) expect(ticks).toBe(0);
      else expect(ticks).toBeGreaterThan(0);
    }
  });

  it('срок ядерного взрыва — самый долгий, и от него считается уборка', () => {
    for (const sound of SOUNDS) {
      expect(cueLifetimeTicks(sound)).toBeLessThanOrEqual(BLAST_LIFETIME_TICKS[BlastKind.Nuke]);
    }
  });
});
