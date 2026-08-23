#!/usr/bin/env node
/**
 * Выкладка игры на боевой сервер.
 *
 *   pnpm run deploy                 выложить последний коммит текущей ветки
 *   pnpm run deploy -- --ref main   выложить конкретную ревизию
 *   pnpm run deploy -- --dirty      выложить рабочее дерево как есть
 *   pnpm run deploy -- --help       разбор ключей
 *
 * Сборка идёт НА СЕРВЕРЕ, а не здесь. Причина в скорости: наверх уезжают
 * шесть мегабайт исходников, тогда как готовые образы весят под четыреста,
 * а исходящий канал у рабочей машины всегда уже входящего. Плюс у сервера
 * свой кеш слоёв, и повторная выкладка не переустанавливает зависимости.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ── Ключи ────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);

if (argv.includes('--help') || argv.includes('-h')) {
  console.log(
    [
      'Выкладка игры на боевой сервер.',
      '',
      '  --ref <ревизия>   что выкладывать (по умолчанию HEAD)',
      '  --dirty           выложить рабочее дерево, не дожидаясь коммита',
      '  --host <алиас>    куда (по умолчанию dezintegra или $TD_DEPLOY_HOST)',
      '  --dir <каталог>   каталог на сервере (по умолчанию td)',
      '  --no-cache        собрать образы с нуля, не доверяя кешу слоёв',
      '  --no-perf         выложить без замера частоты кадров (осознанно!)',
      '',
      'Пример: pnpm run deploy -- --ref origin/main',
    ].join('\n'),
  );
  process.exit(0);
}

const flag = (name, fallback) => {
  const at = argv.indexOf(name);
  return at !== -1 && argv[at + 1] ? argv[at + 1] : fallback;
};

const host = flag('--host', process.env.TD_DEPLOY_HOST ?? 'dezintegra');
const remoteDir = flag('--dir', 'td');
const dirty = argv.includes('--dirty');
const noCache = argv.includes('--no-cache');
const skipPerf = argv.includes('--no-perf');
let ref = flag('--ref', 'HEAD');

// ── Мелкие помощники ─────────────────────────────────────────────────
const step = (text) => console.log(`\n\u001b[36m▸\u001b[0m ${text}`);
const note = (text) => console.log(`  ${text}`);
const die = (text) => {
  console.error(`\n\u001b[31m✗\u001b[0m ${text}\n`);
  process.exit(1);
};

/** Тихий запуск: возвращает stdout строкой, кидает при ненулевом коде. */
const capture = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { encoding: 'utf8', ...opts }).trim();

/** Шумный запуск: вывод идёт игроку на экран сразу, как есть. */
const run = (cmd, args, opts = {}) => {
  const result = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (result.error) die(`не удалось запустить ${cmd}: ${result.error.message}`);
  if (result.status !== 0) die(`${cmd} завершился с кодом ${result.status}`);
};

// ── Проверки до того, как что-то трогать ─────────────────────────────
let root;
try {
  root = capture('git', ['rev-parse', '--show-toplevel']);
} catch {
  die('это не репозиторий git — запускать надо из дерева проекта');
}

step(`Проверяю связь с сервером «${host}»`);
const reach = spawnSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', host, 'true'], {
  stdio: 'ignore',
});
if (reach.status !== 0) {
  die(
    `сервер «${host}» не отвечает.\n` +
      `  Проверьте: ssh ${host}\n` +
      `  Если машина прерываемая, облако могло её остановить:\n` +
      `  yc compute instance start td`,
  );
}
note('связь есть');

// Docker-файлы лежат в дереве, но в репозиторий их пока не закоммитили.
// Поэтому они добавляются в архив отдельно, поверх выгрузки из git.
// Когда их закоммитят, этот список станет лишним — но не вредным.
const dockerFiles = ['Dockerfile', 'docker-compose.yml', '.dockerignore', '.env.example', 'docker'];
const missing = dockerFiles.filter((name) => !existsSync(join(root, name)));
if (missing.length > 0) die(`в дереве нет файлов сборки: ${missing.join(', ')}`);

// ── Замер частоты кадров ─────────────────────────────────────────────
//
// Шаг обязательный, и вот почему он именно здесь, а не в CI. На runner'ах
// GitHub видеокарты нет: Chromium рисует программно и выдаёт около
// шестнадцати кадров на любой сцене, так что порог 55 там недостижим
// в принципе. Значит единственное место, где просадку отрисовки вообще
// можно поймать, — живая машина, и последний момент, когда это ещё
// дёшево, — прямо перед выкладкой. После неё просадку увидит игрок.
//
// Обёртка сама откажется мерить на занятой машине: цифра, снятая под
// нагрузкой, говорит о нагрузке, а не о коде.
if (skipPerf) {
  note('ВНИМАНИЕ: замер частоты кадров пропущен по ключу --no-perf');
} else {
  step('Замеряю частоту кадров перед выкладкой');
  run('pnpm', ['e2e:perf'], { cwd: root, shell: true });
  note('отрисовка держит порог');
}

// ── Что именно выкладываем ───────────────────────────────────────────
if (dirty) {
  // `git stash create` лепит из рабочего дерева обычный коммит и отдаёт
  // его хеш, ничего при этом не меняя ни в дереве, ни в ветке. Дерево
  // остаётся ровно таким, каким было, — в отличие от обычного stash.
  const snapshot = capture('git', ['stash', 'create']);
  if (snapshot) {
    ref = snapshot;
    note('выкладывается рабочее дерево (несохранённые правки включены)');
  } else {
    note('несохранённых правок нет — выкладывается HEAD');
  }
}

