import type { MouseEvent, ReactNode } from 'react';
import { BUILDABLE_KINDS, StructureKind, UNIT_TYPES, UnitType } from '@td/shared';
import { BATCH_ORDER_COUNT } from '../game/controls.js';
import { matchCommands, useHudStore } from '../game/store.js';
import { BaseIcon, GeneralIcon, StructureIcon, TargetGlyph, UnitIcon } from './icons.js';
import { STRUCTURE_SHORT, UNIT_SHORT } from './labels.js';

/**
 * Плитки заказа: всё, чем игрок распоряжается.
 *
 * Прокачки здесь больше нет. Прежде у каждой плитки был свой столбец
 * характеристик, и показывался он по-разному: на мониторе под плиткой
 * в полосе, на телефоне — панелью поверх поля с другой группировкой.
 * Две картинки одного и того же, и игрок, научившийся одному, второму
 * учился заново. Теперь прокачка живёт одним окном (`UpgradeWindow`),
 * одинаковым на любом размере экрана.
 *
 * Плитка при этом сохранила ровно то, что отвечает на вопрос «заказывать
 * ли сейчас»: значок, название, цену и горячую клавишу. Цена осталась
 * именно здесь, а не уехала в окно: прокачка вида удорожает покупку
 * этого же вида, и без цены у плитки рост стоимости юнита выглядел бы
 * поломкой интерфейса.
 *
 * Разметка ОДНА на все размеры экрана, и это не экономия строк: две
 * разметки означали бы две плитки `train-0` в документе, два набора
 * подписок на store и переименование половины сквозных проверок.
 *
 * Отсюда же требование к стилям: размеры задаются классами, а не
 * встроенным стилем. Встроенный стиль медиазапросом не переопределить,
 * и любая величина, записанная здесь числом, была бы одинакова
 * на мониторе и на телефоне — то есть раскладки бы не было.
 *
 * Никакой игровой логики здесь нет: компонент читает готовый снимок
 * из store и вызывает команду. Решение, можно ли построить башню
 * в этой клетке, принимает ядро симуляции, а не кнопка.
 */

/**
 * Роль плитки — единственное, что React о размерах знает.
 *
 * Роль отвечает не на вопрос «какой экран», а на вопрос «чего стоит
 * промах», и это свойство самого действия. Заказ тратит энергию не на то
 * и вернуть её нельзя; служебное нажатие снимается повторным нажатием
 * и не стоит ничего. Размеры по ролям раздаёт CSS (`--td-tile-order-min`
 * и `--td-tile-service-min`), здесь же только называется роль.
 */
type TileRole = 'order' | 'service';

interface TileProps {
  readonly icon: ReactNode;
  readonly label: string;
  readonly hotkey: string;
  /** Цена заказа. Ноль означает, что плитка ничего не заказывает. */
  readonly cost: number;
  /**
   * Сколько секунд ждать, прежде чем действие снова доступно.
   *
   * Ноль или отсутствие означает «доступно сейчас». Пока идёт отсчёт,
   * он занимает место цены: цена в этот момент не отвечает на вопрос,
   * который у игрока есть, — а вопрос у него «когда».
   *
   * Есть только у ядерного удара; заведено полем, а не проверкой
   * по имени плитки, чтобы следующий откат не завёл второго способа
   * показывать то же самое.
   */
  readonly waitSeconds?: number | undefined;
  readonly affordable: boolean;
  readonly active?: boolean;
  readonly role: TileRole;
  readonly testId: string;
  readonly onSelect: (event: MouseEvent<HTMLButtonElement>) => void;
}

