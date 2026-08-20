import type { CSSProperties, ReactNode } from 'react';
import { Button, Panel } from '@td/ui';
import { RejectReason } from '@td/shared';
import { matchCommands, useHudStore } from '../game/store.js';
import type { ConnectionStatus } from '../game/store.js';
import { useSessionStore } from '../session/session-store.js';
import { sessionActions } from '../session/session.js';
import { ActionBar } from './ActionBar.js';
import { NoticeStack, Nudge } from './Notices.js';
import { UpgradePanel } from './UpgradePanel.js';
import { HOTKEYS } from './labels.js';

const statusLabel: Record<ConnectionStatus, string> = {
  offline: 'нет связи',
  connecting: 'подключение',
  online: 'в сети',
};

const statusColor: Record<ConnectionStatus, string> = {
  offline: 'var(--td-error)',
  connecting: 'var(--td-warning)',
  online: 'var(--td-accent)',
};

/**
 * HUD — единственное место, где работает React.
 *
 * Каждое значение подписано на store отдельным селектором, поэтому
 * изменение частоты кадров перерисовывает одну строку, а не всю панель.
 * Игровое поле в рендере React не участвует вообще: его рисует PixiJS,
 * и даже миникарта живёт там же, чтобы не возить позиции сущностей
 * через store.
 */
export const Hud = () => {
  // Сторона выводится в разметку не для красоты: она приходит из снимка
  // матча, то есть из самого игрового цикла, и это единственный способ
  // снаружи убедиться, что назначенная сервером сторона доехала
  // до симуляции, а не осталась только в меню. Значение меняется раз
  // за матч, поэтому на перерисовку не влияет.
  const localPlayer = useHudStore((state) => state.match.localPlayer);

  return (
    <div id="hud" data-testid="hud" data-local-player={String(localPlayer)}>
      <StatusColumn />
      <MatchBar />
      <ActionBar />
      <UpgradePanel />
      <ResultOverlay />
    </div>
  );
};

const columnStyle: CSSProperties = {
  position: 'absolute',
  top: 'var(--td-space-4)',
  left: 'var(--td-space-4)',
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--td-space-3)',
  width: 220,

  // Колонка не имеет права уехать за нижний край экрана.
  //
  // Ограничение появилось не из осторожности. Панель соперника,
  // добавленная вместе с комнатами, вытолкнула подсказки по управлению
  // за окно высотой 720 точек — то есть на обычном ноутбуке, и молча:
  // ни ошибки, ни признака, просто пропавшая панель. В итоге соперник
  // переехал в верхнюю полосу, но страховка осталась — панелей
  // в колонке со временем станет больше.
  maxHeight: 'calc(100% - var(--td-space-4) * 2)',
  overflowY: 'auto',
  scrollbarWidth: 'thin',
};

const StatusColumn = () => (
  <div style={columnStyle}>
    <Panel title="Соединение">
      <ConnectionRow />
      <StatRow label="Тик" value={<TickValue />} />
      <StatRow label="Задержка" value={<LatencyValue />} />
      <StatRow label="Ответов" value={<PongValue />} />
      <StatRow label="Кадров/с" value={<FpsValue />} />
    </Panel>

    <Panel title="Карта">
      <StatRow label="Seed" value={<SeedValue />} />
      <StatRow label="Видно" value={<VisibleValue />} />
      <StatRow label="Скалы" value={<RockValue />} />
      <MatchControls />
    </Panel>

    <Panel title="Управление">
      {HOTKEYS.map((hint) => (
        <div
          key={hint.keys}
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            gap: 'var(--td-space-2)',
            fontSize: 'var(--td-text-sm)',
            lineHeight: 1.6,
            color: 'var(--td-text-muted-3)',
          }}
        >
          <span style={{ fontFamily: 'var(--td-font-mono)', color: 'var(--td-text-muted-1)' }}>
            {hint.keys}
          </span>
          <span style={{ textAlign: 'right' }}>{hint.what}</span>
        </div>
      ))}
    </Panel>
  </div>
);

const controlStyle: CSSProperties = {
  width: '100%',
  marginTop: 'var(--td-space-2)',
  fontSize: 'var(--td-text-sm)',
};

/**
 * Управление самим матчем: перезапуск и выход в меню.
 *
 * Перезапуск есть только в тренировке. В матче из комнаты уход
 * с общей карты бессмыслен: соперник остался бы на прежней, и общего
 * матча не стало бы.
 */
const MatchControls = () => {
  const practice = useSessionStore((state) => state.practiceSeed !== null);

  return (
    <>
      {practice && (
        <Button
          variant="ghost"
          data-testid="restart"
          onClick={() => matchCommands().restart()}
          style={controlStyle}
        >
          Новый матч
        </Button>
      )}

      <Button
        variant="ghost"
        data-testid="match-leave"
        onClick={() => {
          void sessionActions.leaveMatch();
        }}
        style={controlStyle}
      >
        Выйти в меню
      </Button>
    </>
  );
};

