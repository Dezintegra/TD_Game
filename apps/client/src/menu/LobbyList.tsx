import { useState } from 'react';
import type { CSSProperties, FormEvent } from 'react';
import { Button, Panel, TextField } from '@td/ui';
import { NAME_MAX_LENGTH } from '@td/shared';
import { LOBBY_PASSWORD_MAX_LENGTH, LobbyError } from '@td/protocol';
import type { LobbySummary } from '@td/protocol';
import { lobbyErrorText } from '../session/lobby-client.js';
import { useSessionStore } from '../session/session-store.js';
import { sessionActions } from '../session/session.js';
import { MenuShell } from './MenuShell.js';
import { ProfileBar } from './ProfileBar.js';

/**
 * Название комнаты по умолчанию.
 *
 * Двоеточие, а не «Комната Дмитрия», и это не вкусовщина. Родительный
 * падеж требует склонения, а склонение русских имён в общем виде
 * не делается: «Дмитрий» даёт «Дмитрия», «Илья» — «Ильи», «Ким»
 * не склоняется вовсе. Вдобавок игрок волен назваться ником, к которому
 * падежи неприменимы в принципе. Двоеточие снимает вопрос целиком.
 *
 * Длинное имя не должно приводить к отказу за длину названия, поэтому
 * при переполнении остаётся одно имя без приставки: игрок ничего
 * не вводил, и отказывать ему не за что.
 */
const defaultTitle = (name: string): string => {
  const full = `Комната: ${name}`;
  return full.length <= NAME_MAX_LENGTH ? full : name;
};

/**
 * Экран со списком комнат.
 *
 * Список живой: он обновляется потоком состояния, без кнопки
 * «обновить». Кнопка здесь была бы не удобством, а обманом — игрок
 * ломился бы в комнату, занятую полминуты назад.
 */
export const LobbyList = () => {
  const profile = useSessionStore((state) => state.profile);
  const lobbies = useSessionStore((state) => state.view.lobbies);
  const error = useSessionStore((state) => state.error);

  const [title, setTitle] = useState(() => defaultTitle(profile?.name ?? ''));
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  const create = (event: FormEvent): void => {
    event.preventDefault();
    setBusy(true);
    void sessionActions.createLobby(title, password).finally(() => setBusy(false));
  };

  return (
    <MenuShell aside={<RoomsPanel lobbies={lobbies} />}>
      <ProfileBar />

      <Panel title="Начать игру">
        <form onSubmit={create}>
          <div style={{ display: 'flex', gap: 'var(--td-space-2)', alignItems: 'flex-end' }}>
            <div style={{ flex: 1 }}>
              <TextField
                id="lobby-title"
                data-testid="lobby-title"
                label="Название комнаты"
                value={title}
                maxLength={NAME_MAX_LENGTH}
                autoComplete="off"
                onChange={(event) => setTitle(event.target.value)}
              />
            </div>
            <Button type="submit" data-testid="lobby-create" disabled={busy}>
              Новая игра
            </Button>
          </div>

          {/* Пароль — вторая строка, а не третье поле в ряд. Он нужен
              меньшинству, и стоять он обязан так, чтобы большинство
              его не заполняло: пустой пароль означает открытую комнату,
              ровно как было до его появления. */}
          <div style={{ marginTop: 'var(--td-space-2)' }}>
            <TextField
              id="lobby-password"
              data-testid="lobby-password"
              type="password"
              label="Пароль — если комната не для всех"
              value={password}
              maxLength={LOBBY_PASSWORD_MAX_LENGTH}
              // Менеджеру паролей тут делать нечего: это пароль комнаты
              // на десять минут, а не от учётной записи.
              autoComplete="off"
              placeholder="без пароля"
              onChange={(event) => setPassword(event.target.value)}
            />
          </div>
        </form>

        {/* Кнопки «играть с компьютером» здесь больше нет, и это
            не упрощение вёрстки, а решение владельца продукта: вход
            в игру остаётся ОДИН. Соперника — живого или машину — игрок
            выбирает уже в комнате, где видно, с кем он садится играть.
            Прежняя кнопка вела в чужую дежурную комнату мимо этого
            выбора, и ради неё круглые сутки висели девять пустых комнат
            с девятью потоками состояния. */}
        <p
          data-testid="lobby-hint"
          style={{
            margin: 'var(--td-space-3) 0 0',
            color: 'var(--td-text-muted-3)',
            fontSize: 'var(--td-text-sm)',
            lineHeight: 1.6,
          }}
        >
          Соперника выберете в комнате: можно дождаться живого, а можно позвать компьютер.
        </p>
      </Panel>

      {/* Отказ по паролю сюда НЕ попадает: его показывает сама строка,
          прямо у поля ввода. Второй раз внизу экрана он был бы дублем
          и уводил бы взгляд от того места, где опечатку исправляют. */}
      {error !== null && error !== LobbyError.WrongPassword && (
        <div data-testid="lobby-error" style={{ color: 'var(--td-error)' }}>
          {lobbyErrorText[error]}
        </div>
      )}
    </MenuShell>
  );
};

