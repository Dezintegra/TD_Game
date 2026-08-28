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
import { NUKE_STAT_GROUP } from '../game/stat-rows.js';
import { matchCommands, useHudStore } from '../game/store.js';
import type { StatRow } from '../game/store.js';
import { BaseGlyph, GeneralIcon, StructureIcon, TargetGlyph, UnitIcon } from './icons.js';
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
  /**
   * Группа столбца характеристик, которую показывать. Нет — столбца нет.
   *
   * Группа, а не цель прокачки, и это не придирка к слову. У всех плиток,
   * кроме ядерного удара, они совпадают; ядерные же ветки принадлежат
   * цели «база», а показываются здесь — см. `NUKE_STAT_GROUP`.
   */
  readonly group?: number | undefined;
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
  group,
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

      {statsOpen && group !== undefined && <StatColumn group={group} />}
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
const StatColumn = ({ group }: { readonly group: number }) => {
  const count = useHudStore((state) => state.match.stats[group]?.length ?? 0);

  if (count === 0) return null;

  return (
    <div className="td-stat-column">
      {Array.from({ length: count }, (_, index) => (
        <StatLine key={index} group={group} index={index} />
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
const StatLine = ({ group, index }: { readonly group: number; readonly index: number }) => {
  const at = (state: { readonly match: { readonly stats: readonly (readonly StatRow[])[] } }) =>
    state.match.stats[group]?.[index];

  const branch = useHudStore((state) => at(state)?.branch ?? -1);
  const value = useHudStore((state) => at(state)?.value ?? 0);
  const fraction = useHudStore((state) => at(state)?.fraction ?? 0);
  const cost = useHudStore((state) => at(state)?.cost ?? 0);
  const affordable = useHudStore((state) => at(state)?.affordable ?? false);
  const maxed = useHudStore((state) => at(state)?.maxed ?? false);

  const description = UPGRADE_BRANCHES[branch];
  if (branch < 0 || description === undefined) return null;

  const row = { branch, value, fraction, cost, affordable, maxed };

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
      {/* Предельная ветка кнопки не предлагает вовсе. Приглушённая
          стрелка означает «копи» — это ответ на нехватку энергии,
          а здесь копить не на что: покупка будет отклонена при любом
          кошельке. Кнопка, которая гарантированно получит отказ, —
          это обещание, которого интерфейс не сдержит. */}
      {row.maxed ? (
        <span
          className="td-stat-maxed"
          data-testid={`maxed-${String(branch)}`}
          title="Предельный уровень"
        >
          макс.
        </span>
      ) : (
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
    <>
      <UpgradesToggle />

      <div className="td-toolbar" data-testid="toolbar">
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
                group={UNIT_UPGRADE_TARGET[type]}
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
                group={STRUCTURE_UPGRADE_TARGET[kind]}
                onSelect={() =>
                  matchCommands().setBuildKind(match.buildKind === kind ? null : kind)
                }
              />
            );
          })}
        </div>

        {/* Ядерный удар и цель атаки стоят РАЗНЫМИ группами, хотя обе
            только включают режим и промах по обеим не стоит ничего.

            Разделило их то, что у удара появился столбец из трёх ядерных
            веток, а у цели веток нет и не будет. В одной группе плитки
            делят ширину поровну, и на телефоне цель отнимала у удара
            половину ряда ни за что: подписи «мощн.» и «радиус»
            обрезались до одной буквы. Разными группами раскладка панели
            ставит их порознь — удару ширину, цели место рядом с кнопкой
            прокачки. */}
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
            group={NUKE_STAT_GROUP}
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

        <span className="td-toolbar-divider" data-testid="toolbar-divider" />

        <div className="td-tile-group" data-testid="own-panel">
          <Tile
            testId="focus-general"
            role="service"
            icon={<GeneralIcon />}
            label="Генерал"
            hotkey="Пробел"
            cost={0}
            affordable
            group={UpgradeTarget.General}
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
            group={UpgradeTarget.Base}
            onSelect={() => matchCommands().focusOwn('base')}
          />
        </div>
      </div>
    </>
  );
};
