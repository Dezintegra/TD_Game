import type { CSSProperties } from 'react';
import { Button, Panel } from '@td/ui';
import { LOBBY_CAPACITY } from '@td/protocol';
import type { ComputerProfile, LobbySlotView } from '@td/protocol';
import { lobbyErrorText } from '../session/lobby-client.js';
import { readyOf, useSessionStore } from '../session/session-store.js';
import { sessionActions } from '../session/session.js';
import { MenuShell } from './MenuShell.js';
import { ProfileBar } from './ProfileBar.js';

/**
 * Комната: двое видят друг друга и договариваются начать.
 *
 * Готовность каждого видна обоим — игрок обязан понимать, ждут его
 * или он ждёт. Своё нажатие перекрашивает кнопку немедленно, до ответа
 * сервера: отклик в том же кадре не перестаёт быть требованием
 * за пределами матча.
 *
 * Здесь же выбирается соперник. Дежурных комнат компьютера больше нет,
 * и позвать машину можно только отсюда — из своей комнаты, где видно,
 * с кем садишься играть.
 */
export const LobbyRoom = () => {
  const lobby = useSessionStore((state) => state.view.lobby);
  const error = useSessionStore((state) => state.error);
  const ready = useSessionStore(readyOf);
  const profiles = useSessionStore((state) => state.view.computerProfiles);
  const inviting = useSessionStore((state) => state.joiningComputer);

  if (lobby === null) return null;

  const alone = lobby.slots.length < LOBBY_CAPACITY;
  const someoneLost = lobby.slots.some((slot) => !slot.connected);

  const empty = Array.from(
    { length: Math.max(0, LOBBY_CAPACITY - lobby.slots.length) },
    (_value, index) => index,
  );

  return (
    <MenuShell>
      <ProfileBar />

      <Panel title={lobby.title} data-testid="room">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--td-space-2)' }}>
          {lobby.slots.map((slot) => (
            <Slot key={slot.name + String(slot.you)} slot={slot} />
          ))}
          {empty.map((index) => (
            <WaitingSlot key={index} />
          ))}
        </div>

        {alone && <ComputerChoice profiles={profiles} wanted={lobby.wanted} inviting={inviting} />}

        <div
          style={{
            marginTop: 'var(--td-space-4)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 'var(--td-space-3)',
          }}
        >
          <Button
            variant="ghost"
            data-testid="room-leave"
            onClick={() => {
              void sessionActions.leaveLobby();
            }}
          >
            Выйти
          </Button>

          <Button
            data-testid="room-ready"
            data-ready={ready ? 'yes' : 'no'}
            // Готовность в одиночестве ничего не выражает: согласие дают
            // на конкретного соперника, а его ещё нет.
            disabled={alone}
            variant={ready ? 'ghost' : 'accent'}
            onClick={() => {
              void sessionActions.toggleReady(!ready);
            }}
          >
            {ready ? 'Не готов' : 'Готов'}
          </Button>
        </div>

        <p
          data-testid="room-hint"
          style={{
            margin: 'var(--td-space-3) 0 0',
            color: 'var(--td-text-muted-3)',
            fontSize: 'var(--td-text-sm)',
            lineHeight: 1.6,
          }}
        >
          {alone
            ? 'Ждём соперника. Пока вы один, готовность недоступна.'
            : someoneLost
              ? 'У соперника пропала связь. Матч не начнётся, пока он не вернётся.'
              : 'Матч начнётся, как только готовность подтвердят оба.'}
        </p>
      </Panel>

      {error !== null && (
        <div data-testid="room-error" style={{ color: 'var(--td-error)' }}>
          {lobbyErrorText[error]}
        </div>
      )}
    </MenuShell>
  );
};

