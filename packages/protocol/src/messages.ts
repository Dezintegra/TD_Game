/**
 * Версия протокола. Передаётся в заголовке каждого кадра.
 *
 * Зачем: после обновления сервера у части игроков в браузере ещё живёт
 * старый клиент. Без версии он будет молча слать несовместимые байты,
 * и мы получим загадочные падения. С версией — честная ошибка
 * "обновите страницу" в первую же секунду.
 *
 * Увеличивайте это число при любом изменении раскладки байтов.
 */
export const PROTOCOL_VERSION = 1;

export const MessageType = {
  Ping: 0,
  Pong: 1,
} as const;

export type MessageType = (typeof MessageType)[keyof typeof MessageType];

export interface PingMessage {
  readonly type: typeof MessageType.Ping;
  /** Номер тика клиента на момент отправки. */
  readonly tick: number;
  /** Порядковый номер запроса, чтобы сопоставить ответ с вопросом. */
  readonly nonce: number;
}

export interface PongMessage {
  readonly type: typeof MessageType.Pong;
  readonly tick: number;
  readonly nonce: number;
}

export type Message = PingMessage | PongMessage;

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
} as const;

export type DecodeError = (typeof DecodeError)[keyof typeof DecodeError];
