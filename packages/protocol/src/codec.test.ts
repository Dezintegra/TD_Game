import { describe, expect, it } from 'vitest';
import { decode, encode } from './codec.js';
import { DecodeError, MessageType, PROTOCOL_VERSION } from './messages.js';
import type { Message } from './messages.js';

describe('бинарный кодек', () => {
  it('round-trip: раскодированное сообщение равно исходному', () => {
    const messages: Message[] = [
      { type: MessageType.Ping, tick: 0, nonce: 0 },
      { type: MessageType.Pong, tick: 1200, nonce: 7 },
      { type: MessageType.Ping, tick: 4294967295, nonce: 4294967295 },
    ];

    for (const message of messages) {
      const result = decode(encode(message));
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.message).toEqual(message);
    }
  });

  it('укладывается в 10 байт', () => {
    expect(encode({ type: MessageType.Ping, tick: 1, nonce: 1 }).byteLength).toBe(10);
  });

  it('отклоняет слишком короткий кадр', () => {
    const result = decode(new ArrayBuffer(4));
    expect(result).toEqual({ ok: false, error: DecodeError.TooShort });
  });

  it('отклоняет кадр с чужой версией протокола', () => {
    const buffer = encode({ type: MessageType.Ping, tick: 1, nonce: 1 });
    new DataView(buffer).setUint8(0, PROTOCOL_VERSION + 1);

    expect(decode(buffer)).toEqual({ ok: false, error: DecodeError.VersionMismatch });
  });

  it('отклоняет неизвестный тип сообщения', () => {
    const buffer = encode({ type: MessageType.Ping, tick: 1, nonce: 1 });
    new DataView(buffer).setUint8(1, 99);

    expect(decode(buffer)).toEqual({ ok: false, error: DecodeError.UnknownType });
  });

  it('не бросает исключение на мусорных данных', () => {
    const garbage = new Uint8Array([255, 255, 255, 255, 255, 255, 255, 255, 255, 255]);
    expect(() => decode(garbage.buffer)).not.toThrow();
  });
});
