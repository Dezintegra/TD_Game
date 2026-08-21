import { describe, expect, it } from 'vitest';
import { CommandKind } from './commands.js';
import type { Command } from './commands.js';
import { asPlayerId, asTickNumber } from './branded.js';
import { flatten, sameAction, unflatten } from './matchlog.js';
import type { StructureKind, UnitType } from './balance.js';

const player = asPlayerId(1);
const tick = asTickNumber(42);

/** По одной команде каждого вида. Список полон — это проверяется ниже. */
const EVERY_KIND: readonly Command[] = [
  { kind: CommandKind.MoveGeneral, player, tick, direction: 3 },
  { kind: CommandKind.Build, player, tick, cell: 777, structure: 2 as StructureKind },
  { kind: CommandKind.TrainUnit, player, tick, unitType: 1 as UnitType },
  { kind: CommandKind.SetTarget, player, tick, cell: 512 },
  { kind: CommandKind.BuyUpgrade, player, tick, branch: 2 },
  { kind: CommandKind.LaunchNuke, player, tick, cell: 100 },
  { kind: CommandKind.Demolish, player, tick, cell: 64 },
  { kind: CommandKind.SetStance, player, tick, stance: 1 },
];

const flatRecord = (command: Command) => {
  const [arg0, arg1] = flatten(command);
  return { t: 'cmd' as const, tick: command.tick, player: command.player, kind: command.kind, arg0, arg1 };
};

describe('плоский вид команды', () => {
  it('переживает преобразование туда и обратно без потерь', () => {
    for (const command of EVERY_KIND) {
      expect(unflatten(flatRecord(command))).toEqual(command);
    }
  });

  it('знает каждый вид команды, объявленный в правилах', () => {
    // Это и есть настоящая проверка полноты. Добавили девятый вид команды
    // и забыли про запись — тест краснеет здесь, в тот же день, а не через
    // месяц расхождением воспроизведения, причину которого не найти.
    // Ровно так в августе потерялись Demolish и SetStance.
    const covered = new Set(EVERY_KIND.map((command) => command.kind));

    for (const kind of Object.values(CommandKind)) {
      expect(covered.has(kind), `вид команды ${String(kind)} не покрыт записью`).toBe(true);

      const restored = unflatten({ t: 'cmd', tick: 0, player: 0, kind, arg0: 0, arg1: 0 });
      expect(restored?.kind, `вид команды ${String(kind)} не собирается обратно`).toBe(kind);
    }
  });

  it('не собирает команду неизвестного вида и не притворяется, что собрал', () => {
    expect(unflatten({ t: 'cmd', tick: 0, player: 0, kind: 99, arg0: 0, arg1: 0 })).toBeUndefined();
  });
});

describe('сравнение команд по существу', () => {
  it('не различает стороны и тики', () => {
    const left: Command = { kind: CommandKind.SetTarget, player: asPlayerId(0), tick: asTickNumber(1), cell: 7 };
    const right: Command = { kind: CommandKind.SetTarget, player: asPlayerId(1), tick: asTickNumber(900), cell: 7 };

    expect(sameAction(left, right)).toBe(true);
  });

  it('различает аргументы', () => {
    const left: Command = { kind: CommandKind.SetTarget, player, tick, cell: 7 };
    const right: Command = { kind: CommandKind.SetTarget, player, tick, cell: 8 };

    expect(sameAction(left, right)).toBe(false);
  });

  it('различает виды, совпавшие аргументами', () => {
    const demolish: Command = { kind: CommandKind.Demolish, player, tick, cell: 7 };
    const target: Command = { kind: CommandKind.SetTarget, player, tick, cell: 7 };

    expect(sameAction(demolish, target)).toBe(false);
  });
});
