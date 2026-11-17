# AGENTS.md — gemini-bridge

OpenAI-compatible мост над веб-RPC gemini.google.com. Позволяет использовать
Gemini из веб-подписки как модель для агентской разработки в pi/bb.

## Архитектура

```
pi/bb ──OpenAI /v1/chat/completions──> gemini-bridge (127.0.0.1:8787)
                                          │ gemini-webapi, cookie __Secure-1PSID
                                          ▼
                                     gemini.google.com (batchexecute RPC)
```

- `gemini_bridge/server.py` — FastAPI: `/v1/models`, `/v1/chat/completions`
  (SSE и non-stream), `/health`. Ошибки → OpenAI-формат (401/429/502/504).
- `gemini_bridge/protocol.py` — tool-calls текстовым протоколом: модель отвечает
  fenced-блоками ```` ```tool_call ```` с JSON `{"name", "arguments"}`; мост
  парсит их в нативные OpenAI `tool_calls`. Битый блок остаётся текстом.
  Flatten всего транскрипта в один промпт, `temporary=True` (stateless).
- `scripts/extract_cookies.py` — cookie из Chrome в `cookies.json`.
- `tests/test_protocol.py` — парсер, roundtrip, holdback, flatten.

## Настройка с нуля (порядок важен)

1. Зависимости:
   ```bash
   uv sync
   ```
2. Cookie (Chrome должен быть залогинен на https://gemini.google.com):
   ```bash
   uv run python scripts/extract_cookies.py
   ```
   macOS: подтвердить диалог Keychain «Chrome Safe Storage».
   Результат — `cookies.json` в корне (gitignored, НЕ коммитить).
   Альтернатива: env `GEMINI_1PSID` / `GEMINI_1PSIDTS` или ручной `cookies.json`.
3. Запуск сервера:
   ```bash
   uv run python -m gemini_bridge          # 127.0.0.1:8787, порт: GEMINI_BRIDGE_PORT
   ```
   Фон: `nohup uv run python -m gemini_bridge > /tmp/gemini-bridge.log 2>&1 &`
4. Проверка:
   ```bash
   uv run pytest -q                        # 11 тестов протокола
   curl -s localhost:8787/health           # {"ok":true}
   curl -s localhost:8787/v1/models        # модели аккаунта
   ```
5. pi: провайдер `gemini-web` в `~/.pi/agent/models.json`
   (`api: openai-completions`, `baseUrl: http://127.0.0.1:8787/v1`,
   `apiKey: dummy`). Основные модели: `gemini-4-hydrogen`, `gemini-4-argon`
   (+ `-thinking` варианты). Шаблон в README.md. pi подхватывает при `/model`.
   **Argon**: не приходит в RPC `otAQ7b`, hex-id нет — мост шлёт номер категории 8
   в model-header с пустым hex. Не подбирайте header вслепую: locked-модель
   (Carbon) сталлит сессию и роняет auth.
6. **bb: каталог моделей bb — внутренний реестр, правки models.json недостаточны.**
   pi sub-provider `gemini-web` фильтруется каталогом bb-core. Рабочий обход —
   top-level ACP-провайдер `bb-plugin-gemini-web/` (см. README «bb: отдельный
   ACP-провайдер»): `bb plugin install . --yes` + `gemini-acp` на PATH + рестарт bb.
   Требует `parameterizedModelPicker:true`, без пустого `permissionCli`.

## Эксплуатация

- Cookie протухли (401/AuthError) → повторить шаг 2, перезапустить сервер.
- **IP/локация**: веб-RPC банит датацентровые IP (`LOCATION_REJECTED`,
  `hosting:true`). Residential IP в поддерживаемой стране → работает. Хостинг
  VPN-exit (Hostkey и т.п.) не подходит. Прокси: `GEMINI_PROXY=http://…` /
  `socks5h://…` (мост гонит все RPC через него). Альтернативы: официальный
  `GEMINI_API_KEY` (без IP-банов) или CDP-вариант (RPC внутри реального Chrome).
- **Не запускать второй GeminiClient с теми же cookie** — гонка ротации
  `1PSIDTS` инвалидирует сессию рабочего сервера (проверено: UNAUTHENTICATED).
- `1PSIDTS` мост освежает сам (auto_refresh) и сохраняет в `cookies.json`.
- Лог: stdout uvicorn + loguru; фон-лог обычно `/tmp/gemini-bridge.log`.
- Модели: `gemini-web` = дефолт аккаунта; суффикс `-thinking` = extended
  thinking; конкретные id (`gemini-pro`, ...) = модели аккаунта из `/v1/models`.

## Ограничения (осознанные, не чинить без запроса)

- Неофициальный протокол: Google может ломать/троттлить/банить. Веб-лимиты
  заточены под чат, агентские циклы могут упираться.
- Tool-calls — текстовая эмуляция, не нативный function calling.
- Stateless: весь транскрипт каждый запрос. Upgrade path: ChatSession-дельты.
- Один глобальный asyncio.Lock на генерацию (клиент = одна сессия).
- Только текст; `temperature`/`max_tokens`/`stop` игнорируются.
- Usage — оценка ~4 символа/токен.
- Ошибка посреди SSE → последний чанк `{"error": ...}`.

## Правила для агентов

- `cookies.json`, `.env` — секреты, не коммитить, не логировать, не печатать.
- Меняешь `protocol.py` → прогони `uv run pytest -q`, добавь кейс на новый logic.
- Не добавлять нативный function calling «как в API» — веб-RPC его не имеет.
- Коммиты в `main`, пуш в `origin` (github.com/EvgenyGulyaev/GeminiAPi).