# gemini-bridge

OpenAI-compatible мост над веб-RPC `gemini.google.com` (библиотека
[gemini-webapi](https://github.com/HanaokaYuzu/Gemini-API)). Даёт модели Gemini
из веб-подписки как обычный OpenAI-эндпоинт → pi/bb подключается штатно через
`models.json`, без кастомных провайдеров.

```
pi/bb ──OpenAI /v1/chat/completions──> gemini-bridge (localhost:8787)
                                          │  gemini-webapi (cookie __Secure-1PSID)
                                          ▼
                                     gemini.google.com batchexecute RPC
```

Tool-calling эмулируется текстовым протоколом: модель получает инструкцию
отвечать fenced-блоками ```` ```tool_call ```` с JSON, мост парсит их в
нативные OpenAI `tool_calls`.

## Быстрая установка (1–2 команды)

```bash
./install.sh        # uv sync + bb-плагин + gemini-acp на PATH + cookie из Chrome
./start.sh          # запуск моста (foreground; -b для фона)
```

Затем **рестарт bb** → провайдер **Gemini Web** → `gemini-4-argon`.

Если exit IP датацентровый (`hosting:true`, Gemini банит) — нужен residential
proxy:
```bash
GEMINI_PROXY="socks5h://user:pass@host:port" ./start.sh
```

`install.sh --no-cookies` — пропустить извлечение cookie. Требования: `uv`,
`node`, `bb` на PATH; Chrome залогинен на gemini.google.com.

## Запуск

```bash
uv sync
# cookies.json (в корне, gitignored):
# {"__Secure-1PSID": "...", "__Secure-1PSIDTS": "..."}
uv run python -m gemini_bridge      # 127.0.0.1:8787
```

Cookie — два способа:

1. **Авто из Chrome** (залогинен на gemini.google.com):
   ```bash
   uv run python scripts/extract_cookies.py
   ```
   macOS: подтвердить диалог Keychain «Chrome Safe Storage».
2. **Вручную**: DevTools → Application → Cookies → `https://gemini.google.com` →
   значения `__Secure-1PSID` и `__Secure-1PSIDTS` в `cookies.json`:
   ```json
   {"__Secure-1PSID": "...", "__Secure-1PSIDTS": "..."}
   ```

Альтернатива — env `GEMINI_1PSID` / `GEMINI_1PSIDTS`.
Мост сам освежает `1PSIDTS` и сохраняет его в `cookies.json` при остановке.

Порт: `GEMINI_BRIDGE_PORT` (default 8787). Файл cookie: `GEMINI_COOKIE_FILE`.
Прокси: `GEMINI_PROXY` (см. ниже).

## IP, локация и proxy (важно)

Gemini веб-RPC **отвергает датацентровые/хостинговые IP** (анти-бот).
Симптом: ошибка `LOCATION_REJECTED` / «IP address temporarily flagged»,
модели не загружаются. Это **не** проблема страны — IP может быть в
поддерживаемой стране (NL/DE/US), но если он `hosting:true` (датацентр,
напр. Hostkey/Hetzner/DigitalOcean), Google банит его для `batchexecute`.

Проверить свой exit IP:
```bash
curl -s "http://ip-api.com/json/<IP>?fields=country,isp,proxy,hosting"
# hosting:true  → веб-RPC будет банить
# hosting:false → residential, работает
```

**Решение — residential proxy** (IP не датацентра, в поддерживаемой стране):
```bash
# http / socks5, с авторизацией или без:
export GEMINI_PROXY="http://user:pass@residential-host:port"
# или socks5 (remote DNS):
export GEMINI_PROXY="socks5h://user:pass@host:port"
uv run python -m gemini_bridge
# в логе: gemini-bridge: proxy=on
```
Мост маршрутизирует все RPC (включая ротацию cookie) через `GEMINI_PROXY`.
Обычный VPN с датацентровым exit (напр. v2RayTun → Hostkey) **не подходит** —
нужен именно residential exit.

Альтернативы без residential proxy:
- **Официальный Gemini API** (`GEMINI_API_KEY`) — IP-ограничений нет,
  датацентровые IP разрешены. Самый стабильный путь.
- **CDP-вариант моста** — RPC исполняется внутри реального Chrome (браузерный
  fingerprint проходит анти-бот даже с hosting IP). Требует открытый Chrome.

## Подключение к pi/bb

`~/.pi/agent/models.json`:

```json
{
  "providers": {
    "gemini-web": {
      "baseUrl": "http://127.0.0.1:8787/v1",
      "api": "openai-completions",
      "apiKey": "dummy",
      "models": [
        { "id": "gemini-4-hydrogen", "name": "Gemini 4 Hydrogen", "reasoning": false,
          "input": ["text"], "contextWindow": 128000, "maxTokens": 8192,
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 } },
        { "id": "gemini-4-argon", "name": "Gemini 4 Argon (code)", "reasoning": false,
          "input": ["text"], "contextWindow": 128000, "maxTokens": 8192,
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 } }
      ]
    }
  }
}
```

- `gemini-web` → дефолтная модель аккаунта; `-thinking` суффикс → extended thinking.
- **Hydrogen** (`gemini-4-hydrogen`) и **Argon** (`gemini-4-argon`) — основные модели.
  Argon («Code & analysis») не отдаётся RPC `otAQ7b` и не имеет hex-id: мост
  выбирает его номером категории 8 в model-header (пустой hex). Подобрано
  эмпирически; неверный header (напр. locked Carbon) сталлит сессию — не гадайте.
- Конкретные модели аккаунта: `curl -s localhost:8787/v1/models` → добавить их
  `id` (= `model_name`) в `models` тем же шаблоном.
- В bb: `/model` → выбрать `gemini-web/...`.

## bb: отдельный ACP-провайдер (рекомендуется)

Каталог моделей bb (pi sub-provider) **фильтрует** `gemini-web` — правки
`models.json` и панель «Api модели» не добавляют его в выбор bb (особенность
bb-core). Обход — top-level ACP-провайдер `bb-plugin-gemini-web/`:

```bash
cd bb-plugin-gemini-web
npm install
bb plugin build
bb plugin install . --yes
# адаптер должен быть на PATH (bb спавнит его по имени):
ln -sf "$PWD/bin/gemini-acp.mjs" ~/.local/bin/gemini-acp
bb plugin reload gemini-web   # после первого install лучше рестарт bb
```

После этого в bb появляется провайдер **Gemini Web** с моделями
`gemini-4-argon` (default), `gemini-4-hydrogen`, `gemini-web`. ACP-агент
`gemini-acp` гоняет agentic tool-loop (bash/read/write/edit) поверх моста.

Ключевые требования (грабли, уже учтены в плагине):
- `parameterizedModelPicker: true` в provider options — иначе только `acp-default`.
- `gemini-acp` на PATH — иначе bb не спавнит адаптер (модели не discover).
- Без пустого `permissionCli` в `acpLaunchSpec` — ACP-схема отвергает пустые
  массивы → ошибка `acpLaunchSpec is required`.
- URL моста: настройка плагина `bridgeUrl` (default `http://127.0.0.1:8787/v1`).
- Каталог моделей bb кешируется — после правок плагина нужен **рестарт bb**.

## Проверки

```bash
uv run pytest -q                          # протокол tool-calls, flatten
curl -s localhost:8787/health
curl -s localhost:8787/v1/chat/completions -H 'Content-Type: application/json' \
  -d '{"model":"gemini-web","messages":[{"role":"user","content":"Скажи привет"}]}'
```

## Ограничения (осознанные)

- **Нестабильность**: неофициальный протокол, Google может ломать/банить.
  Веб-лимиты заточены под чат → агентские циклы могут троттлиться.
- Tool-calls — текстовая эмуляция: сбой формата = блок остаётся текстом,
  агент видит его и может повторить.
- Stateless: весь транскрипт шлётся каждый запрос (`temporary=True`, история
  Gemini не засоряется). Upgrade path: ChatSession-дельты.
- Один глобальный lock на генерацию (клиент — одна сессия).
- Только текст; изображения в запросах отбрасываются с маркером.
- `temperature`/`max_tokens`/`stop` игнорируются (веб их не принимает).
- Usage — оценка ~4 символа/токен (веб не отдаёт счётчики).
- Ошибка посреди SSE-стрима приходит последним `{"error": ...}` чанком.