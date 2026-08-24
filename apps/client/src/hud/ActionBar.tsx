import type { MouseEvent, ReactNode } from 'react';
import {
  BUILDABLE_KINDS,
  STRUCTURE_UPGRADE_TARGET,
  StructureKind,
  UNIT_TYPES,
  UNIT_UPGRADE_TARGET,
  UPGRADE_BRANCHES,
  UnitType,
  UpgradeTarget,
} from '@td/shared';
import { BATCH_ORDER_COUNT } from '../game/controls.js';
import { matchCommands, useHudStore } from '../game/store.js';
import type { StatRow } from '../game/store.js';
import { BaseGlyph, GeneralGlyph, STRUCTURE_GLYPH, TargetGlyph, UNIT_GLYPH } from './icons.js';
import { STRUCTURE_SHORT, UNIT_SHORT, UPGRADE_STAT_SHORT, UPGRADE_UNIT } from './labels.js';

/**
 * Нижний тулбар: всё, чем игрок распоряжается, и вся прокачка.
 *
 * Прокачка живёт при плитках, а не отдельным списком, и это главное
 * решение. Прежняя панель перечисляла двадцать девять веток строкой
 * «Атака — ур. 7 — 96» в другом углу экрана. Ни на один вопрос игрока она
 * не отвечала: что такое седьмой уровень атаки, он не знает, а решение
 * «докупить Тесле дальность» принимается там, где видно саму Теслу.
 *
 * Поэтому у каждой плитки есть столбец с ДЕЙСТВУЮЩИМИ значениями,
 * и стрелка покупки — прямо у той характеристики, которую она поднимает.
 *
 * Показывается этот столбец по-разному, и решает это CSS, а не React.
 * На мониторе — под плиткой в полосе, как прежде. На маленьком экране
 * полоса поднимается панелью поверх поля и раскладывается в три ряда:
 * юниты, постройки, генерал с базой. Разметка при этом ОДНА, и это
 * не экономия строк: две разметки означали бы две плитки `train-0`
 * в документе, два набора подписок на store и переименование половины
 * сквозных проверок.
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
  readonly affordable: boolean;
  readonly active?: boolean;
  readonly role: TileRole;
  /** Цель прокачки, чьи характеристики показывать. Нет — столбца нет. */
  readonly target?: UpgradeTarget | undefined;
  readonly testId: string;
  readonly onSelect: (event: MouseEvent<HTMLButtonElement>) => void;
}

const Tile = ({
  icon,
  label,
  hotkey,
  cost,
  affordable,
  active,
  role,
  target,
  testId,
  onSelect,
}: TileProps) => {
  const statsOpen = useHudStore((state) => state.statsOpen);

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

      {cost > 0 && (
        <span className="td-tile-cost" data-testid={`${testId}-cost`}>
          {/* Слово «цена» на телефоне прячется правилом CSS, число
              остаётся. Плитке заказа отведено сорок четыре точки, и это
              выбор между «40» и «цена 40 за краем экрана». */}
          <span className="td-tile-cost-label">цена </span>
          {cost}
        </span>
      )}

      {statsOpen && target !== undefined && <StatColumn target={target} />}
    </div>
  );
};

/**
 * Столбец характеристик одной цели прокачки.
 *
 * Подписан на ЧИСЛО строк, а не на сам список. Список пересобирается
 * при каждом снимке матча — то есть пять раз в секунду, — и подписка
 * на него означала бы перерисовку столбца пять раз в секунду просто так:
 * содержимое-то не менялось.
 */
const StatColumn = ({ target }: { readonly target: UpgradeTarget }) => {
  const count = useHudStore((state) => state.match.stats[target]?.length ?? 0);

  if (count === 0) return null;

  return (
    <div className="td-stat-column">
      {Array.from({ length: count }, (_, index) => (
        <StatLine key={index} target={target} index={index} />
      ))}
    </div>
  );
};

/**
 * Одна характеристика: название, действующее значение и стрелка покупки.
 *
 * Подписки здесь на ЧИСЛА и признаки, а не на строку целиком, и это
 * не педантизм. Снимок матча пересобирается пять раз в секунду, и объект
 * строки каждый раз новый; подписка на него означала бы, что все тридцать
 * строк тулбара перерисовываются пять раз в секунду, хотя меняются они
 * только при покупке. Примитивы zustand сравнивает по значению, и лишней
 * перерисовки не происходит вовсе.
 */
