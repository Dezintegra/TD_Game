import { DecodeError, MessageType, PROTOCOL_VERSION } from './messages.js';
import type { DecodeResult, Message } from './messages.js';

/**
 * Бинарный кодек поверх ArrayBuffer.
 *
 * Почему не JSON. В матче пакеты уходят каждый тик, то есть 30 раз
 * в секунду на игрока. JSON здесь платит дважды: сообщение вида
 * {"type":"ping","tick":1200,"nonce":7} занимает около 40 байт против 10
 * в бинарном виде, и каждый пакет требует разбора строки, что порождает
 * мусор для сборщика и микрофризы ровно там, где нужна плавность.
 *
 * Раскладка кадра (little-endian, как во всех современных процессорах):
 *   байт 0     — версия протокола (uint8)
 *   байт 1     — тип сообщения (uint8)
 *   байты 2-5  — номер тика (uint32)
 *   байты 6-9  — nonce (uint32)
 *
 * Итого 10 байт на сообщение фиксированной длины.
 */
const HEADER_SIZE = 2;
const FRAME_SIZE = HEADER_SIZE + 8;

export const encode = (message: Message): ArrayBuffer => {
  const buffer = new ArrayBuffer(FRAME_SIZE);
  const view = new DataView(buffer);

  view.setUint8(0, PROTOCOL_VERSION);
  view.setUint8(1, message.type);
  view.setUint32(2, message.tick, true);
  view.setUint32(6, message.nonce, true);

  return buffer;
};

export const decode = (buffer: ArrayBuffer): DecodeResult => {
  if (buffer.byteLength < FRAME_SIZE) {
    return { ok: false, error: DecodeError.TooShort };
  }

  const view = new DataView(buffer);

  if (view.getUint8(0) !== PROTOCOL_VERSION) {
    return { ok: false, error: DecodeError.VersionMismatch };
  }

  const type = view.getUint8(1);
  if (type !== MessageType.Ping && type !== MessageType.Pong) {
    return { ok: false, error: DecodeError.UnknownType };
  }

  return {
    ok: true,
    message: {
      type,
      tick: view.getUint32(2, true),
      nonce: view.getUint32(6, true),
    },
  };
};
