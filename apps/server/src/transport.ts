/**
 * Интерфейс транспорта — граница между игровой логикой и сетевой библиотекой.
 *
 * Сейчас под ним лежит библиотека `ws`. Она удобна и ставится без нативной
 * сборки, что важно при разработке на Windows. Под нагрузкой её, скорее всего,
 * захочется заменить на uWebSockets.js, который заметно быстрее, но требует
 * нативного модуля.
 *
 * Чтобы такая замена не превратилась в переписывание половины сервера,
 * игровой код общается только с этим интерфейсом и ничего не знает
 * про конкретную библиотеку.
 */
export interface ConnectionId {
  readonly value: number;
}

export interface GameTransport {
  /** Отправляет бинарный кадр одному соединению. */
  send(connection: ConnectionId, frame: ArrayBuffer): void;
  /** Отправляет бинарный кадр всем подключённым. */
  broadcast(frame: ArrayBuffer): void;
  /**
   * Закрывает соединение, по возможности назвав причину кодом.
   *
   * Код нужен там, где сообщением объясниться нельзя: клиенту с чужой
   * версией протокола наш кадр не разобрать по определению, а код
   * закрытия читается любой версией, потому что не зависит от протокола
   * вовсе.
   */
  close(connection: ConnectionId, code?: number): void;
  /** Количество активных соединений. */
  readonly connectionCount: number;
}

export interface TransportHandlers {
  onConnect(connection: ConnectionId): void;
  onMessage(connection: ConnectionId, frame: ArrayBuffer): void;
  onDisconnect(connection: ConnectionId): void;
}