const Tile = ({
  icon,
  label,
  hotkey,
  cost,
  waitSeconds,
  affordable,
  active,
  role,
  testId,
  onSelect,
}: TileProps) => {
  return (
    <div
      className="td-tile"
      data-testid={testId}
      data-role={role}
      data-active={String(active === true)}
    >
      <button
        type="button"
        className="td-tile-head"
        data-testid={`${testId}-select`}
        onClick={onSelect}
        // Недоступное по цене приглушается, но кликается: ядро само
        // отклонит команду, а серая плитка сообщает «дорого», не мешая
        // нажать заранее. Это состояние, а не раскладка, — поэтому
        // встроенным стилем.
        style={{ opacity: affordable ? 1 : 0.45 }}
      >
        <span className="td-tile-icon" aria-hidden>
          {icon}
        </span>
        <span className="td-tile-name">{label}</span>
        <span className="td-key-hint td-tile-hotkey">{hotkey}</span>
      </button>

      {waitSeconds !== undefined && waitSeconds > 0 ? (
        <span className="td-tile-wait" data-testid={`${testId}-wait`}>
          {waitSeconds} с
        </span>
      ) : (
        cost > 0 && (
          <span className="td-tile-cost" data-testid={`${testId}-cost`}>
            {/* Слово «цена» на телефоне прячется правилом CSS, число
                остаётся. Плитке заказа отведено сорок четыре точки, и это
                выбор между «40» и «цена 40 за краем экрана». */}
            <span className="td-tile-cost-label">цена </span>
            {cost}
          </span>
        )
      )}
    </div>
  );
};

const UNIT_HOTKEY: Readonly<Record<UnitType, string>> = {
  [UnitType.Assault]: '1',
  [UnitType.Sniper]: '2',
  [UnitType.Tesla]: '3',
};

/** В режиме строительства цифры выбирают постройку — те же три. */
const STRUCTURE_HOTKEY: Readonly<Record<StructureKind, string>> = {
  [StructureKind.Base]: '',
  [StructureKind.Wall]: 'Q 1',
  [StructureKind.TowerBasic]: 'Q 2',
  [StructureKind.TowerSniper]: 'Q 3',
};

/**
 * Кнопка «открыть — закрыть прокачку».
 *
 * Стоит в левом нижнем углу экрана и есть на ЛЮБОМ размере окна. Прежде
 * её не было на мониторе вовсе: там прокачку разворачивала клавиша `R`,
 * и о самой возможности на экране не сообщало ничто. Возможность,
 * о которой не сообщают, для игрока не существует — он либо не знает,
 * что прокачку можно убрать, либо не знает, что она есть. Обнаружить её
 * случайным нажатием `R` — это не обнаружение, а везение.
 *
 * Клавиша при этом осталась и делает то же самое.
 *
 * Имя состояния (`statsOpen`), ключ хранилища и `data-testid` менять
 * не стали намеренно: переименование ключа молча вернуло бы всем
 * играющим чужое умолчание, а ради одного слова это дорого.
 */
const UpgradesToggle = () => {
  const statsOpen = useHudStore((state) => state.statsOpen);

  return (
    <button
      type="button"
      className="td-stats-toggle"
      data-testid="stats-toggle"
      data-open={String(statsOpen)}
      title={statsOpen ? 'Закрыть прокачку (R)' : 'Открыть прокачку (R)'}
      onClick={() => matchCommands().toggleStats()}
    >
      <span aria-hidden>{statsOpen ? '▾' : '▴'}</span>
      <span>прокачка</span>
    </button>
  );
};

