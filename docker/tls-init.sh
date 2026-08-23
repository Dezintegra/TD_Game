#!/bin/sh
# Первичный выпуск сертификата Let's Encrypt.
#
#   ./docker/tls-init.sh --dry-run   репетиция на тестовом сервере
#   ./docker/tls-init.sh             выпуск настоящего сертификата
#
# Нужен ровно один раз — дальше продлением занимается служба certbot
# из docker-compose.yml, и она обходится без остановки игры.
#
# Почему выпуск идёт с остановкой, а продление — нет. Проверка владения
# доменом требует ответить на запрос по 80-му порту. Продлевать легко:
# nginx уже работает и отдаёт файл-ответ из общего тома. А вот в первый
# раз nginx подняться не может — его конфигурация ссылается на файлы
# сертификата, которых ещё нет. Разорвать этот круг проще всего, отдав
# 80-й порт самому certbot на полминуты.
set -e

cd "$(dirname "$0")/.."

if [ ! -f .env ]; then
  echo "Нет файла .env рядом с docker-compose.yml" >&2
  exit 1
fi

# shellcheck disable=SC1091
. ./.env

if [ -z "$TD_DOMAIN" ]; then
  echo "В .env не задан TD_DOMAIN — без домена сертификат не выдадут" >&2
  exit 1
fi

# --dry-run гоняет всю проверку на тестовом сервере Let's Encrypt.
# Пользоваться им стоит при любой правке: у настоящего сервера жёсткие
# ограничения — пять одинаковых сертификатов в неделю, и упереться
# в них посреди отладки крайне обидно.
EXTRA="$*"

echo "▸ Останавливаю веб, чтобы освободить 80-й порт"
docker compose stop web 2>/dev/null || true

echo "▸ Запрашиваю сертификат для $TD_DOMAIN и www.$TD_DOMAIN"
# --register-unsafely-without-email: почта не указана по решению
# владельца. Писем об истечении не будет, вся надежда на автопродление.
docker compose run --rm --entrypoint certbot -p 80:80 certbot \
  certonly --standalone \
  -d "$TD_DOMAIN" -d "www.$TD_DOMAIN" \
  --agree-tos --register-unsafely-without-email \
  --non-interactive $EXTRA

# После репетиции настоящего сертификата на диске нет, и поднимать nginx
# незачем: он ссылается на файлы, которых не существует, и просто упадёт.
case " $EXTRA " in
  *" --dry-run "*)
    echo "✓ Репетиция прошла. Теперь без ключа: ./docker/tls-init.sh"
    exit 0
    ;;
esac

echo "▸ Поднимаю игру целиком"
docker compose up -d --build

echo "✓ Готово. Проверить: curl -I https://$TD_DOMAIN/"