/**
 * Соперник по матчу из комнаты.
 *
 * Живёт в верхней полосе, а не в колонке слева, и это не вкусовщина:
 * в колонке панель выталкивала подсказки по управлению за нижний край
 * экрана на обычном ноутбуке. Верхняя полоса растёт вширь, а место
 * там как раз для фактов о матче.
 *
 * В тренировочном матче отсутствует: соперник там безымянный.
 */
const OpponentMetric = () => {
  // Выбираются существующие ссылки, а не собранный на лету объект.
  // Селектор, возвращающий каждый раз новый объект, для zustand означает
  // «состояние изменилось» — и компонент перерисовывается бесконечно,
  // пока React не снимет всё дерево. Проявляется это не ошибкой в месте
  // ошибки, а исчезнувшим интерфейсом.
  const practice = useSessionStore((state) => state.practiceSeed !== null);
  const match = useSessionStore((state) => state.view.match);

  if (practice || match === null) return null;

  return (
    <Metric
      label="Соперник"
      value={
        <span
          data-testid="match-opponent"
          data-side={String(match.side)}
          style={{ color: 'var(--td-player-enemy)' }}
        >
          {match.opponentName}
        </span>
      }
    />
  );
};

/**
 * Чем матч из комнаты пока не является.
 *
 * Полоса существует ради честности. Команды соперника по сети ещё
 * не передаются, и за противоположную сторону играет компьютер.
 * Показать имя живого человека над чужой базой и промолчать об этом —
 * прямой обман: игрок объяснил бы поведение компьютера действиями
 * соперника и сделал бы из матча ложные выводы.
 *
 * Висит постоянно, а не гаснет через пару секунд: мелькнувшее
 * предупреждение можно не заметить, а последствия у него на весь матч.
 *
 * Полоса обязана исчезнуть тем изменением, которое введёт передачу
 * команд по сети.
 */
const OfflineWarning = () => {
  const practice = useSessionStore((state) => state.practiceSeed !== null);
  const isLobbyMatch = useSessionStore((state) => state.view.match !== null);

  if (practice || !isLobbyMatch) return null;

  return (
    <div
      data-testid="match-offline-warning"
      style={{
        padding: 'var(--td-space-1) var(--td-space-3)',
        borderRadius: 'var(--td-radius-control)',
        border: '1px solid var(--td-warning)',
        color: 'var(--td-warning)',
        fontSize: 11,
        letterSpacing: 'var(--td-ls-label)',
        textTransform: 'uppercase',
      }}
    >
      действия соперника пока не идут по сети — за его сторону играет компьютер
    </div>
  );
};

/**
 * Верхняя полоса матча.
 *
 * Здесь только то, что игрок обязан видеть постоянно и не глядя:
 * сколько энергии, сколько прибывает, сколько войск, сколько идёт матч.
 * Всё остальное — по запросу.
 */
const MatchBar = () => {
  const match = useHudStore((state) => state.match);

  const minutes = Math.floor(match.matchSeconds / 60);
  const seconds = Math.floor(match.matchSeconds % 60);

  return (
    // Сообщения об отказах живут внутри этой же колонки, а не отдельным
    // блоком с подобранным отступом сверху: так они всегда оказываются
    // ровно под полосой матча, какой бы высоты та ни выросла.
    <div
      style={{
        position: 'absolute',
        top: 'var(--td-space-4)',
        left: '50%',
        transform: 'translateX(-50%)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 'var(--td-space-2)',
      }}
    >
      <Panel data-testid="match-bar">
        <div style={{ display: 'flex', gap: 'var(--td-space-6)', alignItems: 'baseline' }}>
          <Metric
            label="Энергия"
            value={
              // Энергия вздрагивает на любой отказ по бедности — неважно,
              // за юнита, постройку или улучшение не хватило.
              <Nudge reason={RejectReason.NotEnoughEnergy}>
                <span data-testid="energy">{match.energy}</span>
              </Nudge>
            }
            hint={`+${String(match.incomePerSecond)} / с`}
            accent
          />
          <Metric
            label="Войска"
            value={<span data-testid="unit-count">{match.unitCount}</span>}
            hint={`из ${String(match.unitCap)}`}
          />
          <Metric label="Цель" value={<span data-testid="target">{match.targetLabel}</span>} />
          <OpponentMetric />
          <Metric
            label="Генерал"
            value={
              <span data-testid="general-state">
                {match.generalAlive ? 'в строю' : `${String(match.respawnInSeconds)} с`}
              </span>
            }
          />
          <Metric label="Время" value={`${String(minutes)}:${String(seconds).padStart(2, '0')}`} />
        </div>
      </Panel>

      <OfflineWarning />
      <NoticeStack />
    </div>
  );
};

