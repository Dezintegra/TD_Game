# syntax=docker/dockerfile:1

##
# Боевая сборка. Из одного файла выходят два образа:
#
#   --target server  — игровой сервер на Node: HTTP для комнат и
#                      WebSocket для матча;
#   --target web     — nginx: раздаёт собранного клиента и он же
#                      обратный прокси к серверу.
#
# Клиент за nginx, а не за `vite preview`, потому что preview — отладочный
# сервер: он не умеет ни сжатия, ни кэш-заголовков, ни проксирования
# сокета, и авторы Vite прямо просят не выносить его в бой.
#
# Обратный прокси нужен не ради красоты. Адреса сервера вшиваются
# в клиентский бандл на сборке (`import.meta.env` — это подстановка
# текста, а не чтение переменной в браузере). Если сложить страницу
# и API на один адрес, вшивать становится нечего: пути относительные,
# и один и тот же образ работает и на localhost, и на боевом домене.
##

ARG NODE_IMAGE=node:22-alpine
ARG NGINX_IMAGE=nginx:alpine

# ── Основание ────────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS base

# Corepack поднимает ровно ту pnpm, что записана в package.json
# → packageManager. Версия не дублируется в Dockerfile: разъезжаться
# нечему. Запрет на вопрос о загрузке обязателен — в сборке нет tty,
# и вопрос превратился бы в зависание.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    TURBO_TELEMETRY_DISABLED=1 \
    DO_NOT_TRACK=1 \
    CI=1

RUN corepack enable
WORKDIR /app

# ── Манифесты ────────────────────────────────────────────────────────
# Отдельный слой ради кэша: правка исходника его не трогает, и установка
# зависимостей — самый долгий шаг — повторяется только при смене
# package.json или локфайла.
#
# Перечислены все пакеты рабочего пространства, включая ненужную серверу
# арену: `--frozen-lockfile` сверяет локфайл с манифестами и падает,
# если хоть один из них не на месте.
FROM base AS manifests

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/arena/package.json apps/arena/
COPY apps/client/package.json apps/client/
COPY apps/computer/package.json apps/computer/
COPY apps/server/package.json apps/server/
COPY packages/ai/package.json packages/ai/
COPY packages/bot/package.json packages/bot/
COPY packages/netplay/package.json packages/netplay/
COPY packages/protocol/package.json packages/protocol/
COPY packages/shared/package.json packages/shared/
COPY packages/sim/package.json packages/sim/
COPY packages/ui/package.json packages/ui/

# ── Зависимости для сборки ───────────────────────────────────────────
FROM manifests AS deps

RUN --mount=type=cache,id=td-pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --store-dir=/pnpm/store

# ── Сборка ───────────────────────────────────────────────────────────
FROM deps AS build

COPY . .

# Куда клиенту стучаться. Пусто и /game — это «туда же, откуда пришла
# страница»: относительный путь разрешается браузером относительно
# адреса страницы, а WebSocket при этом сам меняет http на ws
# (и https на wss — за TLS отдельно думать не нужно).
ARG VITE_API_URL=""
ARG VITE_WS_URL="/game"
ENV VITE_API_URL=${VITE_API_URL} \
    VITE_WS_URL=${VITE_WS_URL}

# Фильтр, а не `pnpm build`: арена — исследовательский инструмент,
# в бою её нет. Зависимости целей turbo подтянет сам.
RUN pnpm exec turbo run build --filter=@td/server --filter=@td/computer --filter=@td/client

# ── Зависимости для боя ──────────────────────────────────────────────
# Отдельная установка с `--prod`: в образ сервера не должны попасть
# ни typescript, ни vite, ни vitest — это сотни мегабайт, которые
# в бою не исполняются, но исправно расширяют поверхность атаки.
#
# Фильтра два: в образе живут ОБА приложения на Node — игровой сервер
# и служба компьютерных дежурных. Образ один, команда запуска разная.
# Так развёртывание не платит вторым деревом зависимостей за то, что
# до недавнего времени было одним процессом.
FROM manifests AS prod-deps