const StatLine = ({
  target,
  index,
}: {
  readonly target: UpgradeTarget;
  readonly index: number;
}) => {
  const at = (state: { readonly match: { readonly stats: readonly (readonly StatRow[])[] } }) =>
    state.match.stats[target]?.[index];

  const branch = useHudStore((state) => at(state)?.branch ?? -1);
  const value = useHudStore((state) => at(state)?.value ?? 0);
  const fraction = useHudStore((state) => at(state)?.fraction ?? 0);
  const cost = useHudStore((state) => at(state)?.cost ?? 0);
  const affordable = useHudStore((state) => at(state)?.affordable ?? false);

  const description = UPGRADE_BRANCHES[branch];
  if (branch < 0 || description === undefined) return null;

  const row = { branch, value, fraction, cost, affordable };

  return (
    <div className="td-stat-line" data-testid={`stat-${String(branch)}`}>
      <span className="td-stat-name" title={description.label}>
        {UPGRADE_STAT_SHORT[description.stat]}
      </span>
      <span className="td-stat-value" data-testid={`stat-value-${String(branch)}`}>
        {row.value.toFixed(row.fraction)}
        {/* Единица измерения отдельным элементом: в панели телефона
            она прячется правилом CSS. Восемь плиток в ширину ландшафта
            помещаются только так, а размерность в этот момент уже сказана
            названием строки — «дальн.» и «скор.» ни с чем не спутать. */}
        <span className="td-stat-unit">{UPGRADE_UNIT[description.stat]}</span>
      </span>
      <button
        type="button"
        className="td-stat-buy"
        data-testid={`upgrade-${String(branch)}`}
        data-affordable={String(row.affordable)}
        title={`Улучшить за ${String(row.cost)}`}
        onClick={() => matchCommands().buyUpgrade(branch)}
      >
        <span aria-hidden>▲</span>
        {row.cost}
      </button>
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
    <>
      <UpgradesToggle />

      <div className="td-toolbar" data-testid="toolbar">
        <div className="td-tile-group" data-testid="production-panel">
          {UNIT_TYPES.map((type) => {
            const Icon = UNIT_GLYPH[type];
            const cost = match.unitCosts[type] ?? 0;

            return (
              <Tile
                key={`unit-${String(type)}`}
                testId={`train-${String(type)}`}
                role="order"
                icon={<Icon />}
                label={UNIT_SHORT[type]}
                hotkey={UNIT_HOTKEY[type]}
                cost={cost}
                affordable={match.energy >= cost}
                target={UNIT_UPGRADE_TARGET[type]}
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
            const Icon = STRUCTURE_GLYPH[kind];
            const cost = match.structureCosts[kind] ?? 0;

            return (
              <Tile
                key={`structure-${String(kind)}`}
                testId={`build-${String(kind)}`}
                role="order"
                icon={<Icon />}
                label={STRUCTURE_SHORT[kind]}
                hotkey={STRUCTURE_HOTKEY[kind]}
                cost={cost}
                affordable={match.energy >= cost}
                active={match.buildKind === kind}
                target={STRUCTURE_UPGRADE_TARGET[kind]}
                onSelect={() => matchCommands().setBuildKind(match.buildKind === kind ? null : kind)}
              />
            );
          })}
        </div>

        {/* Наведение стоит отдельной группой от построек, хотя раньше
            лежало с ними вместе. Причина не в порядке, а в том, что этой
            группе нечего показывать в панели прокачки: ни у удара,
            ни у цели веток нет. Панель раскладывает группы рядами —
            юниты, постройки, свои объекты, — и группа без единой ветки
            в ряду выглядела бы пустой строкой.

            Заодно это единственные две плитки, промах по которым
            не стоит ничего: обе только включают режим. */}
        <div className="td-tile-group" data-testid="aim-panel">
          <Tile
            testId="aim-nuke"
            role="service"
            icon={<span className="td-tile-emoji">☢</span>}
            label="Ядерка"
            hotkey="F"
            cost={match.nukeCost}
            affordable={match.energy >= match.nukeCost}
            active={match.aimingNuke}
            onSelect={() => matchCommands().toggleNukeAim()}
          />

          {/* Цель атаки существует ради касания: цель ставит правая
              кнопка мыши, а у пальца кнопок нет вовсе. Правая кнопка
              при этом работает как прежде — два пути к одному действию
              отличаются ценой: кнопка заметнее, правая кнопка быстрее. */}
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

        <span className="td-toolbar-divider" data-testid="toolbar-divider" />

        <div className="td-tile-group" data-testid="own-panel">
          <Tile
            testId="focus-general"
            role="service"
            icon={<GeneralGlyph />}
            label="Генерал"
            hotkey="Пробел"
            cost={0}
            affordable
            target={UpgradeTarget.General}
            onSelect={() => matchCommands().focusOwn('general')}
          />

          {/* Плитка базы на маленьком экране прячется правилом CSS,
              а её место занимает прочность базы в верхней полосе: число
              уже там и уже про базу. В панели прокачки плитка снова
              появляется — там она нужна ради добычи энергии. */}
          <Tile
            testId="focus-base"
            role="service"
            icon={<BaseGlyph />}
            label="База"
            hotkey=""
            cost={0}
            affordable
            target={UpgradeTarget.Base}
            onSelect={() => matchCommands().focusOwn('base')}
          />
        </div>
      </div>
    </>
  );
};