interface MetricProps {
  readonly label: string;
  readonly value: ReactNode;
  readonly hint?: string;
  readonly accent?: boolean;
}

const Metric = ({ label, value, hint, accent }: MetricProps) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 74 }}>
    <span
      style={{
        color: 'var(--td-text-muted-3)',
        fontSize: 11,
        textTransform: 'uppercase',
        letterSpacing: 'var(--td-ls-label)',
      }}
    >
      {label}
    </span>
    <span
      style={{
        fontFamily: 'var(--td-font-mono)',
        fontSize: 'var(--td-text-lg)',
        color: accent === true ? 'var(--td-accent)' : 'var(--td-text-primary)',
      }}
    >
      {value}
    </span>
    {hint !== undefined && (
      <span style={{ color: 'var(--td-text-muted-4)', fontSize: 11 }}>{hint}</span>
    )}
  </div>
);

/**
 * Итог матча.
 *
 * Перекрывает поле целиком: матч закончен, и продолжать смотреть на него
 * незачем. Единственное действие — начать заново.
 */
const ResultOverlay = () => {
  const winner = useHudStore((state) => state.match.winner);
  // Своя сторона, а не ноль. Играя второй стороной, игрок иначе читал бы
  // «ПОБЕДА» при собственном поражении — и наоборот.
  const localPlayer = useHudStore((state) => state.match.localPlayer);

  if (winner === null) return null;

  const victory = winner === localPlayer;

  return (
    <div
      data-testid="result-overlay"
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 'var(--td-space-4)',
        background: 'var(--td-bg-overlay)',
      }}
    >
      <div
        style={{
          fontSize: 56,
          fontWeight: 700,
          letterSpacing: 'var(--td-ls-button)',
          color: victory ? 'var(--td-accent)' : 'var(--td-error)',
          textShadow: victory ? 'var(--td-glow-accent)' : 'none',
        }}
      >
        {victory ? 'ПОБЕДА' : 'ПОРАЖЕНИЕ'}
      </div>
      <div style={{ color: 'var(--td-text-muted-2)' }}>
        {victory ? 'База противника разрушена' : 'Ваша база разрушена'}
      </div>

      <ResultActions />
    </div>
  );
};

const ResultActions = () => {
  const practice = useSessionStore((state) => state.practiceSeed !== null);

  return (
    <div style={{ display: 'flex', gap: 'var(--td-space-3)' }}>
      {practice && (
        <Button data-testid="restart-overlay" onClick={() => matchCommands().restart()}>
          Новый матч
        </Button>
      )}

      <Button
        variant={practice ? 'ghost' : 'accent'}
        data-testid="leave-overlay"
        onClick={() => {
          void sessionActions.leaveMatch();
        }}
      >
        В меню
      </Button>
    </div>
  );
};

const ConnectionRow = () => {
  const status = useHudStore((state) => state.status);

  return (
    <div
      data-testid="connection-status"
      data-status={status}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--td-space-2)',
        marginBottom: 'var(--td-space-2)',
      }}
    >
      <span
        style={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          background: statusColor[status],
          boxShadow: status === 'online' ? 'var(--td-glow-accent)' : 'none',
        }}
      />
      <span style={{ color: statusColor[status], fontWeight: 600 }}>{statusLabel[status]}</span>
    </div>
  );
};

const StatRow = ({ label, value }: { label: string; value: ReactNode }) => (
  <div
    style={{
      display: 'flex',
      justifyContent: 'space-between',
      gap: 'var(--td-space-4)',
      fontSize: 'var(--td-text-sm)',
      lineHeight: 1.7,
    }}
  >
    <span style={{ color: 'var(--td-text-muted-3)' }}>{label}</span>
    <span style={{ fontFamily: 'var(--td-font-mono)', color: 'var(--td-text-secondary)' }}>
      {value}
    </span>
  </div>
);

const TickValue = () => <>{useHudStore((state) => state.tick)}</>;
const LatencyValue = () => <>{useHudStore((state) => state.latencyMs)} мс</>;
const PongValue = () => (
  <span data-testid="pong-count">{useHudStore((state) => state.pongCount)}</span>
);
const FpsValue = () => <span data-testid="fps">{useHudStore((state) => state.fps)}</span>;
const SeedValue = () => <span data-testid="seed">{useHudStore((state) => state.seed)}</span>;
const VisibleValue = () => (
  <span data-testid="visible-percent">
    {useHudStore((state) => state.visiblePercent).toFixed(1)} %
  </span>
);
const RockValue = () => <>{useHudStore((state) => state.rockPercent).toFixed(1)} %</>;
