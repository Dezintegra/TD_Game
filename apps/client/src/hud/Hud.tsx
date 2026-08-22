import { useEffect, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { Button, Panel } from '@td/ui';
import { ATTACK_STANCES, ATTACK_STANCE_LABEL, MS_PER_TICK, RejectReason } from '@td/shared';
import { OutcomeReason } from '@td/protocol';
import { EMPTY_SIDE, matchCommands, useHudStore } from '../game/store.js';
import type { ConnectionStatus, MatchPhaseView } from '../game/store.js';
import { useSessionStore } from '../session/session-store.js';
import { sessionActions } from '../session/session.js';
import { ActionBar } from './ActionBar.js';
import { NoticeStack, Nudge } from './Notices.js';
import { SideStatus } from './SideStatus.js';
import { StructureInfo } from './StructureInfo.js';
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
 * Экран поделён на три полосы: состояние сверху, поле в середине, тулбар
 * снизу. Прежде HUD лежал поверх поля целиком, и нижний тулбар закрывал
 * нижнюю шестую часть карты — не оптически, а по-настоящему: там были
 * клетки, на которых шёл бой.
 *
 * Средняя полоса поля не содержит: поле рисует PixiJS в своём контейнере
 * под этим слоем. Она нужна тому, что показывается ПОВЕРХ поля, — чтобы
 * оно знало границы поля и не заезжало под полосы.
 *
 * Каждое значение подписано на store отдельным селектором, поэтому
 * изменение частоты кадров перерисовывает одну строку, а не всю панель.
 */
export const Hud = () => {
  // Сторона выводится в разметку не для красоты: она приходит из снимка
  // матча, то есть из самого игрового цикла, и это единственный способ
  // снаружи убедиться, что назначенная сервером сторона доехала
  // до симуляции, а не осталась только в меню. Значение меняется раз
  // за матч, поэтому на перерисовку не влияет.
  const localPlayer = useHudStore((state) => state.match.localPlayer);
  const statsOpen = useHudStore((state) => state.statsOpen);

  /**
   * Свёрнутые характеристики — это другая высота нижней полосы, а значит
   * другой размер поля.
   *
   * Класс ставится на КОРЕНЬ ДОКУМЕНТА, а не на `#hud`, и это вынужденно:
   * контейнер сцены живёт вне дерева React, рядом с `#hud`. Переменную,
   * переопределённую на `#hud`, он бы не увидел, и поле осталось бы
   * прежней высоты под полосой другой.
   *
   * React трогает здесь корень документа, а не canvas: правило проекта
   * запрещает второе, а не первое.
   */
  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle('td-stats-closed', !statsOpen);
    return () => root.classList.remove('td-stats-closed');
  }, [statsOpen]);

  return (
    <div
      id="hud"
      data-testid="hud"
      data-local-player={String(localPlayer)}
      data-stats={statsOpen ? 'open' : 'closed'}
    >
      <div id="hud-top">
        <ConnectionLine />
        <TopBar />
        <Diagnostics />
      </div>

      <div id="hud-field">
        <FieldMessages />
        <StructureInfo />
        <MatchMenu />
        <ResultOverlay />
      </div>

      <div id="hud-bottom">
        <ActionBar />
      </div>
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────────
// Верхняя полоса
// ─────────────────────────────────────────────────────────────────────────

/**
 * Связь — строкой текста, а не панелью.
 *
 * Панель с рамкой и заголовком «СОЕДИНЕНИЕ» занимала угол экрана
 * и сообщала игроку четыре числа, три из которых ему ни о чём не говорят.
 * Осталось то, что действительно объясняет происходящее: жив ли канал,
 * сколько идёт пакет и через сколько исполнится нажатие.
 *
 * Время оборота и задержка ввода показаны по отдельности и слиты в одно
 * число быть не могут: первое измеряется, второе назначает сервер
 * по худшему из каналов, и одно из другого не выводится.
 *
 * Строка живёт в верхней полосе, то есть ВНЕ слоя поля. Поэтому её
 * не закрывает ни меню матча, ни итог: игрок видит состояние канала ровно
 * тогда, когда решает, ждать или выходить.
 */
const ConnectionLine = () => {
  const status = useHudStore((state) => state.status);
  const latency = useHudStore((state) => state.latencyMs);
  const inputTicks = useHudStore((state) => state.inputDelayTicks);
  const pending = useHudStore((state) => state.pendingCommands);

  return (
    <div
      data-testid="connection-status"
      data-status={status}
      style={{
        display: 'flex',
        justifyContent: 'flex-end',
        alignItems: 'center',
        gap: 'var(--td-space-2)',
        fontSize: 11,
        lineHeight: 1,
        color: 'var(--td-text-muted-3)',
        fontFamily: 'var(--td-font-mono)',
      }}
    >
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: '50%',
          background: statusColor[status],
          boxShadow: status === 'online' ? 'var(--td-glow-accent)' : 'none',
        }}
      />
      <span style={{ color: statusColor[status] }}>{statusLabel[status]}</span>
      <span>связь {latency} мс</span>
      {inputTicks > 0 && (
        <span data-testid="input-delay" data-ticks={String(inputTicks)}>
          ввод {Math.round(inputTicks * MS_PER_TICK)} мс
        </span>
      )}
      {pending > 0 && <span>в пути {pending}</span>}
    </div>
  );
};