export const ActionBar = () => {
  const match = useHudStore((state) => state.match);

  return (
    <div className="td-toolbar" data-testid="toolbar">
      {/* Рейка заказа. Обёртка нужна раскладке: на мониторе рейка стоит
          двумя столбцами — юниты с ударом слева, постройки с целью
          справа, — и выразить это областями сетки экрана нельзя, там
          у рейки одна область на всё. */}
      <div className="td-order-rail">
        <div className="td-tile-group" data-testid="production-panel">
          {UNIT_TYPES.map((type) => {
            const cost = match.unitCosts[type] ?? 0;

            return (
              <Tile
                key={`unit-${String(type)}`}
                testId={`train-${String(type)}`}
                role="order"
                icon={<UnitIcon type={type} />}
                label={UNIT_SHORT[type]}
                hotkey={UNIT_HOTKEY[type]}
                cost={cost}
                affordable={match.energy >= cost}
                // Ctrl или Shift — заказ пачки. Ядро проверит каждый заказ
                // отдельно, поэтому «десять, когда хватает на четыре»
                // превращается в четыре.
                onSelect={(event) =>
                  matchCommands().train(
                    type,
                    event.ctrlKey || event.shiftKey ? BATCH_ORDER_COUNT : 1,
                  )
                }
              />
            );
          })}
        </div>

        <div className="td-tile-group" data-testid="build-panel">
          {BUILDABLE_KINDS.map((kind) => {
            const cost = match.structureCosts[kind] ?? 0;

            return (
              <Tile
                key={`structure-${String(kind)}`}
                testId={`build-${String(kind)}`}
                role="order"
                icon={<StructureIcon kind={kind} />}
                label={STRUCTURE_SHORT[kind]}
                hotkey={STRUCTURE_HOTKEY[kind]}
                cost={cost}
                affordable={match.energy >= cost}
                active={match.buildKind === kind}
                onSelect={() =>
                  matchCommands().setBuildKind(match.buildKind === kind ? null : kind)
                }
              />
            );
          })}
        </div>

        {/* Ядерный удар и цель атаки стоят РАЗНЫМИ группами, хотя обе
            только включают режим и промах по обеим не стоит ничего.

            Прежде их разделяли ветки прокачки: у удара был свой столбец
            из трёх, у цели нет и не будет. Столбцов при плитках больше
            нет, а разделение осталось, и уже по другой причине: удар
            стоит энергии и показывает цену с откатом, а цель не стоит
            ничего. В одной группе они делили бы ширину поровну, и цена
            удара обрезалась бы ради плитки, которой показывать нечего. */}
        <div className="td-tile-group" data-testid="nuke-panel">
          <Tile
            testId="aim-nuke"
            role="service"
            icon={<span className="td-tile-emoji">☢</span>}
            label="Ядерка"
            hotkey="F"
            cost={match.nukeCost}
            waitSeconds={match.nukeReadyInSeconds}
            // Приглушается и по цене, и по откату: оба означают
            // «сейчас нельзя». Чем именно нельзя, говорит число рядом —
            // цена или секунды.
            affordable={match.energy >= match.nukeCost && match.nukeReadyInSeconds === 0}
            active={match.aimingNuke}
            onSelect={() => matchCommands().toggleNukeAim()}
          />
        </div>

        {/* Цель атаки существует ради касания: цель ставит правая
            кнопка мыши, а у пальца кнопок нет вовсе. Правая кнопка
            при этом работает как прежде — два пути к одному действию
            отличаются ценой: кнопка заметнее, правая кнопка быстрее. */}
        <div className="td-tile-group" data-testid="aim-panel">
          <Tile
            testId="aim-target"
            role="service"
            icon={<TargetGlyph />}
            label="Цель"
            hotkey="ПКМ"
            cost={0}
            affordable
            active={match.aimingTarget}
            onSelect={() => matchCommands().toggleTargetAim()}
          />
        </div>
      </div>

      <span className="td-toolbar-divider" data-testid="toolbar-divider" />

      {/* Служебный ряд под рейкой: прокачка и переходы камерой.

          Отделён от заказа не украшения ради. Нажатие здесь ничего
          не заказывает и энергии не тратит — оно переносит камеру либо
          открывает окно, — и без видимого различия это читается
          поломкой: игрок жмёт «База», ожидая покупки. */}
      <div className="td-service-row">
        <UpgradesToggle />

        <div className="td-tile-group" data-testid="own-panel">
          <Tile
            testId="focus-general"
            role="service"
            icon={<GeneralIcon />}
            label="Генерал"
            hotkey="Пробел"
            cost={0}
            affordable
            onSelect={() => matchCommands().focusOwn('general')}
          />

          {/* Плитка базы переносит камеру, и только. Прокачка добычи
              энергии уехала в строку базы окна прокачки, поэтому прятать
              плитку на маленьком экране больше не нужно: спрятанная,
              она ничего с собой не уносила бы. */}
          <Tile
            testId="focus-base"
            role="service"
            icon={<BaseIcon />}
            label="База"
            hotkey=""
            cost={0}
            affordable
            onSelect={() => matchCommands().focusOwn('base')}
          />
        </div>
      </div>
    </div>
  );
};
