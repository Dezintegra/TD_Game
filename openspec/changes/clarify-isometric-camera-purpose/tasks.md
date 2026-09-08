## 1. Согласовать Purpose с действующей камерой

- [ ] 1.1 Заменить последний абзац Purpose в `openspec/specs/isometric-view/spec.md` точным текстом из раздела «Точная замена последнего абзаца Purpose» в `design.md` и отметить этот пункт выполненным в `openspec/changes/clarify-isometric-camera-purpose/tasks.md` (до 30 минут, один самостоятельно проверяемый коммит).

  Проверка результата: Purpose называет неподвижные углы, масштаб игрока
  относительно дефолта, свойство сдвига при фиксированном масштабе и
  переиспользование геометрии при преобразовании контейнера. Первые два
  абзаца Purpose и весь раздел от `## Requirements` до конца файла
  остаются без изменений. Сверить смысл с `camera.ts` (`clampZoom`, `zoomAt`),
  `scene.ts` (`worldContainer.scale.set(scale)`) и требованиями
  «Территория не перестраивается каждый кадр» и «Приближение щипком и колесом».

  Из назначенного дерева выполнить `git -C . diff --check` и просмотреть
  `git -C . diff -- openspec/specs/isometric-view/spec.md openspec/changes/clarify-isometric-camera-purpose/tasks.md`.
  Добавить только два явных пути командой
  `git -C . add -- openspec/specs/isometric-view/spec.md openspec/changes/clarify-isometric-camera-purpose/tasks.md`.
  Перед коммитом проверить имена и содержание всего индекса командами
  `git -C . diff --cached --name-only` и `git -C . diff --cached`:
  допустимы только заказанная правка Purpose и отметка этого пункта;
  посторонние файлы и несвязанные изменения внутри двух файлов недопустимы.
  После коммита проверить `git -C . show --format=fuller --stat HEAD`
  и `git -C . show --format= --patch HEAD`, немедленно отправить
  `git -C . push -u origin HEAD` и открыть черновой PR по правилам implement.
  Этот единственный шаг уже даёт полный проверяемый результат для PR.

  Проверить плановые артефакты командами
  `openspec validate clarify-isometric-camera-purpose --strict`
  и `openspec status --change clarify-isometric-camera-purpose`.
  Для validate допустима ровно одна ошибка, сообщение которой начинается
  с `Change must have at least one delta. No deltas found.`; просмотреть
  весь вывод, включая Next steps. Одновременно проверить отсутствие
  каталога `specs/` у изменения и содержательное обоснование «Почему дельты нет»
  в proposal. Status ожидаемо показывает 3/4: незакрытым остаётся `specs`.
  Иные ошибки недопустимы. Игровые тесты, сборку, prettier по OpenSpec,
  замеры и арену для правки прозы не запускать.

Архивация не является шагом реализации и не доставляет Purpose.
Правка основного текста должна присутствовать в самом PR; при последующей
архивации этого изменения применяется `--skip-specs`.