/**
 * Верхняя полоса: слева своя сторона, справа соперник, между ними общее.
 *
 * Обе сводки прижаты к середине, а не к краям экрана. Так сравнение
 * «у него на восемь Тесл больше» делается глазом; прижатые к краям, они
 * стоили бы прохода взглядом через весь монитор, то есть не сравнивались бы
 * вовсе.
 *
 * Имена берутся из состояния сессии, а числа — из снимка матча, и смешивать
 * их источники нельзя: имя приходит из комнаты, игровой цикл о нём не знает
 * и знать не должен.
 */
const TopBar = () => {
  const localPlayer = useHudStore((state) => state.match.localPlayer);
  const sides = useHudStore((state) => state.match.sides);
  const unitCap = useHudStore((state) => state.match.unitCap);

  // Выбираются существующие поля по отдельности, а не собранный на лету
  // объект. Селектор, возвращающий каждый раз новый объект, для zustand
  // означает «состояние изменилось» — и компонент перерисовывается
  // бесконечно, пока React не снимет всё дерево. Проявляется это
  // не ошибкой в месте ошибки, а исчезнувшим интерфейсом.
  const ownName = useSessionStore((state) => state.profile?.name ?? 'Вы');
  const opponentName = useSessionStore((state) => state.view.match?.opponentName ?? 'Соперник');
  const opponentIsComputer = useSessionStore(
    (state) => state.view.match?.opponentIsComputer ?? false,
  );

  const own = sides[localPlayer] ?? EMPTY_SIDE;
  const enemy = sides[localPlayer === 0 ? 1 : 0] ?? EMPTY_SIDE;

  return (
    <div
      data-testid="match-bar"
      style={{
        display: 'grid',
        gridTemplateColumns: '1fr auto 1fr',
        alignItems: 'center',
        gap: 'var(--td-space-6)',
        flex: 1,
        minHeight: 0,
      }}
    >
      <SideStatus
        side={own}
        name={ownName}
        computer={false}
        own
        unitCap={unitCap}
        testId="side-own"
      />

      <CentreBlock />

      <SideStatus
        side={enemy}
        name={opponentName}
        computer={opponentIsComputer}
        own={false}
        unitCap={unitCap}
        testId="match-opponent"
        localSide={localPlayer}
      />
    </div>
  );
};

/**
 * Середина полосы: то, что относится к матчу, а не к стороне.
 *
 * Цель атаки здесь обязательна. Это единственный приказ, отдаваемый всему
 * войску сразу, и не видеть его — значит не знать, куда идёт своя армия.
 *
 * Режим атаки стоит рядом с целью, а не в нижнем тулбаре, где был раньше.
 * Оба — приказ всему войску сразу, отдаются вместе и читаются вместе;
 * тулбар же отвечает на другой вопрос — что заказать и что улучшить.
 */