/**
 * Колонка открытых комнат — справа от меню и постоянного размера.
 *
 * Размер постоянен намеренно. Список меняется сам, без действий игрока,
 * и растущая панель двигала бы кнопки меню ровно в тот момент, когда
 * игрок в них целится. Комнаты сверх помещающихся прокручиваются
 * внутри списка; заголовок с их числом при этом остаётся на месте.
 */
const RoomsPanel = ({ lobbies }: { lobbies: readonly LobbySummary[] }) => (
  <Panel
    title={`Открытые комнаты — ${String(lobbies.length)}`}
    data-testid="lobby-panel"
    style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0 }}
  >
    <div className="td-menu-scroll">
      {lobbies.length === 0 ? (
        <p
          data-testid="lobby-empty"
          style={{ margin: 0, color: 'var(--td-text-muted-3)', lineHeight: 1.6 }}
        >
          Пока никто не ждёт соперника. Создайте комнату — она сразу появится у всех, кто смотрит на
          этот список.
        </p>
      ) : (
        <div
          data-testid="lobby-list"
          style={{ display: 'flex', flexDirection: 'column', gap: 'var(--td-space-2)' }}
        >
          {lobbies.map((lobby) => (
            <LobbyRow key={lobby.id} lobby={lobby} />
          ))}
        </div>
      )}
    </div>
  </Panel>
);

const rowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 'var(--td-space-3)',
  padding: 'var(--td-space-2) var(--td-space-3)',
  background: 'var(--td-bg-content)',
  border: '1px solid var(--td-border-subtle)',
  borderRadius: 'var(--td-radius-control)',
};

/**
 * Строка в одну линию с многоточием.
 *
 * Обе подписи строки урезаются, а не переносятся: строка комнаты обязана
 * быть одной и той же высоты при любом названии и любом имени хозяина.
 * Иначе шесть комнат занимают то четыре строки, то шесть, и список
 * то помещается в колонку, то нет.
 */
