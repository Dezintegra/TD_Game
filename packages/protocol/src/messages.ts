import type { Command, UnownedCommand } from '@td/shared';

/**
 * Версия протокола. Передаётся в заголовке каждого кадра.
 *
 * Зачем: после обновления сервера у части игроков в браузере ещё живёт
 * старый клиент. Без версии он будет молча слать несовместимые байты,
 * и мы получим загадочные падения. С версией — честная ошибка
 * "обновите страницу" в первую же секунду.
 *
 * Увеличивайте это число при любом изменении раскладки байтов.
 *
 * Двойка появилась вместе с сетевым матчем: кадр перестал быть
 * десятибайтовым и фиксированным, а типов сообщений стало одиннадцать
 * вместо двух.
 *
 * Тройка — вместе с командой сноса: видов команд стало семь вместо шести,
 * и клиент прежней версии седьмую не разберёт.
 */
export const PROTOCOL_VERSION = 3;

/**
 * Типы сообщений.
 *
 * Направление указано у каждого и обязательно к соблюдению: сообщение,
 * пришедшее не с той стороны, — признак либо ошибки, либо чужого клиента,
 * и обрабатывать его нельзя. Проверяют направление `isFromClient`
 * и `isFromServer` ниже, а не память разработчика.
 */
export const MessageType = {
  /** ↔ Замер канала. Отправитель запоминает время, ответчик копирует поля. */
  Ping: 0,
  Pong: 1,
  /** → Вход в матч по билету. Первое сообщение участника. */
  Join: 2,
  /** → Команда участника. Стороны в ней нет: её проставит сервер. */
  Command: 3,
  /** → Просьба выдать историю команд начиная с тика. */
  HistoryFrom: 4,
  /** ← Ответ на вход: сторона, seed, текущий тик матча, задержка ввода. */
  Welcome: 5,
  /** ← Кадр тика: что именно исполняется на этом тике. */
  TickFrame: 6,
  /** ← Контрольная сумма состояния сервера на указанном тике. */
  Checksum: 7,
  /** ← Новая задержка ввода и тик, с которого она действует. */
  InputDelay: 8,
  /** ← Кусок истории команд. */
  History: 9,
  /** ← Исход матча. */
  MatchOver: 10,
} as const;

export type MessageType = (typeof MessageType)[keyof typeof MessageType];

/**
 * Длина билета на вход в матч, в байтах, и она же в шестнадцатеричных
 * символах.
 *
 * Билет ходит по двум каналам сразу: по HTTP он приезжает строкой внутри
 * JSON, по WebSocket — шестнадцатью байтами. Поэтому в типах он строка,
 * а в кадре — байты, и обе длины закреплены здесь вместе, чтобы
 * не разъехаться.
 */
export const TICKET_BYTES = 16;
export const TICKET_CHARS = TICKET_BYTES * 2;

/**
 * Почему матч закончился.
 *
 * Перечисление, а не строка, по той же причине, что и `RejectReason`
 * в ядре: причину показывают, переводят и считают в статистике,
 * и всё это ломается о свободный текст.
 */
export const OutcomeReason = {
  /** База одного из игроков разрушена — обычная победа. */
  BaseDestroyed: 0,
  /** Участник не вернулся после разрыва связи. */
  Disconnected: 1,
  /** Участник не подключился к начавшемуся матчу. */
  NoShow: 2,
  /** Участник вышел из матча сам. */
  Left: 3,
} as const;

export type OutcomeReason = (typeof OutcomeReason)[keyof typeof OutcomeReason];

/**
 * Коды закрытия соединения.
 *
 * Отдельного сообщения «вход отклонён» нет намеренно. Устаревшему клиенту
 * такое сообщение не помогло бы: он не сумеет его разобрать — раскладка
 * байтов у него другая, и первый же байт версии заставит его отвергнуть
 * кадр. Код закрытия WebSocket читается любой версией клиента, потому что
 * не зависит от нашего протокола вовсе.
 *
 * Диапазон 4000–4999 отведён стандартом под коды приложения.
 */
export const CloseCode = {
  VersionMismatch: 4001,
  BadTicket: 4003,
  BadFrame: 4004,
} as const;

export type CloseCode = (typeof CloseCode)[keyof typeof CloseCode];

