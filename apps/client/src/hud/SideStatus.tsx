import type { CSSProperties, ReactNode } from 'react';
import { BUILDABLE_KINDS, UNIT_TYPES } from '@td/shared';
import type { StructureKind, UnitType } from '@td/shared';
import type { SideView } from '../game/store.js';
import { STRUCTURE_GLYPH, UNIT_GLYPH } from './icons.js';
import { STRUCTURE_SHORT, UNIT_SHORT } from './labels.js';

/**
 * Половина верхней полосы: всё, что известно про одну сторону матча.
 *
 * Чужая сторона показывается ровно так же, как своя, и это не щедрость,
 * а следствие уже принятого решения: тумана войны в игре нет. Игрок и так
 * видит на поле каждую машину соперника — мы избавляем его не от незнания,
 * а от счёта в уме посреди боя.
 *
 * Прочность базы стоит здесь, а не только над самой базой на поле, потому
 * что разрушение базы — условие победы. Величина, ради которой идёт матч,
 * не может требовать перевода взгляда.
 */

interface SideStatusProps {
  readonly side: SideView;
  readonly name: string;
  /** Стороной управляет компьютер. Имени мало: его примут за прозвище. */
  readonly computer: boolean;
  /** Своя сторона. Определяет и цвет, и к какому краю прижато содержимое. */
  readonly own: boolean;
  readonly unitCap: number;
  readonly testId: string;
  /**
   * Номер СВОЕЙ стороны матча, проставляемый в разметку рядом с соперником.
   *
   * Нужен не игроку, а внешней проверке: только по нему видно снаружи,
   * что назначенная сервером сторона доехала до интерфейса и что двое
   * в одном матче получили разные стороны.
   */
  readonly localSide?: number;
}

/**
 * Содержимое прижимается к середине экрана: своё — вправо, чужое — влево.
 *
 * Так две сводки оказываются рядом, и сравнение «у него на восемь Тесл
 * больше» делается глазом. Прижми их к краям — и то же сравнение стоило бы
 * прохода взглядом через весь монитор, то есть не делалось бы вовсе.
 */
const blockStyle = (own: boolean): CSSProperties => ({
  display: 'flex',
  flexDirection: 'column',
  alignItems: own ? 'flex-end' : 'flex-start',
  gap: 3,
  justifySelf: own ? 'end' : 'start',
  color: own ? 'var(--td-player-self)' : 'var(--td-player-enemy)',
  minWidth: 0,
});

const rowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--td-space-2)',
};

const nameStyle: CSSProperties = {
  fontWeight: 700,
  fontSize: 'var(--td-text-md)',
  letterSpacing: 'var(--td-ls-button)',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  maxWidth: 220,
};

const mutedStyle: CSSProperties = {
  color: 'var(--td-text-muted-3)',
  fontSize: 11,
  textTransform: 'uppercase',
  letterSpacing: 'var(--td-ls-label)',
  whiteSpace: 'nowrap',
};

/** Полоса прочности базы. Ширина постоянна: прыгающая полоса не читается. */
const BAR_WIDTH_PX = 168;

const barTrackStyle: CSSProperties = {
  position: 'relative',
  width: BAR_WIDTH_PX,
  height: 6,
  borderRadius: 1,
  background: 'var(--td-bg-input)',
  border: '1px solid var(--td-border-control)',
  overflow: 'hidden',
};

const numberStyle: CSSProperties = {
  fontFamily: 'var(--td-font-mono)',
  fontSize: 'var(--td-text-sm)',
  color: 'var(--td-text-secondary)',
  whiteSpace: 'nowrap',
};

/**
 * Разряды разделяются тонким пробелом: 50 000 читается, 50000 — нет.
 *
 * Своей рукой, а не через `toLocaleString`: тот зависит от данных о языках,
 * которые в разных сборках Node и в разных браузерах отличаются, и одно
 * и то же число выглядело бы по-разному без единой правки кода.
 */
const grouped = (value: number): string =>
  String(value).replace(/\B(?=(\d{3})+(?!\d))/gu, '\u2009');