const CentreBlock = () => {
  const energy = useHudStore((state) => state.match.energy);
  const income = useHudStore((state) => state.match.incomePerSecond);
  const targetLabel = useHudStore((state) => state.match.targetLabel);
  const seconds = useHudStore((state) => state.match.matchSeconds);

  const minutes = Math.floor(seconds / 60);
  const rest = Math.floor(seconds % 60);

  return (
    <div style={{ display: 'flex', gap: 'var(--td-space-6)', alignItems: 'baseline' }}>
      <Metric
        label="Энергия"
        value={
          // Энергия вздрагивает на любой отказ по бедности — неважно,
          // за юнита, постройку или улучшение не хватило.
          <Nudge reason={RejectReason.NotEnoughEnergy}>
            <span data-testid="energy">{energy}</span>
          </Nudge>
        }
        hint={`+${String(income)} / с`}
        accent
      />
      <Metric label="Цель" value={<span data-testid="target">{targetLabel}</span>} />
      <Metric label="Режим" value={<StanceSwitch />} />
      <Metric label="Время" value={`${String(minutes)}:${String(rest).padStart(2, '0')}`} />
    </div>
  );
};

/**
 * Режим атаки войска.
 *
 * Текущий виден всегда: это не разовое действие, а состояние, и игрок
 * обязан знать, в каком его войско сейчас находится.
 */
const StanceSwitch = () => {
  const stance = useHudStore((state) => state.match.stance);

  return (
    <span style={{ display: 'flex', gap: 'var(--td-space-1)' }}>
      {ATTACK_STANCES.map((option) => {
        const active = stance === option;

        return (
          <button
            key={option}
            type="button"
            data-testid={`stance-${String(option)}`}
            onClick={() => matchCommands().setStance(option)}
            style={{
              padding: '1px var(--td-space-2)',
              border: `1px solid ${active ? 'var(--td-accent)' : 'var(--td-border-control)'}`,
              borderRadius: 'var(--td-radius-control)',
              background: 'transparent',
              color: active ? 'var(--td-accent)' : 'var(--td-text-muted-3)',
              fontFamily: 'var(--td-font-ui)',
              fontSize: 'var(--td-text-sm)',
              cursor: 'pointer',
            }}
          >
            {ATTACK_STANCE_LABEL[option]}
          </button>
        );
      })}
    </span>
  );
};

interface MetricProps {
  readonly label: string;
  readonly value: ReactNode;
  readonly hint?: string | undefined;
  readonly accent?: boolean;
}

const Metric = ({ label, value, hint, accent }: MetricProps) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 74 }}>
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
 * Диагностические величины — в атрибутах, а не на экране.
 *
 * Игроку seed, номер тика и частота кадров не говорят ничего и занимают
 * внимание, которого в матче реального времени нет. Убрать их совсем тоже
 * нельзя: seed — единственное, чем снаружи проверяется, что у обоих
 * участников одна и та же карта, а тик с контрольной суммой — единственное
 * свидетельство того, что мир у них общий.
 *
 * Отдельным листом, а не на корне HUD, и это не педантизм. Корень,
 * подписанный на номер тика и частоту кадров, перерисовывал бы всё дерево
 * интерфейса пять раз в секунду. Здесь перерисовывается один пустой
 * элемент.
 */
const Diagnostics = () => {
  const seed = useHudStore((state) => state.seed);
  const visiblePercent = useHudStore((state) => state.visiblePercent);
  const rockPercent = useHudStore((state) => state.rockPercent);
  const tick = useHudStore((state) => state.tick);
  const fps = useHudStore((state) => state.fps);
  const pongCount = useHudStore((state) => state.pongCount);
  const syncTick = useHudStore((state) => state.syncTick);
  const syncChecksum = useHudStore((state) => state.syncChecksum);

  return (
    <div
      data-testid="diagnostics"
      data-seed={String(seed)}
      data-visible-percent={visiblePercent.toFixed(1)}
      data-rock-percent={rockPercent.toFixed(1)}
      data-tick={String(tick)}
      data-fps={String(fps)}
      data-pong-count={String(pongCount)}
      data-sync-tick={String(syncTick)}
      data-sync-checksum={String(syncChecksum)}
      style={{ position: 'absolute', width: 0, height: 0, overflow: 'hidden' }}
    />
  );
};

// ─────────────────────────────────────────────────────────────────────────
// Слой над полем
// ─────────────────────────────────────────────────────────────────────────

/**
 * Что происходит с матчем, когда на поле ничего не происходит.
 *
 * Ожидание соперника, восстановление после разрыва и расхождение
 * с сервером выглядят на экране одинаково: мир стоит. Разница для игрока
 * огромная, а молчание он справедливо примет за поломку.
 *
 * Обычная игра полосы не показывает вовсе: сообщать «всё хорошо» тому,
 * кто и так это видит, — значит приучить не читать полосу.
 */
