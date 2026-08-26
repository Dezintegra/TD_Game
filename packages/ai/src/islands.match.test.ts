import { describe, expect, it } from 'vitest';
import {
  CommandKind,
  MAP_WIDTH_CELLS,
  StructureKind,
  TICKS_PER_SECOND,
  UPGRADE_BRANCHES,
  UpgradeStat,
  asPlayerId,
} from '@td/shared';
import type { Command } from '@td/shared';
import { createWorld, step } from '@td/sim';
import { approachOf } from './approach.js';
import { islandAim, islandSites } from './islands.js';
import { createOpponent } from './opponent.js';
import { BASELINE_PROFILE, ISLANDS_PROFILE } from './profile.js';

/**
 * Доктрина островов: башни скоплением, ползущим к чужой базе.
 *
 * Как и проверки осадной манеры, эти играют матч С СОПЕРНИКОМ: решение
 * о дорогой покупке зависит от обстановки, и на пустом поле противник
 * ведёт себя иначе.
 */

const ME = asPlayerId(0);
const RIVAL = asPlayerId(1);
const SEED = 4242;

/**
 * Расстояние между клетками по Чебышёву: диагональ считается за один шаг.
 *
 * Тем же способом меряет и сама доктрина (`towersAround` в `islands.ts`),
 * поэтому проверка спрашивает ровно то, чем доктрина управляет. Здесь
 * нужна принадлежность каждой башни, а не число башен вокруг середины:
 * квадраты вокруг середин пересекаются, и суммой их не сложить.
 */
const chebyshev = (from: number, to: number): number =>
  Math.max(
    Math.abs((from % MAP_WIDTH_CELLS) - (to % MAP_WIDTH_CELLS)),
    Math.abs(Math.floor(from / MAP_WIDTH_CELLS) - Math.floor(to / MAP_WIDTH_CELLS)),
  );

interface Played {
  readonly commands: readonly Command[];
  readonly world: ReturnType<typeof createWorld>;
}

const play = (profile: typeof BASELINE_PROFILE, seconds: number): Played => {
  const commands: Command[] = [];
  const mine = createOpponent(ME, SEED, profile);
  const rival = createOpponent(RIVAL, SEED + 1, BASELINE_PROFILE);

  let world = createWorld(SEED);
  for (let tick = 0; tick < seconds * TICKS_PER_SECOND; tick += 1) {
    // Матч кончился — дальше смотреть не на что. Прежде цикл всегда
    // докручивал отпущенные секунды, а матч на этом зерне кончается
    // на 272-й из 420: полторы минуты стенд разглядывал замерший мир,
    // где никто не решает и ничего не строится. Любое утверждение
    // о таком мире — утверждение о случайном мгновении поражения,
    // и разъезжается оно от каждой правки темпа.
    if (world.winner !== null) break;

    const issued = mine.decide(world);
    commands.push(...issued);
    world = step(world, [...issued, ...rival.decide(world)]);
  }

  return { commands, world };
};

describe('места островов', () => {
  const world = createWorld(SEED);
  const approach = approachOf(world, ME);
  if (approach === undefined) throw new Error('нет вероятного пути');

  const doctrine = ISLANDS_PROFILE.islands;
  if (doctrine === undefined) throw new Error('у островного профиля нет доктрины');

  const sites = islandSites(approach, doctrine);

  it('их столько же, сколько долей', () => {
    expect(sites).toHaveLength(doctrine.fractions.length);
  });

  it('идут от своей базы к чужой', () => {
    // Расстояние от своей базы обязано расти: порядок островов — это
    // и порядок работы.
    const distances = sites.map((cell) => approach.fromHome[cell] ?? -1);

    for (let index = 1; index < distances.length; index += 1) {
      expect(distances[index]).toBeGreaterThan(distances[index - 1] ?? -1);
    }
  });

  it('лежат на вероятном пути', () => {
    for (const cell of sites) expect(approach.onPath[cell]).toBe(1);
  });
});

