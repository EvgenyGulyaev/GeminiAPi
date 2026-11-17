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
        { "id": "gemini-web", "name": "Gemini Web (default)", "reasoning": false,
          "input": ["text"], "contextWindow": 128000, "maxTokens": 8192,
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 } },
        { "id": "gemini-web-thinking", "name": "Gemini Web (extended thinking)",
          "reasoning": true, "input": ["text"], "contextWindow": 128000, "maxTokens": 8192,
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 } }
      ]
    }
  }
}
```

- `gemini-web` → дефолтная модель аккаунта; `-thinking` суффикс → extended thinking.
- Конкретные модели аккаунта: `curl -s localhost:8787/v1/models` → добавить их
  `id` (= `model_name`) в `models` тем же шаблоном.
- В bb: `/model` → выбрать `gemini-web/...`.

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