const revision = capture('git', ['rev-parse', '--short', ref]);
const subject = capture('git', ['log', '-1', '--format=%s', ref]);
step(`Выкладываю ${revision} — ${subject}`);

// ── Архив ────────────────────────────────────────────────────────────
const work = mkdtempSync(join(tmpdir(), 'td-deploy-'));
const tarball = join(work, 'td-src.tar');

try {
  step('Собираю архив исходников');
  run('git', ['archive', '--format=tar', '-o', tarball, ref], { cwd: root });
  // Имя архива передаётся коротким, а каталог задаётся через cwd —
  // и это не стилистика. В Windows таких tar два: bsdtar из системы
  // и GNU tar, который приезжает с Git и оказывается первым в PATH
  // внутри Git Bash. GNU tar разбирает «C:/путь» после -f как «хост C,
  // путь после двоеточия» — наследие лент, писавшихся по сети, — и
  // падает с «Cannot connect to C: resolve failed». Без двоеточия
  // в имени этой беды нет ни у одного из них. Ключ -r дописывает
  // файлы в уже готовый несжатый архив.
  run('tar', ['-rf', 'td-src.tar', '-C', root, ...dockerFiles], { cwd: work });
  note('архив готов');

  step('Заливаю на сервер');
  run('scp', ['-o', 'BatchMode=yes', '-q', tarball, `${host}:~/td-src.tar`]);
  note('залито');

  // ── Раскладка на сервере ───────────────────────────────────────────
  //
  // Распаковка идёт в новый каталог, а не поверх старого: иначе файлы,
  // удалённые в репозитории, оставались бы на сервере вечно и попадали
  // в контекст сборки. Предыдущая выкладка сохраняется рядом как
  // `<каталог>.prev` — на случай, если новая окажется хуже.
  //
  // `.env` переносится из прежней выкладки, а не перезаписывается:
  // в нём боевые настройки, и они не обязаны совпадать с примером.
  const remoteScript = [
    'set -e',
    `cd ~`,
    `rm -rf ${remoteDir}.new`,
    `mkdir -p ${remoteDir}.new`,
    `tar -xf ~/td-src.tar -C ${remoteDir}.new`,
    `if [ -f ${remoteDir}/.env ]; then cp ${remoteDir}/.env ${remoteDir}.new/.env; else`,
    `  cp ${remoteDir}.new/.env.example ${remoteDir}.new/.env`,
    `fi`,
    `rm -rf ${remoteDir}.prev`,
    `if [ -d ${remoteDir} ]; then mv ${remoteDir} ${remoteDir}.prev; fi`,
    `mv ${remoteDir}.new ${remoteDir}`,
    `rm -f ~/td-src.tar`,
    `cd ~/${remoteDir}`,
    `docker compose up --build -d${noCache ? ' --force-recreate' : ''}`,
    // Обязательный перезапуск прокси, а не перестраховка. nginx узнаёт
    // адрес сервера один раз, при старте, и запоминает навсегда
    // (см. комментарий в docker/nginx.conf.template). Если обновился образ
    // сервера, compose пересоздаст его одного, выдаст новый адрес в сети
    // — и прокси будет стучаться в пустоту, отдавая 502 на живой игре.
    // Секунда простоя при выкладке дешевле такой поломки.
    'docker compose restart web > /dev/null',
    // Слои от прошлых сборок съедают диск, а его на машине двадцать
    // гигабайт. Убираем только висячие образы: те, на которые никто
    // не ссылается по имени.
    'docker image prune -f > /dev/null',
  ].join('\n');

  step('Собираю и поднимаю на сервере (это самая долгая часть)');
  run('ssh', ['-o', 'BatchMode=yes', host, remoteScript]);

  // ── Проверка ───────────────────────────────────────────────────────
  //
  // Стучимся по настоящему домену и по HTTPS, а не по 127.0.0.1: голый
  // HTTP теперь только перенаправляет, а сертификат выписан на имя —
  // обращение по адресу петли его бы не прошло. Домен спрашиваем
  // у серверного .env: он там единственный источник правды.
  step('Проверяю, что игра отвечает');
  const domain = capture('ssh', [
    '-o',
    'BatchMode=yes',
    host,
    `sh -c '. ~/${remoteDir}/.env && printf %s "$TD_DOMAIN"'`,
  ]);
  if (!domain) die(`в ~/${remoteDir}/.env на сервере не задан TD_DOMAIN`);

  const health = capture('ssh', [
    '-o',
    'BatchMode=yes',
    host,
    `curl -fsS --retry 10 --retry-delay 2 --retry-all-errors https://${domain}/health`,
  ]);
  note(`сервер отвечает: ${health}`);

  const page = capture('ssh', [
    '-o',
    'BatchMode=yes',
    host,
    `curl -s -o /dev/null -w '%{http_code}' https://${domain}/`,
  ]);
  if (page !== '200') die(`страница игры отдала HTTP ${page}, а должна 200`);
  note('страница игры отдаётся, сертификат принят');

  console.log(`\n\u001b[32m✓\u001b[0m Готово: ${revision} играет на https://${domain}/\n`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