const PHASE_TEXT: Partial<Record<MatchPhaseView, string>> = {
  connecting: 'подключение к матчу',
  'awaiting-opponent': 'ждём соперника',
  'catching-up': 'восстанавливаю матч по истории команд',
  desynced: 'расхождение с сервером — пересобираю мир',
  stopped: 'матч остановлен: расхождение не удалось устранить',
};

const PhaseBanner = () => {
  const phase = useHudStore((state) => state.phase);
  const progress = useHudStore((state) => state.catchUpProgress);
  const text = PHASE_TEXT[phase];

  if (text === undefined) return null;

  const withProgress =
    phase === 'catching-up' ? `${text} — ${String(Math.round(progress * 100))}%` : text;

  return (
    <div
      data-testid="match-phase"
      data-phase={phase}
      style={{
        padding: 'var(--td-space-1) var(--td-space-3)',
        borderRadius: 'var(--td-radius-control)',
        border: `1px solid ${phase === 'stopped' ? 'var(--td-error)' : 'var(--td-warning)'}`,
        background: 'var(--td-bg-overlay)',
        color: phase === 'stopped' ? 'var(--td-error)' : 'var(--td-warning)',
        fontSize: 11,
        letterSpacing: 'var(--td-ls-label)',
        textTransform: 'uppercase',
      }}
    >
      {withProgress}
    </div>
  );
};

/**
 * Состояние матча и отказы — под верхней полосой, но уже над полем.
 *
 * Прижаты к верху поля, а не к низу полосы: полоса может вырасти,
 * а привязка к полю не съедет никогда.
 */
const FieldMessages = () => (
  <div
    style={{
      position: 'absolute',
      top: 'var(--td-space-2)',
      left: '50%',
      transform: 'translateX(-50%)',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      gap: 'var(--td-space-2)',
      // Сообщения не должны перехватывать нажатия: игрок, промахнувшийся
      // мимо клетки, будет целиться туда же ещё раз.
      pointerEvents: 'none',
    }}
  >
    <PhaseBanner />
    <NoticeStack />
  </div>
);

// ─────────────────────────────────────────────────────────────────────────
// Меню матча
// ─────────────────────────────────────────────────────────────────────────

const overlayStyle: CSSProperties = {
  position: 'absolute',
  inset: 0,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 'var(--td-space-4)',
  background: 'var(--td-bg-overlay)',
};

const controlStyle: CSSProperties = {
  width: '100%',
  marginTop: 'var(--td-space-2)',
  fontSize: 'var(--td-text-sm)',
};

/**
 * Меню матча.
 *
 * Появилось затем, чтобы убрать с экрана три постоянные панели: выход,
 * перезапуск и перечень горячих клавиш висели слева весь матч и занимали
 * место, а нужны раз за партию.
 *
 * Открывается по Esc — то есть по клавише, которую игрок нажмёт в любом
 * случае. Но только тогда, когда отменять нечего: у Esc остаётся прежнее
 * первое значение «отменить режим», и отнимать его нельзя. Приоритетом
 * заведует управление, здесь мы только рисуем.
 */
const MatchMenu = () => {
  const open = useHudStore((state) => state.menuOpen);
  const computer = useSessionStore((state) => state.view.match?.opponentIsComputer ?? false);

  if (!open) return null;

  return (
    <div style={overlayStyle} data-testid="match-menu">
      <Panel title="Матч">
        <div style={{ width: 300 }}>
          {computer && (
            <Button
              variant="ghost"
              data-testid="restart"
              onClick={() => matchCommands().restart()}
              style={controlStyle}
            >
              Новый матч
            </Button>
          )}

          <LeaveButton
            testId="match-leave"
            variant="ghost"
            style={controlStyle}
            label="Выйти в меню"
          />

          <Button
            variant="ghost"
            data-testid="menu-close"
            onClick={() => matchCommands().setMenuOpen(false)}
            style={controlStyle}
          >
            Продолжить (Esc)
          </Button>

          <div style={{ marginTop: 'var(--td-space-4)' }}>
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
                <span
                  style={{ fontFamily: 'var(--td-font-mono)', color: 'var(--td-text-muted-1)' }}
                >
                  {hint.keys}
                </span>
                <span style={{ textAlign: 'right' }}>{hint.what}</span>
              </div>
            ))}
          </div>
        </div>
      </Panel>
    </div>
  );
};