const clipStyle: CSSProperties = {
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const LobbyRow = ({ lobby }: { lobby: LobbySummary }) => {
  const full = lobby.players >= lobby.capacity;

  /**
   * Пароль спрашивается ЗДЕСЬ, в самой строке, а не отдельным окном.
   *
   * Окно пришлось бы закрывать, оно перекрыло бы список, и игрок потерял
   * бы из виду ту комнату, в которую целился. Строка же остаётся
   * на месте, и видно, к какой именно комнате относится поле.
   */
  const [asking, setAsking] = useState(false);
  const [password, setPassword] = useState('');
  const [refused, setRefused] = useState(false);
  const [busy, setBusy] = useState(false);

  const enter = (secret: string): void => {
    setBusy(true);
    void sessionActions
      .joinLobby(lobby.id, secret)
      .then((error) => {
        // Отказ по паролю остаётся в строке: поле не закрывается,
        // введённое не стирается — опечатку исправляют, а не набирают
        // заново.
        setRefused(error === LobbyError.WrongPassword);
      })
      .finally(() => setBusy(false));
  };

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    enter(password);
  };

  return (
    <div
      style={{ ...rowStyle, flexWrap: 'wrap' }}
      data-testid="lobby-row"
      data-computer={String(lobby.computer)}
      data-locked={String(lobby.locked)}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
        <span style={{ ...clipStyle, display: 'flex', gap: 'var(--td-space-1)' }}>
          {/* Замок стоит ДО попытки входа. Без него игрок жмёт «Войти»,
              получает отказ и только тогда узнаёт, что нужен пароль,
              которого у него нет. */}
          {lobby.locked && (
            <span
              data-testid="lobby-row-locked"
              aria-label="комната под паролем"
              title="Комната под паролем"
              style={{ flexShrink: 0, color: 'var(--td-text-muted-3)' }}
            >
              🔒
            </span>
          )}
          <span style={clipStyle} data-testid="lobby-row-title">
            {lobby.title}
          </span>
        </span>
        <span
          style={{
            display: 'flex',
            gap: 'var(--td-space-1)',
            color: 'var(--td-text-muted-4)',
            fontSize: 'var(--td-text-sm)',
          }}
        >
          <span style={clipStyle}>создал {lobby.hostName}</span>

          {/* Пометка обязательна: игрок должен знать, с кем садится
              играть, а «Компьютер» вполне может оказаться прозвищем
              человека. Поэтому урезается имя хозяина, а не она: длинное
              имя иначе съедало бы её многоточием целиком. */}
          {lobby.computer && (
            <span style={{ flexShrink: 0 }} data-testid="lobby-row-computer">
              — компьютер
            </span>
          )}
        </span>
      </div>

      {/* Правая половина не сжимается: заполненность и кнопка входа —
          то, ради чего строку читают, и подрезать их в пользу названия
          нельзя. */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--td-space-3)',
          flexShrink: 0,
        }}
      >
        <span
          data-testid="lobby-row-players"
          style={{
            fontFamily: 'var(--td-font-mono)',
            whiteSpace: 'nowrap',
            color: full ? 'var(--td-text-muted-4)' : 'var(--td-accent)',
          }}
        >
          {lobby.players} / {lobby.capacity}
        </span>

        <Button
          data-testid="lobby-join"
          disabled={full || busy}
          // Заполненная комната не исчезает из списка, а показывается
          // недоступной: игрок должен видеть, что комната есть и что
          // места в ней кончились, а не гадать, куда она делась.
          variant={full ? 'ghost' : 'accent'}
          onClick={() => {
            // У закрытой комнаты первое нажатие раскрывает поле,
            // а не уходит в сервер с пустым паролем: отказ, которого
            // можно не получать, получать незачем.
            if (lobby.locked && !asking) {
              setAsking(true);
              return;
            }
            enter(password);
          }}
        >
          {full ? 'Занято' : 'Войти'}
        </Button>
      </div>

      {lobby.locked && asking && (
        <form onSubmit={submit} style={{ flexBasis: '100%', marginTop: 'var(--td-space-2)' }}>
          <TextField
            id={`lobby-password-${lobby.id}`}
            data-testid="lobby-row-password"
            type="password"
            // Поле берёт фокус само: игрок уже нажал «Войти», и второе
            // нажатие ради того, чтобы начать печатать, — лишнее.
            autoFocus
            autoComplete="off"
            label="Пароль комнаты"
            value={password}
            maxLength={LOBBY_PASSWORD_MAX_LENGTH}
            error={refused ? 'Пароль не подошёл' : undefined}
            onChange={(event) => {
              setPassword(event.target.value);
              setRefused(false);
            }}
          />
        </form>
      )}
    </div>
  );
};
