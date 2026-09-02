import type { ReactNode } from 'react';
import {
  STRUCTURE_UPGRADE_TARGET,
  StructureKind,
  UNIT_TYPES,
  UNIT_UPGRADE_TARGET,
  UPGRADE_BRANCHES,
  UpgradeStat,
  UpgradeTarget,
} from '@td/shared';
import { NUKE_STAT_GROUP } from '../game/stat-rows.js';
import { matchCommands, useHudStore } from '../game/store.js';
import type { StatRow } from '../game/store.js';
import { BaseIcon, GeneralIcon, StructureIcon, UnitIcon } from './icons.js';
import { STRUCTURE_SHORT, UNIT_SHORT, UPGRADE_STAT_SHORT, UPGRADE_UNIT } from './labels.js';

/**
 * Окно прокачки — матрица: строка на объект, столбец на характеристику.
 *
 * Одно окно на все размеры экрана, и это прямое требование владельца
 * продукта. Прежде видов было два — столбцы под плитками на мониторе
 * и панель поверх поля на телефоне, — то есть две картинки одного и того
 * же: игрок, научившийся одному, второму учился заново.
 *
 * ## Почему матрица, а не список
 *
 * Решение «кому докупить атаку» — это сравнение атак нескольких объектов.
 * В столбце оно делается взглядом, в списке требует запоминания. Прежние
 * столбцы при плитках сравнение позволяли, но только соседям по ряду
 * и только на мониторе.
 *
 * ## Почему разметка одна
 *
 * Телефон получает ту же матрицу, ужатую переменными: ширина колонки
 * имени, кегли, высота кнопок. Ни строка, ни столбец на телефоне
 * не пропадают — иначе это уже другое окно, а требовалось одинаковое.
 *
 * ## Подписки
 *
 * Как и прежде в `StatLine`: на ЧИСЛА и признаки, а не на строку целиком.
 * Снимок матча пересобирается пять раз в секунду, и объект строки каждый
 * раз новый; подписка на него означала бы, что все тридцать две ячейки
 * перерисовываются пять раз в секунду, хотя меняются они только
 * при покупке.
 */

interface Column {
  readonly key: string;
  readonly title: string;
  /**
   * Какие характеристики сюда попадают.
   *
   * Список, а не одна: у объектов разного рода один и тот же вопрос
   * назван по-разному. «Докуда достаёт» — это дальность выстрела у машины
   * и башни, радиус стройки у генерала и радиус поражения у ракеты; свести
   * их в один столбец правильно, а развести по трём значило бы оставить
   * в каждом по семь прочерков из девяти.
   */
  readonly stats: readonly UpgradeStat[];
}

/**
 * Столбцы матрицы, слева направо.
 *
 * Последний — «особое»: в нём собрано то, что есть ровно у одного объекта
 * и ни с чем не сравнивается. Заголовка у его величин нет общего, поэтому
 * подпись стоит в самой ячейке.
 */
const COLUMNS: readonly Column[] = [
  { key: 'attack', title: 'атака', stats: [UpgradeStat.Attack, UpgradeStat.NukeDamage] },
  { key: 'health', title: 'прочность', stats: [UpgradeStat.Health] },
  { key: 'rate', title: 'темп', stats: [UpgradeStat.FireRate] },
  {
    key: 'reach',
    title: 'дальн. / радиус',
    stats: [UpgradeStat.Range, UpgradeStat.BuildRadius, UpgradeStat.NukeRadius],
  },
  { key: 'speed', title: 'скорость', stats: [UpgradeStat.Speed] },
  {
    key: 'special',
    title: 'особое',
    stats: [UpgradeStat.RespawnTime, UpgradeStat.NukeCooldown, UpgradeStat.Income],
  },
];

/** Столбец, в котором подпись величины стоит в самой ячейке. */
const SPECIAL_COLUMN = 'special';

/** Тон строки: свой у ядерного удара, общий у всех прочих. */
type RowTone = 'own' | 'nuke';

interface Row {
  readonly group: number;
  readonly label: string;
  readonly icon: ReactNode;
  readonly tone: RowTone;
  readonly testId: string;
}

