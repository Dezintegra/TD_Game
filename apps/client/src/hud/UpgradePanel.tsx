import { useState } from 'react';
import type { CSSProperties } from 'react';
import { Panel } from '@td/ui';
import { UPGRADE_BRANCHES } from '@td/shared';
import type { UpgradeTarget } from '@td/shared';
import { matchCommands, useHudStore } from '../game/store.js';
import { UPGRADE_GROUP } from './labels.js';

/**
 * Панель прокачки.
 *
 * Двадцать семь веток — прямое следствие требования «каждый показатель
 * каждого типа прокачивается независимо». Верстать их руками значило бы
 * двадцать семь почти одинаковых блоков, которые разойдутся при первой
 * же правке, поэтому список строится из той же таблицы `UPGRADE_BRANCHES`,
 * по которой работает ядро. Добавили ветку в таблицу — она сама появилась
 * в интерфейсе.
 *
 * Панель сворачивается: развёрнутый список из двадцати семи строк закрывает
 * половину поля, а нужен он раз в полминуты.
 */

/**
 * Панель стоит справа внизу, а не слева.
 *
 * Слева живёт колонка состояния с подсказками по управлению, и развёрнутый
 * список из двадцати семи веток накрывал её целиком. Справа внизу свободно:
 * миникарта занимает верхний угол, панель действий — середину.
 */
const panelStyle: CSSProperties = {
  position: 'absolute',
  right: 'var(--td-space-4)',
  bottom: 'var(--td-space-4)',
  // Ширина под две колонки. В одну двадцать семь веток дают около восьмисот
  // пикселей высоты и упираются в миникарту.
  width: 400,
};

/**
 * Список веток в две колонки и без прокрутки.
 *
 * Прокрутка тут была и оказалась ошибкой: выбор из списка, который надо
 * сначала пролистать, в игре реального времени не делается — пока игрок
 * листает, матч идёт.
 *
 * Многоколоночная раскладка, а не сетка из двух колонок: она сама
 * выравнивает колонки по высоте, а сетка оставляла бы одну колонку
 * заметно длиннее другой — группы у веток разного размера, от одной
 * строки до пяти.
 */
const listStyle: CSSProperties = {
  columnCount: 2,
  columnGap: 'var(--td-space-4)',
  marginTop: 'var(--td-space-2)',
};

/** Группа не разрывается между колонками: разорванная читается как две разные. */
const groupStyle: CSSProperties = {
  breakInside: 'avoid',
};

const groupTitleStyle: CSSProperties = {
  color: 'var(--td-text-muted-3)',
  fontSize: 11,
  textTransform: 'uppercase',
  letterSpacing: 'var(--td-ls-label)',
  marginTop: 'var(--td-space-2)',
  marginBottom: 2,
};

const rowStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1fr auto auto',
  alignItems: 'center',
  gap: 'var(--td-space-2)',
  width: '100%',
  padding: '3px var(--td-space-1)',
  border: 'none',
  background: 'transparent',
  color: 'var(--td-text-secondary)',
  fontFamily: 'var(--td-font-ui)',
  fontSize: 'var(--td-text-sm)',
  textAlign: 'left',
  cursor: 'pointer',
};

/** Ветки, сгруппированные по цели. Считается один раз при загрузке модуля. */
const GROUPS: readonly { readonly target: UpgradeTarget; readonly indices: number[] }[] = (() => {
  const groups = new Map<UpgradeTarget, number[]>();

  UPGRADE_BRANCHES.forEach((branch, index) => {
    const existing = groups.get(branch.target);
    if (existing === undefined) groups.set(branch.target, [index]);
    else existing.push(index);
  });

  return [...groups.entries()].map(([target, indices]) => ({ target, indices }));
})();

export const UpgradePanel = () => {
  const upgrades = useHudStore((state) => state.match.upgrades);
  const [open, setOpen] = useState(false);

  if (upgrades.length === 0) return null;

  const totalLevels = upgrades.reduce((sum, row) => sum + row.level, 0);

  return (
    <div style={panelStyle}>
      <Panel title="Прокачка" data-testid="upgrade-panel">
        <button
          type="button"
          data-testid="upgrade-toggle"
          onClick={() => setOpen(!open)}
          style={{
            ...rowStyle,
            gridTemplateColumns: '1fr auto',
            color: 'var(--td-text-primary)',
            fontWeight: 600,
          }}
        >
          <span>{open ? 'Свернуть' : 'Развернуть'}</span>
          <span style={{ fontFamily: 'var(--td-font-mono)', color: 'var(--td-accent)' }}>
            {totalLevels}
          </span>
        </button>

        {open && (
          <div style={listStyle}>
            {GROUPS.map((group) => (
              <div key={group.target} style={groupStyle}>
                <div style={groupTitleStyle}>{UPGRADE_GROUP[group.target]}</div>
                {group.indices.map((index) => (
                  <Row key={index} index={index} />
                ))}
              </div>
            ))}
          </div>
        )}
      </Panel>
    </div>
  );
};

const Row = ({ index }: { readonly index: number }) => {
  const row = useHudStore((state) => state.match.upgrades[index]);
  const branch = UPGRADE_BRANCHES[index];

  if (row === undefined || branch === undefined) return null;

  return (
    <button
      type="button"
      data-testid={`upgrade-${String(index)}`}
      onClick={() => matchCommands().buyUpgrade(index)}
      style={{ ...rowStyle, opacity: row.affordable ? 1 : 0.45 }}
    >
      <span>{branch.label}</span>
      <span style={{ fontFamily: 'var(--td-font-mono)', color: 'var(--td-text-muted-2)' }}>
        ур. {row.level}
      </span>
      <span
        style={{
          fontFamily: 'var(--td-font-mono)',
          color: row.affordable ? 'var(--td-accent)' : 'var(--td-text-muted-4)',
          minWidth: 46,
          textAlign: 'right',
        }}
      >
        {row.cost}
      </span>
    </button>
  );
};