/**
 * Выбор компьютерного соперника — только пока место свободно.
 *
 * Состав манер приходит с сервера, а не зашит здесь: его задаёт служба
 * компьютера при запуске, и клиент, знающий манеры наперёд, соврал бы
 * при первой же смене состава. Пустой список означает, что службы нет
 * вовсе, — и об этом надо сказать прямо, а не показать пустое место:
 * молчаливое отсутствие игрок читает как поломку игры.
 */
const ComputerChoice = ({
  profiles,
  wanted,
  inviting,
}: {
  readonly profiles: readonly ComputerProfile[];
  readonly wanted: string | null;
  readonly inviting: boolean;
}) => (
  <div
    data-testid="room-computer"
    style={{
      marginTop: 'var(--td-space-4)',
      paddingTop: 'var(--td-space-3)',
      borderTop: '1px solid var(--td-border-subtle)',
    }}
  >
    <span
      style={{
        display: 'block',
        marginBottom: 'var(--td-space-2)',
        color: 'var(--td-text-muted-3)',
        fontSize: 'var(--td-text-sm)',
      }}
    >
      {profiles.length === 0
        ? 'Компьютерный соперник сейчас недоступен: его служба не отвечает.'
        : wanted === null
          ? 'Ждать живого соперника или позвать компьютер:'
          : 'Зовём компьютер…'}
    </span>

    {/* Столбцом, а не рядом. Названия манер длинные — «Матч
        с компьютером», «Матч со стратегом», — и втроём в ширину панели
        они не помещаются: ряд переносился на вторую строку и выглядел
        сломанным. Ширина у кнопок своя, а не общая: одинаково широкие
        кнопки под разными по длине названиями выглядели бы таблицей,
        а это перечень. */}
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-start',
        gap: 'var(--td-space-2)',
      }}
    >
      {profiles.map((profile) => (
        <Button
          key={profile.id}
          variant="ghost"
          data-testid={`room-computer-${profile.id}`}
          // Пока зовём — кнопки молчат. Кнопка, отвечающая на нажатие
          // ничем, хуже отсутствующей: игрок решит, что игра сломана.
          disabled={inviting || wanted !== null}
          onClick={() => {
            void sessionActions.inviteComputer(profile.id);
          }}
        >
          {wanted === profile.id ? `${profile.title} — идёт…` : profile.title}
        </Button>
      ))}
    </div>
  </div>
);

const slotStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 'var(--td-space-3)',
  padding: 'var(--td-space-2) var(--td-space-3)',
  background: 'var(--td-bg-content)',
  border: '1px solid var(--td-border-subtle)',
  borderRadius: 'var(--td-radius-control)',
};

const Slot = ({ slot }: { slot: LobbySlotView }) => (
  <div
    style={{
      ...slotStyle,
      borderColor: slot.ready ? 'var(--td-accent-50)' : 'var(--td-border-subtle)',
    }}
    data-testid="room-slot"
    data-ready={slot.ready ? 'yes' : 'no'}
    data-you={slot.you ? 'yes' : 'no'}
  >
    <span style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--td-space-2)' }}>
      <span style={{ fontFamily: 'var(--td-font-mono)' }}>{slot.name}</span>
      {slot.you && (
        <span style={{ color: 'var(--td-text-muted-4)', fontSize: 'var(--td-text-sm)' }}>вы</span>
      )}
    </span>

    <span
      style={{
        fontSize: 'var(--td-text-sm)',
        color: !slot.connected
          ? 'var(--td-warning)'
          : slot.ready
            ? 'var(--td-accent)'
            : 'var(--td-text-muted-3)',
      }}
    >
      {!slot.connected ? 'связь потеряна' : slot.ready ? 'готов' : 'не готов'}
    </span>
  </div>
);

const WaitingSlot = () => (
  <div
    style={{ ...slotStyle, borderStyle: 'dashed', color: 'var(--td-text-muted-4)' }}
    data-testid="room-slot-empty"
  >
    <span>место свободно</span>
    <span style={{ fontSize: 'var(--td-text-sm)' }}>ждём соперника</span>
  </div>
);