/**
 * Строки сверху вниз: сперва войско, потом укрепления, потом своё.
 *
 * Порядок повторяет вопрос, с которым игрок сюда приходит, а не
 * устройство интерфейса.
 */
const ROWS: readonly Row[] = [
  ...UNIT_TYPES.map((type): Row => ({
    group: UNIT_UPGRADE_TARGET[type],
    label: UNIT_SHORT[type],
    icon: <UnitIcon type={type} />,
    tone: 'own',
    testId: `upgrade-row-unit-${String(type)}`,
  })),
  ...([StructureKind.Wall, StructureKind.TowerBasic, StructureKind.TowerSniper] as const).map(
    (kind): Row => ({
      group: STRUCTURE_UPGRADE_TARGET[kind] ?? UpgradeTarget.Wall,
      label: STRUCTURE_SHORT[kind],
      icon: <StructureIcon kind={kind} />,
      tone: 'own',
      testId: `upgrade-row-structure-${String(kind)}`,
    }),
  ),
  {
    group: UpgradeTarget.General,
    label: 'Генерал',
    icon: <GeneralIcon />,
    tone: 'own',
    testId: 'upgrade-row-general',
  },
  {
    // Ядерные ветки принадлежат цели «база», а показываются своей строкой:
    // игрок ищет прокачку ракеты у ракеты. Причина, по которой они
    // числятся за базой, ему не видна и знать её не нужно — пусковая
    // установка стоит на площадке базы, а девятая цель прокачки сдвинула
    // бы контрольную сумму каждого мира.
    group: NUKE_STAT_GROUP,
    label: 'Ядерка',
    icon: <span className="td-upgrade-emoji">☢</span>,
    tone: 'nuke',
    testId: 'upgrade-row-nuke',
  },
  {
    group: UpgradeTarget.Base,
    // У базы значка нет отрисованного: её тело печёт другой запекатель,
    // и печёт целиком — подиум четыре на четыре клетки с антенной.
    // В строку на тридцать точек оно сворачивается в пятно.
    label: STRUCTURE_SHORT[StructureKind.Base],
    icon: <BaseIcon />,
    tone: 'own',
    testId: 'upgrade-row-base',
  },
];

/** Ветка группы, попадающая в этот столбец. Минус один — такой нет. */
const branchIn = (rows: readonly StatRow[], stats: readonly UpgradeStat[]): number => {
  const found = rows.find((row) => {
    const description = UPGRADE_BRANCHES[row.branch];
    return description !== undefined && stats.includes(description.stat);
  });

  return found?.branch ?? -1;
};

/**
 * Ячейка матрицы.
 *
 * Ветка ищется по характеристике, а не по номеру строки в группе:
 * порядок веток внутри группы задан таблицей баланса, и полагаться
 * на него значило бы завести молчаливую зависимость от чужого файла.
 */
const Cell = ({ group, column }: { readonly group: number; readonly column: Column }) => {
  const branch = useHudStore((state) => branchIn(state.match.stats[group] ?? [], column.stats));

  // Прочерк, а не пустое место. Пустая клетка читается как «ещё
  // не загрузилось», прочерк — как «этого у объекта нет».
  if (branch < 0) {
    return (
      <div className="td-upgrade-cell td-upgrade-cell--empty" aria-hidden>
        —
      </div>
    );
  }

  return <FilledCell group={group} branch={branch} named={column.key === SPECIAL_COLUMN} />;
};