describe('островной профиль', () => {
  const played = play(ISLANDS_PROFILE, 420);
  // Тот же матч базовым профилем — для сравнительных мерок. Доктрину
  // видно только в сравнении: абсолютные числа расстановки у обоих
  // профилей совпадают, потому что строят они вдоль одного и того же
  // вероятного пути.
  const plain = play(BASELINE_PROFILE, 420);

  const builds = played.commands.filter((command) => command.kind === CommandKind.Build);

  it('строит только снайперские башни и стены', () => {
    const kinds = new Set(
      builds.map((command) => (command.kind === CommandKind.Build ? command.structure : -1)),
    );

    expect(kinds.has(StructureKind.TowerSniper)).toBe(true);
    expect(kinds.has(StructureKind.TowerBasic)).toBe(false);
  });

  it('не заказывает ни одного юнита', () => {
    const trained = played.commands.filter((command) => command.kind === CommandKind.TrainUnit);

    expect(trained).toHaveLength(0);
  });

  it('работа переходит от ближнего острова к дальнему', () => {
    // Вот чем доктрина управляет на самом деле: она назначает генералу
    // МЕСТО РАБОТЫ. Клетку под башню выбирает не она, а `towerBuildCell`
    // вокруг того места, где генерал стои́т сейчас, — поэтому по клеткам
    // башен доктрину не поймать, и попытка это делать стоила проекту
    // проверки, три года выполнявшейся как «ноль равен нулю».
    //
    // Здесь проверяется само правило: работа идёт по островам подряд,
    // от своей базы к чужой, и назад не возвращается. Возврат назад
    // не предусмотрен намеренно — остров позади мог опустеть, но бросать
    // ради него передний значило бы ходить между ними без конца.
    const approach = approachOf(played.world, ME);
    if (approach === undefined) throw new Error('нет вероятного пути');

    const doctrine = ISLANDS_PROFILE.islands;
    if (doctrine === undefined) throw new Error('нет доктрины');

    const sites = islandSites(approach, doctrine);

    // С нулевого острова работа начинается, и пока он пуст — с него
    // и не сходит.
    const fresh = createWorld(SEED);
    const first = islandAim(fresh, ME, approachOf(fresh, ME) ?? approach, doctrine, 0);
    expect(first?.index).toBe(0);
    expect(first?.full).toBe(false);

    // Начав с номера N, доктрина не отдаёт работу острову ближе N.
    for (let from = 0; from < sites.length; from += 1) {
      const aim = islandAim(played.world, ME, approach, doctrine, from);
      expect(aim).toBeDefined();
      expect(aim?.index).toBeGreaterThanOrEqual(from);
    }

    // И последний остров — конечная: дальше него работы нет.
    const beyond = islandAim(played.world, ME, approach, doctrine, sites.length + 5);
    expect(beyond?.index).toBe(sites.length - 1);
  });

  it('башни расставлены вдоль пути, а не сгружены у своей базы', () => {
    // Мерка сравнительная, и это единственный способ увидеть доктрину
    // в расстановке. Абсолютная не работает: доля башен, стоящих рядом
    // с островом, у обоих профилей одна и та же — 85 процентов, — потому
    // что острова лежат на вероятном пути, а вдоль него строят оба.
    // Проверка на такую долю была бы зелёной и при выключенной доктрине.
    //
    // Различает их разброс. Островной растягивает башни вдоль пути,
    // потому что работа ползёт от ближнего острова к дальнему; базовый
    // сгружает их у своей базы, у горла подхода. Замер на этом зерне:
    // среднее расстояние между парами башен 8,3 клетки против 2,3.
    //
    // Считаются ПОСТАВЛЕННЫЕ за матч башни, а не уцелевшие к его концу.
    // Уцелевших нет вовсе: островной профиль этот матч проигрывает,
    // и к моменту поражения его башни снесены все до одной. Прежняя
    // проверка смотрела именно на конечный мир и оттого выполнялась
    // как «ноль равен нулю» — зелёная и молчащая.
    const cells = (commands: readonly Command[]): number[] =>
      commands
        .filter((command) => command.kind === CommandKind.Build)
        .filter(
          (command) =>
            command.structure === StructureKind.TowerSniper ||
            command.structure === StructureKind.TowerBasic,
        )
        .map((command) => command.cell);

    const spread = (list: readonly number[]): number => {
      let sum = 0;
      let pairs = 0;
      for (let i = 0; i < list.length; i += 1) {
        for (let j = i + 1; j < list.length; j += 1) {
          sum += chebyshev(list[i] ?? 0, list[j] ?? 0);
          pairs += 1;
        }
      }
      return pairs === 0 ? 0 : sum / pairs;
    };

    const mine = cells(played.commands);
    const theirs = cells(plain.commands);

    expect(mine.length).toBeGreaterThan(0);
    expect(theirs.length).toBeGreaterThan(0);

    // Вдвое — с большим запасом от замеренных 8,3 против 2,3, но заведомо
    // больше того, что даст случай: доктрина обязана быть видна, а не едва
    // угадываться.
    expect(spread(mine)).toBeGreaterThan(spread(theirs) * 2);
  });

  it('качает только атаку и дальность снайперской башни', () => {
    const bought = played.commands.filter((command) => command.kind === CommandKind.BuyUpgrade);
    expect(bought.length).toBeGreaterThan(0);

    for (const command of bought) {
      if (command.kind !== CommandKind.BuyUpgrade) continue;

      const branch = UPGRADE_BRANCHES[command.branch];
      if (branch === undefined) throw new Error(`нет ветки ${String(command.branch)}`);

      expect(branch.target).toBe(4); // UpgradeTarget.TowerSniper
      expect([UpgradeStat.Attack, UpgradeStat.Range]).toContain(branch.stat);
    }
  });
});

describe('профиль без доктрины не задет', () => {
  it('у базового доктрины нет', () => {
    expect(BASELINE_PROFILE.islands).toBeUndefined();
  });

  it('базовый по-прежнему строит базовые башни и заказывает юнитов', () => {
    const played = play(BASELINE_PROFILE, 240);

    const towers = played.commands.filter(
      (command) =>
        command.kind === CommandKind.Build && command.structure === StructureKind.TowerBasic,
    );
    const trained = played.commands.filter((command) => command.kind === CommandKind.TrainUnit);

    expect(towers.length).toBeGreaterThan(0);
    expect(trained.length).toBeGreaterThan(0);
  });
});
