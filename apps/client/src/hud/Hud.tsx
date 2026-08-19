import { Panel } from '@td/ui';
import { useHudStore } from '../game/store.js';
import type { ConnectionStatus } from '../game/store.js';

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
 * Компонент подписан на store точечно: каждый useHudStore с селектором
 * перерисовывает только себя и только при изменении своего значения.
 * Игровое поле при этом вообще не участвует в рендере React.
 */
export const Hud = () => (
  <div id="hud" data-testid="hud">
    <Panel
      title="Соединение"
      style={{ position: 'absolute', top: 'var(--td-space-4)', left: 'var(--td-space-4)' }}
    >
      <ConnectionRow />
      <StatRow label="Тик" value={<TickValue />} />
      <StatRow label="Задержка" value={<LatencyValue />} />
      <StatRow label="Ответов" value={<PongValue />} />
      <StatRow label="Кадров/с" value={<FpsValue />} />
    </Panel>
  </div>
);

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

const StatRow = ({ label, value }: { label: string; value: React.ReactNode }) => (
  <div
    style={{
      display: 'flex',
      justifyContent: 'space-between',
      gap: 'var(--td-space-6)',
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
const FpsValue = () => <>{useHudStore((state) => state.fps)}</>;