const FilledCell = ({
  group,
  branch,
  named,
}: {
  readonly group: number;
  readonly branch: number;
  readonly named: boolean;
}) => {
  const at = (state: { readonly match: { readonly stats: readonly (readonly StatRow[])[] } }) =>
    state.match.stats[group]?.find((row) => row.branch === branch);

  const value = useHudStore((state) => at(state)?.value ?? 0);
  const next = useHudStore((state) => at(state)?.next);
  const fraction = useHudStore((state) => at(state)?.fraction ?? 0);
  const cost = useHudStore((state) => at(state)?.cost ?? 0);
  const affordable = useHudStore((state) => at(state)?.affordable ?? false);
  const maxed = useHudStore((state) => at(state)?.maxed ?? false);

  const description = UPGRADE_BRANCHES[branch];
  if (description === undefined) return null;

  return (
    <div className="td-upgrade-cell" data-testid={`stat-${String(branch)}`}>
      {/* Подпись стоит только в особом столбце. В остальных на вопрос
          «что это за число» отвечает заголовок столбца, и повторять его
          в каждой из сорока ячеек значило бы занять ими половину окна.
          У особого общего заголовка нет — там в каждой строке своя
          величина, и без подписи столбец сообщал бы число, не говоря
          о чём. */}
      {named && (
        <span className="td-upgrade-special-name">{UPGRADE_STAT_SHORT[description.stat]}</span>
      )}

      <span className="td-upgrade-values">
        <span className="td-upgrade-now" data-testid={`stat-value-${String(branch)}`}>
          {value.toFixed(fraction)}
          {/* Единица измерения отдельным элементом: на узком экране она
              прячется правилом CSS, а размерность в этот момент уже
              сказана заголовком столбца. */}
          <span className="td-stat-unit">{UPGRADE_UNIT[description.stat]}</span>
        </span>
        {next !== undefined && (
          <span className="td-upgrade-next" data-testid={`stat-next-${String(branch)}`}>
            → {next.toFixed(fraction)}
          </span>
        )}
      </span>

      {/* Предельная ветка кнопки не предлагает вовсе. Приглушённая кнопка
          означает «копи» — это ответ на нехватку энергии, а здесь копить
          не на что: покупка будет отклонена при любом кошельке. */}
      {maxed ? (
        <span className="td-upgrade-maxed" data-testid={`maxed-${String(branch)}`}>
          макс.
        </span>
      ) : (
        <button
          type="button"
          className="td-upgrade-buy"
          data-testid={`upgrade-${String(branch)}`}
          data-affordable={String(affordable)}
          title={`${description.label} — улучшить за ${String(cost)}`}
          onClick={() => matchCommands().buyUpgrade(branch)}
        >
          <span aria-hidden>▲</span>
          {cost}
        </button>
      )}
    </div>
  );
};

export const UpgradeWindow = () => {
  const open = useHudStore((state) => state.statsOpen);
  const energy = useHudStore((state) => state.match.energy);

  if (!open) return null;

  return (
    <div className="td-upgrade-window" data-testid="upgrade-window">
      <div className="td-upgrade-head">
        <span className="td-upgrade-title">Прокачка</span>
        <span className="td-upgrade-subtitle">все объекты и все ветки</span>
        <span className="td-upgrade-spacer" />
        {/* Энергия повторена здесь намеренно, хотя она же стоит вверху
            экрана. Игрок в этот момент торгуется, и число, ради которого
            он решает покупать или копить, обязано быть под рукой,
            а не в другом углу. */}
        <span className="td-upgrade-energy">
          <span className="td-upgrade-energy-value">{energy}</span>
          <span className="td-upgrade-energy-label">энергия</span>
        </span>
        <button
          type="button"
          className="td-upgrade-close"
          data-testid="upgrade-close"
          title="Закрыть прокачку (R или Esc)"
          onClick={() => matchCommands().toggleStats()}
        >
          <span aria-hidden>✕</span>
        </button>
      </div>

      <div className="td-upgrade-grid">
        <div className="td-upgrade-headrow">
          <span />
          {COLUMNS.map((column) => (
            <span key={column.key} className="td-upgrade-colname">
              {column.title}
            </span>
          ))}
        </div>

        {ROWS.map((row) => (
          <div key={row.testId} className="td-upgrade-row" data-testid={row.testId}>
            <div className="td-upgrade-name" data-tone={row.tone}>
              <span className="td-upgrade-icon">{row.icon}</span>
              <span className="td-upgrade-label">{row.label}</span>
            </div>

            {COLUMNS.map((column) => (
              <Cell key={column.key} group={row.group} column={column} />
            ))}
          </div>
        ))}
      </div>

      <div className="td-upgrade-note">
        зелёным — значение после покупки: +10 % за уровень, темп и возрождение −6 %, ядерные ветки
        +20 %, откат −10 с
      </div>
    </div>
  );
};