RUN --mount=type=cache,id=td-pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --store-dir=/pnpm/store \
    --filter @td/server... --filter @td/computer...

# ── Образ сервера ────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS server

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3001 \
    MATCHLOG_DIR=/data/matchlog

WORKDIR /app

# Сперва зависимости и манифесты (меняются редко), затем свежий код.
COPY --from=prod-deps --chown=node:node /app ./

# Пакеты приезжают собранными: их package.json указывают на dist,
# а компилятора в этом образе уже нет.
COPY --from=build --chown=node:node /app/packages/shared/dist ./packages/shared/dist
COPY --from=build --chown=node:node /app/packages/sim/dist ./packages/sim/dist
COPY --from=build --chown=node:node /app/packages/protocol/dist ./packages/protocol/dist
COPY --from=build --chown=node:node /app/packages/netplay/dist ./packages/netplay/dist
COPY --from=build --chown=node:node /app/packages/ai/dist ./packages/ai/dist
COPY --from=build --chown=node:node /app/packages/bot/dist ./packages/bot/dist
COPY --from=build --chown=node:node /app/apps/server/dist ./apps/server/dist
COPY --from=build --chown=node:node /app/apps/computer/dist ./apps/computer/dist

# Каталог записей создаётся здесь и с нужным владельцем: том, который
# Docker подставит на его место, наследует права первого монтирования.
# Создай его позже — и сервер под пользователем node упрётся в чужой root.
RUN mkdir -p /data/matchlog && chown -R node:node /data

USER node
EXPOSE 3001

# Проверка живости — тем самым /health, что уже есть у сервера.
# wget взят из busybox: он в alpine есть всегда, curl пришлось бы ставить.
#
# Служба дежурных запускается из ЭТОГО ЖЕ образа другой командой,
# и живость у неё своя. Объявлена она в docker-compose.yml рядом
# с командой: здесь эти два запуска ещё не различить.
HEALTHCHECK --interval=15s --timeout=3s --start-period=15s --retries=3 \
    CMD wget --quiet --spider http://127.0.0.1:3001/health || exit 1

# Умолчание — игровой сервер. Служба дежурных поднимается тем же образом
# с другой командой (см. docker-compose.yml).
CMD ["node", "apps/server/dist/main.js"]

# ── Образ веба ───────────────────────────────────────────────────────
FROM ${NGINX_IMAGE} AS web

# Шаблон, а не готовый конфиг: в путях к сертификату стоит имя домена,
# и вписывать его в образ нельзя — образ один, а доменов у него может
# быть сколько угодно. Официальный образ nginx сам прогоняет всё из
# /etc/nginx/templates через envsubst при старте и кладёт в conf.d.
COPY docker/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY docker/security-headers.conf /etc/nginx/snippets/security-headers.conf
# Права на файл ставятся здесь, а не хранятся в репозитории: рабочее
# дерево может лежать на файловой системе Windows, где бита «исполняемый»
# нет вовсе, и скрипт молча не запустился бы.
COPY docker/nginx-reload-loop.sh /docker-entrypoint.d/99-reload-loop.sh
RUN chmod +x /docker-entrypoint.d/99-reload-loop.sh
# Заглушка из образа лежит ровно там, куда шаблон положит результат.
# Убираем заранее: спокойнее, когда файл появляется, а не переписывается.
RUN rm -f /etc/nginx/conf.d/default.conf
# Со страницей-заглушкой из образа nginx игра ужиться не должна:
# её index.html перекрыл бы наш при любой ошибке копирования.
RUN rm -rf /usr/share/nginx/html/*
COPY --from=build /app/apps/client/dist /usr/share/nginx/html

EXPOSE 80
EXPOSE 443

# Проверка идёт по голому HTTP на служебный адрес, а не на index.html:
# после перехода на TLS корень отвечает редиректом, и wget пошёл бы
# за ним во внешнюю сеть — за собственным доменом, изнутри контейнера.
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
    CMD wget --quiet --spider http://127.0.0.1/nginx-alive || exit 1