interface LeaveButtonProps {
  readonly testId: string;
  readonly label: string;
  readonly variant?: 'ghost' | 'accent';
  readonly style?: CSSProperties;
}

/**
 * Выход из матча.
 *
 * Пока матч идёт, выход засчитывается поражением, и спросить об этом
 * обязательно. Иначе уход из матча стал бы способом не проиграть:
 * проигрывающий закрывал бы вкладку, и партия оставалась бы
 * незавершённой.
 *
 * После конца матча спрашивать не о чем — там выход просто выход.
 */
const LeaveButton = ({ testId, label, variant = 'ghost', style }: LeaveButtonProps) => {
  const finished = useHudStore((state) => state.outcome !== null);
  const [asking, setAsking] = useState(false);

  if (finished) {
    return (
      <Button
        variant={variant}
        data-testid={testId}
        style={style}
        onClick={() => {
          void sessionActions.leaveMatch();
        }}
      >
        {label}
      </Button>
    );
  }

  if (!asking) {
    return (
      <Button variant={variant} data-testid={testId} style={style} onClick={() => setAsking(true)}>
        {label}
      </Button>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--td-space-1)', ...style }}>
      <span data-testid="leave-warning" style={{ color: 'var(--td-warning)', fontSize: 11 }}>
        Выход засчитывается поражением
      </span>
      <div style={{ display: 'flex', gap: 'var(--td-space-2)' }}>
        <Button
          variant="accent"
          data-testid="leave-confirm"
          onClick={() => {
            void sessionActions.leaveMatch();
          }}
        >
          Сдаться
        </Button>
        <Button variant="ghost" data-testid="leave-cancel" onClick={() => setAsking(false)}>
          Играть дальше
        </Button>
      </div>
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────────
// Итог матча
// ─────────────────────────────────────────────────────────────────────────

/**
 * Итог матча.
 *
 * Перекрывает поле: матч закончен, и продолжать смотреть на него незачем.
 * Именно ПОЛЕ, а не экран целиком — верхняя полоса остаётся видна,
 * и по ней читается, чем всё кончилось: сколько войск осталось у обоих
 * и в каком состоянии базы.
 */
const OUTCOME_TEXT: Record<number, readonly [string, string]> = {
  [OutcomeReason.BaseDestroyed]: ['База противника разрушена', 'Ваша база разрушена'],
  [OutcomeReason.Disconnected]: [
    'Соперник не вернулся после разрыва связи',
    'Связь потеряна дольше отведённого времени',
  ],
  [OutcomeReason.NoShow]: ['Соперник не подключился к матчу', 'Вы не подключились к матчу'],
  [OutcomeReason.Left]: ['Соперник вышел из матча', 'Вы вышли из матча'],
};

const ResultOverlay = () => {
  // Исход берётся от сервера, а не из своего состояния мира. Свой мир
  // скажет только про разрушенную базу, а исход бывает и техническим:
  // соперник не вернулся, не пришёл или вышел сам.
  const outcome = useHudStore((state) => state.outcome);
  // Своя сторона, а не ноль. Играя второй стороной, игрок иначе читал бы
  // «ПОБЕДА» при собственном поражении — и наоборот.
  const localPlayer = useHudStore((state) => state.match.localPlayer);

  if (outcome === null) return null;

  const victory = outcome.winner === localPlayer;
  const texts = OUTCOME_TEXT[outcome.reason];
  const explanation = texts === undefined ? '' : victory ? texts[0] : texts[1];

  return (
    <div data-testid="result-overlay" style={overlayStyle}>
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
      <div data-testid="result-reason" style={{ color: 'var(--td-text-muted-2)' }}>
        {explanation}
      </div>

      <ResultActions />
    </div>
  );
};

/**
 * Действия после матча живут прямо здесь, а не в меню по Esc.
 *
 * Спрашивать после конца матча не о чем, и лишний шаг через меню был бы
 * помехой ровно там, где игрок хочет одного — сыграть ещё раз.
 */
const ResultActions = () => {
  const computer = useSessionStore((state) => state.view.match?.opponentIsComputer ?? false);

  return (
    <div style={{ display: 'flex', gap: 'var(--td-space-3)' }}>
      {computer && (
        <Button data-testid="restart-overlay" onClick={() => matchCommands().restart()}>
          Новый матч
        </Button>
      )}

      <LeaveButton testId="leave-overlay" label="В меню" variant={computer ? 'ghost' : 'accent'} />
    </div>
  );
};
