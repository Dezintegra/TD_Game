import { CommandKind, TICKS_PER_SECOND } from '@td/shared';
import type { Command, PlayerId } from '@td/shared';
import { checksum } from '@td/sim';
import type { WorldState } from '@td/sim';

/**
 * Тонкая запись матча.
 *
 * Записывается только то, из чего матч воспроизводится: seed мира, seed
 * и профиль противника, версия кода и команды человека с номерами тиков.
 * Состояние мира не записывается вовсе — оно полностью выводится
 * из перечисленного, потому что и ядро, и противник детерминированы.
 *
 * Подробности — решения, оценки всех рубежей, отказы, снимки сторон —
 * восстанавливает арена, прогоняя матч заново. Отсюда и «тонкая»:
 * пятьдесят килобайт против пяти мегабайт подробного лога.
 *
 * ## Почему не писать подробности сразу
 *
 * Две причины, и обе решающие.
 *
 * Первая — отзывчивость. В горячем пути остаётся `push` в массив,
 * а не сериализация тысяч чисел между кадрами. Главное нефункциональное
 * требование проекта не страдает.
 *
 * Вторая — схема подробного лога будет меняться. Понадобилось новое
 * поле — перепрогнали запись, а не переиграли матч руками.
 *
 * ## Только для разработки
 *
 * Модуль целиком под `import.meta.env.DEV`: в промышленную сборку
 * не попадает ни байта, и никуда за пределы машины разработчика ничего
 * не уходит.
 */

/**
 * Как часто снимается контрольная сумма.
 *
 * Раз в секунду. Тонкая запись бесполезна, если воспроизведение молча
 * разойдётся с оригиналом: разбирать будут выдуманный матч. Чаще незачем —
 * расхождение накапливается, и тик его появления с точностью до секунды
 * достаточен, чтобы понять причину.
 */
const CHECKSUM_EVERY = TICKS_PER_SECOND;

/** Как часто накопленное уходит на диск, в тиках. Раз в полминуты. */
const FLUSH_EVERY = TICKS_PER_SECOND * 30;

export interface RecordingOptions {
  readonly matchId: string;
  readonly worldSeed: number;
  readonly aiSeeds: readonly number[];
  readonly profiles: readonly string[];
  readonly humanPlayer: PlayerId;
  readonly gitSha: string;
  readonly gitDirty: boolean;
  /** Куда отправлять накопленное. Отделено, чтобы можно было проверить. */
  readonly send: (lines: readonly string[]) => void;
}

export interface Recording {
  /**
   * Запомнить команды, поданные на шаг.
   *
   * Вызывается непосредственно перед `step`, а не в момент нажатия,
   * и `tick` берётся у мира ДО шага. Разница существенна: поле `tick`
   * внутри команды проставляется при нажатии, а до симуляции команда
   * доезжает следующим кадром, и тик к тому моменту может уже уйти
   * вперёд. Воспроизведение подаёт команды по тику мира до шага —
   * значит и записывать надо его, иначе матч разойдётся на первом же
   * действии игрока.
   */
  commands(tick: number, commands: readonly Command[]): void;
  /** Отметить тик: снять контрольную сумму и, если пора, отправить. */
  tick(world: WorldState): void;
  /** Отправить накопленное немедленно. Конец матча, уход со страницы. */
  flush(): void;
}

const argsOf = (command: Command): readonly [number, number] => {
  switch (command.kind) {
    case CommandKind.MoveGeneral:
      return [command.direction, 0];
    case CommandKind.Build:
      return [command.cell, command.structure];
    case CommandKind.TrainUnit:
      return [command.unitType, 0];
    case CommandKind.SetTarget:
      return [command.cell, 0];
    case CommandKind.BuyUpgrade:
      return [command.branch, 0];
    case CommandKind.LaunchNuke:
      return [command.cell, 0];
    case CommandKind.Demolish:
      return [command.cell, 0];
    case CommandKind.SetStance:
      return [command.stance, 0];
  }
};

export const createRecording = (options: RecordingOptions): Recording => {
  let pending: string[] = [
    JSON.stringify({
      t: 'thin',
      matchId: options.matchId,
      worldSeed: options.worldSeed,
      aiSeeds: options.aiSeeds,
      profiles: options.profiles,
      gitSha: options.gitSha,
      gitDirty: options.gitDirty,
      startedAt: new Date().toISOString(),
      humanPlayer: options.humanPlayer,
    }),
  ];

  const flush = (): void => {
    if (pending.length === 0) return;

    const lines = pending;
    pending = [];
    options.send(lines);
  };

  return {
    commands(tick, commands) {
      for (const command of commands) {
        // Записываются команды ЧЕЛОВЕКА. Команды противника не пишутся:
        // он детерминирован и при воспроизведении выдаст их сам, а запись
        // их удвоила бы размер файла, ничего не добавив.
        if (command.player !== options.humanPlayer) continue;

        const [arg0, arg1] = argsOf(command);
        pending.push(
          JSON.stringify({
            t: 'cmd',
            tick,
            player: command.player,
            kind: command.kind,
            arg0,
            arg1,
          }),
        );
      }
    },

    tick(world) {
      if (world.tick % CHECKSUM_EVERY === 0) {
        pending.push(JSON.stringify({ t: 'sum', tick: world.tick, value: checksum(world) }));
      }

      // Отправка по таймеру, а не только по концу матча: закрытая вкладка
      // не должна уносить с собой десять минут игры.
      if (world.tick % FLUSH_EVERY === 0) flush();
    },

    flush,
  };
};
