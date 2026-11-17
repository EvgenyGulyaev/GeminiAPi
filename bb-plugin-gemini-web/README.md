# bb-plugin-gemini-web

Top-level **Gemini Web** agent provider for BB over the Agent Client Protocol
(ACP). Runs Gemini web models (Hydrogen / Argon) as a first-class BB provider,
bypassing BB's pi sub-provider catalog filter.

```
BB ──ACP──> gemini-acp (this plugin's adapter)
                 │  OpenAI /v1/chat/completions
                 ▼
            gemini-bridge (localhost:8787) ──> gemini.google.com web RPC
```

The adapter (`bin/gemini-acp.mjs`) speaks ACP on stdio and drives the
[gemini-bridge](../README.md) OpenAI endpoint. It runs an agentic tool loop:
the bridge emulates Gemini tool calls as OpenAI `tool_calls`; the adapter
executes them (`bash` / `read` / `write` / `edit`) in the session cwd, gates
writes/commands through ACP `requestPermission`, and streams text + tool
updates back to BB.

## Install

```bash
npm install
bb plugin build
bb plugin install . --yes
# BB spawns the adapter by name — it must be on PATH:
ln -sf "$PWD/bin/gemini-acp.mjs" ~/.local/bin/gemini-acp
bb plugin reload gemini-web   # restart BB after first install to refresh catalog
```

Requires a running gemini-bridge with valid Gemini cookies and a clean
(residential) exit IP — see the [bridge README](../README.md) for proxy setup
(`GEMINI_PROXY`). Hosting/datacenter IPs get `LOCATION_REJECTED` by Gemini web.

## Models

Discovered from the bridge via ACP session config options:
`gemini-4-argon` (default, "Code & analysis"), `gemini-4-hydrogen`, `gemini-web`.
Pick the model in the thread's model config option.

## Settings

- `bridgeUrl` — gemini-bridge base URL (default `http://127.0.0.1:8787/v1`).

## Implementation notes (gotchas)

- `parameterizedModelPicker: true` in provider options — otherwise BB shows
  only `acp-default` instead of enumerating models.
- `gemini-acp` must be on PATH — BB spawns the adapter by command name; if not
  found, the model probe fails silently and the catalog stays `acp-default`.
- `acpLaunchSpec` must NOT contain empty `permissionCli` arrays — the ACP
  launch-spec schema rejects them (`acpLaunchSpec is required` error). The
  adapter uses ACP `requestPermission`, not CLI permission flags.
- BB caches the provider model catalog; restart BB after plugin changes.

## Tests

```bash
npm test   # SSE parsing + tool execution (edit uniqueness, read offset/limit)
```