const portKeys = { '--client-port': 'clientPort', '--port': 'serverPort' };

function portNumber(value, source) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${source}: ожидается целый порт от 1 до 65535`);
  }
  return port;
}

export function parsePerfOptions(argv) {
  const ports = {};
  const passthrough = [];
  const modes = { checkOnly: false, force: false, history: false };
  const modeKeys = { '--check-only': 'checkOnly', '--force': 'force', '--history': 'history' };
  for (let i = argv[0] === '--' ? 1 : 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--') {
      passthrough.push(...argv.slice(i));
      break;
    }
    const equal = token.indexOf('=');
    const key = equal < 0 ? token : token.slice(0, equal);
    if (Object.hasOwn(portKeys, key)) {
      const name = portKeys[key];
      if (Object.hasOwn(ports, name)) throw new Error(`${key}: повтор ключа`);
      const value = equal < 0 ? argv[++i] : token.slice(equal + 1);
      if (typeof value !== 'string' || !/^[0-9]+$/.test(value)) {
        throw new Error(`${key}: ожидается непустое десятичное значение порта`);
      }
      ports[name] = portNumber(value, key);
    } else if (Object.hasOwn(modeKeys, token)) {
      modes[modeKeys[token]] = true;
    } else {
      passthrough.push(token);
    }
  }
  return { ports, passthrough, ...modes };
}

export function resolvePerfPorts(ports, env) {
  const clientPort = ports.clientPort ?? portNumber(env.CLIENT_PORT ?? 5173, 'CLIENT_PORT');
  const serverPort = ports.serverPort ?? portNumber(env.PORT ?? 3001, 'PORT');
  const metricsPort = portNumber(
    env.COMPUTER_METRICS_PORT ?? serverPort + 1,
    'COMPUTER_METRICS_PORT',
  );
  if (new Set([clientPort, serverPort, metricsPort]).size !== 3) {
    throw new Error('CLIENT_PORT, PORT и COMPUTER_METRICS_PORT должны различаться');
  }
  return {
    clientPort,
    serverPort,
    metricsPort,
    env: {
      ...env,
      CLIENT_PORT: String(clientPort),
      PORT: String(serverPort),
      COMPUTER_METRICS_PORT: String(metricsPort),
      VITE_API_URL: `http://127.0.0.1:${serverPort}`,
      VITE_WS_URL: `ws://127.0.0.1:${serverPort}/game`,
      COMPUTER_API_URL: `http://127.0.0.1:${serverPort}`,
      COMPUTER_WS_URL: `ws://127.0.0.1:${serverPort}/game`,
    },
  };
}
