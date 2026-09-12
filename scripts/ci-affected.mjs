import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const serviceDirectories = ['supervisor/', 'manage/', 'docs/', 'openspec/', '.agents/', '.claude/'];

export function needsGameChecks(paths) {
  // Новые и неизвестные области включают игру, пока их независимость не установлена.
  return paths.some(
    (path) =>
      !serviceDirectories.some((directory) => path.startsWith(directory)) &&
      !/^[^/]+\.md$/i.test(path),
  );
}

export function detectChanges(eventName, event, cwd = process.cwd()) {
  try {
    const base = eventName === 'pull_request' ? event.pull_request?.base?.sha : event.before;
    const head = eventName === 'pull_request' ? event.pull_request?.head?.sha : event.after;
    if (
      !['pull_request', 'push'].includes(eventName) ||
      ![base, head].every((sha) => /^[a-f0-9]{40}$/i.test(sha) && !/^0+$/.test(sha))
    ) {
      throw new Error('Нет поддерживаемой пары коммитов');
    }
    const range = eventName === 'pull_request' ? `${base}...${head}` : `${base}..${head}`;
    // Без распознавания переименований Git перечисляет удалённый и новый пути.
    const paths = execFileSync('git', ['diff', '--name-only', '--no-renames', '-z', range, '--'], {
      cwd,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
      .split('\0')
      .filter(Boolean);
    const game = needsGameChecks(paths);
    return {
      game,
      reason: game ? 'Затронуты игровые или неизвестные пути' : 'Только служебные пути',
      count: paths.length,
    };
  } catch {
    // Неполные сведения не должны давать зелёный свет непроверенной игре.
    return { game: true, reason: 'Diff недоступен: выполняется полный набор', count: null };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let result;
  try {
    result = detectChanges(
      process.env.GITHUB_EVENT_NAME,
      JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')),
    );
  } catch {
    result = { game: true, reason: 'Событие недоступно: выполняется полный набор', count: null };
  }
  console.log(JSON.stringify(result));
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `game=${result.game}\n`);
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `Игровые проверки: **${result.game ? 'запуск' : 'пропуск'}**. ${result.reason}. Изменённых путей: ${result.count ?? 'неизвестно'}.\n`,
    );
  }
}