const BaseHealth = ({ side, own }: { readonly side: SideView; readonly own: boolean }) => {
  const share = side.baseMaxHealth === 0 ? 0 : side.baseHealth / side.baseMaxHealth;

  return (
    <div style={rowStyle} data-testid={own ? 'base-health-own' : 'base-health-enemy'}>
      <span style={mutedStyle}>База</span>
      <div style={barTrackStyle}>
        <div
          style={{
            position: 'absolute',
            inset: 0,
            // Ширина через трансформацию, а не через width: полоса меняется
            // до десяти раз в секунду, и перекладывать из-за неё вёрстку
            // соседей незачем.
            transform: `scaleX(${String(Math.max(0, Math.min(1, share)))})`,
            transformOrigin: 'left',
            background: 'currentColor',
          }}
        />
      </div>
      <span style={numberStyle}>{grouped(side.baseHealth)}</span>
    </div>
  );
};

interface TallyProps {
  readonly glyph: ReactNode;
  readonly value: number;
  readonly title: string;
  readonly testId: string;
}

/**
 * Пиктограмма с числом в правом нижнем углу.
 *
 * Число поверх значка, а не рядом с ним: так одна группа читается одним
 * взглядом, а шесть групп не растягиваются в строку, которую приходится
 * просматривать слева направо.
 *
 * Ноль приглушается, но не прячется. Исчезающая группа сдвигала бы соседей,
 * и позиция «третья слева» перестала бы означать Теслу — а именно по позиции
 * игрок и читает эти числа, не разбирая картинок.
 */
const Tally = ({ glyph, value, title, testId }: TallyProps) => (
  <div
    title={title}
    data-testid={testId}
    style={{
      position: 'relative',
      width: 26,
      height: 24,
      opacity: value === 0 ? 0.35 : 1,
    }}
  >
    {glyph}
    <span
      style={{
        position: 'absolute',
        right: -2,
        bottom: -3,
        fontFamily: 'var(--td-font-mono)',
        fontSize: 11,
        lineHeight: 1,
        fontWeight: 700,
        color: 'var(--td-text-primary)',
        // Подложка отделяет цифру от линий пиктограммы: без неё единица
        // на фоне ствола перестаёт быть единицей.
        background: 'var(--td-bg-page)',
        padding: '1px 2px',
        borderRadius: 2,
      }}
    >
      {value}
    </span>
  </div>
);

export const SideStatus = ({
  side,
  name,
  computer,
  own,
  unitCap,
  testId,
  localSide,
}: SideStatusProps) => {
  const units = side.unitCounts.reduce((sum, value) => sum + value, 0);

  return (
    <div
      style={blockStyle(own)}
      data-testid={testId}
      data-side={localSide === undefined ? undefined : String(localSide)}
      data-computer={localSide === undefined ? undefined : String(computer)}
    >
      <div style={rowStyle}>
        <span style={nameStyle}>{name}</span>
        {computer && (
          <span style={mutedStyle} data-testid="side-computer">
            компьютер
          </span>
        )}
        <span style={mutedStyle} data-testid={own ? 'general-own' : 'general-enemy'}>
          {side.generalAlive ? 'генерал в строю' : `генерал ${String(side.respawnInSeconds)} с`}
        </span>
      </div>

      <BaseHealth side={side} own={own} />

      <div style={rowStyle}>
        {UNIT_TYPES.map((type: UnitType) => {
          const Icon = UNIT_GLYPH[type];
          return (
            <Tally
              key={`unit-${String(type)}`}
              glyph={<Icon />}
              value={side.unitCounts[type] ?? 0}
              title={UNIT_SHORT[type]}
              testId={`${own ? 'own' : 'enemy'}-unit-${String(type)}`}
            />
          );
        })}

        {/* Разделитель между войском и постройками. Без него шесть значков
            читаются одним рядом, и «две башни» легко принять за «два
            снайпера». */}
        <span style={{ width: 1, height: 18, background: 'var(--td-border-divider)' }} />

        {BUILDABLE_KINDS.map((kind: StructureKind) => {
          const Icon = STRUCTURE_GLYPH[kind];
          return (
            <Tally
              key={`structure-${String(kind)}`}
              glyph={<Icon />}
              value={side.structureCounts[kind] ?? 0}
              title={STRUCTURE_SHORT[kind]}
              testId={`${own ? 'own' : 'enemy'}-structure-${String(kind)}`}
            />
          );
        })}

        <span style={numberStyle} data-testid={own ? 'units-own' : 'units-enemy'}>
          <span data-testid={own ? 'unit-count' : undefined}>{units}</span>/{unitCap}
        </span>
      </div>
    </div>
  );
};