export interface PingMessage {
  readonly type: typeof MessageType.Ping;
  /** Номер тика отправителя на момент отправки. */
  readonly tick: number;
  /** Порядковый номер запроса, чтобы сопоставить ответ с вопросом. */
  readonly nonce: number;
}

export interface PongMessage {
  readonly type: typeof MessageType.Pong;
  readonly tick: number;
  readonly nonce: number;
}

export interface JoinMessage {
  readonly type: typeof MessageType.Join;
  /** Билет из `MatchView`, шестнадцатеричной строкой. */
  readonly ticket: string;
}

export interface CommandMessage {
  readonly type: typeof MessageType.Command;
  /** Тик, на который участник просит исполнить команду. */
  readonly command: UnownedCommand;
}

export interface HistoryFromMessage {
  readonly type: typeof MessageType.HistoryFrom;
  readonly tick: number;
}

export interface WelcomeMessage {
  readonly type: typeof MessageType.Welcome;
  /** Сторона в симуляции: 0 или 1. */
  readonly side: number;
  readonly seed: number;
  /** Тик, на котором матч находится сейчас. Ноль — матч ещё не начался. */
  readonly tick: number;
  readonly delayTicks: number;
}

export interface TickFrameMessage {
  readonly type: typeof MessageType.TickFrame;
  readonly tick: number;
  /** Команды, исполняемые на этом тике. Обычно список пуст. */
  readonly commands: readonly Command[];
}

export interface ChecksumMessage {
  readonly type: typeof MessageType.Checksum;
  readonly tick: number;
  readonly value: number;
}

export interface InputDelayMessage {
  readonly type: typeof MessageType.InputDelay;
  readonly delayTicks: number;
  /** С какого тика действует новая задержка. */
  readonly fromTick: number;
}

export interface HistoryMessage {
  readonly type: typeof MessageType.History;
  readonly fromTick: number;
  /** По какой тик включительно выдан этот кусок истории. */
  readonly throughTick: number;
  readonly commands: readonly Command[];
}

export interface MatchOverMessage {
  readonly type: typeof MessageType.MatchOver;
  /** Сторона победителя; `null` — победителя нет. */
  readonly winner: number | null;
  readonly reason: OutcomeReason;
}

export type ClientMessage = PingMessage | PongMessage | JoinMessage | CommandMessage | HistoryFromMessage;

export type ServerMessage =
  | PingMessage
  | PongMessage
  | WelcomeMessage
  | TickFrameMessage
  | ChecksumMessage
  | InputDelayMessage
  | HistoryMessage
  | MatchOverMessage;

export type Message = ClientMessage | ServerMessage;

export const isFromClient = (message: Message): message is ClientMessage =>
  message.type === MessageType.Ping ||
  message.type === MessageType.Pong ||
  message.type === MessageType.Join ||
  message.type === MessageType.Command ||
  message.type === MessageType.HistoryFrom;

export const isFromServer = (message: Message): message is ServerMessage =>
  message.type === MessageType.Ping ||
  message.type === MessageType.Pong ||
  message.type === MessageType.Welcome ||
  message.type === MessageType.TickFrame ||
  message.type === MessageType.Checksum ||
  message.type === MessageType.InputDelay ||
  message.type === MessageType.History ||
  message.type === MessageType.MatchOver;

/**
 * Результат декодирования.
 *
 * Декодер намеренно не бросает исключения: данные приходят из сети,
 * то есть от потенциально враждебного или просто устаревшего клиента.
 * Битый кадр — штатная ситуация, а не аварийная, и обрабатывать её
 * должен обычный if, а не try/catch на горячем пути.
 */
export type DecodeResult =
  | { readonly ok: true; readonly message: Message }
  | { readonly ok: false; readonly error: DecodeError };

export const DecodeError = {
  TooShort: 'too-short',
  VersionMismatch: 'version-mismatch',
  UnknownType: 'unknown-type',
  /** Длина кадра не сходится с числом объявленных в нём записей. */
  LengthMismatch: 'length-mismatch',
  /** Вид команды, направление, тип юнита, клетка или ветка вне диапазона. */
  BadField: 'bad-field',
} as const;

export type DecodeError = (typeof DecodeError)[keyof typeof DecodeError];
