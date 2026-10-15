# typingmind-subagent

A TypingMind plugin that adds one function, `spawn_subagent`. The chat model uses it to hand a self-contained task to a second model on any OpenAI-compatible `/chat/completions` endpoint, and gets back a JSON envelope:

```
{status, kind, title?, text, model, usage?, elapsed_ms, truncated?}
```

The worker gets a fixed system prompt (the return protocol) plus the task, context and output format written by the chat model. It has no tools, no conversation history and no way to ask follow-up questions. The plugin never retries. Reasoning output is stripped, so only the deliverable is returned.

## Repository layout

| File | Purpose |
|---|---|
| `spawn_subagent.js` | The function TypingMind runs. This is the source of truth for the code. |
| `build.mjs` | Plugin metadata (function spec, settings, Plugin Context). Generates `plugin.json`. |
| `plugin.json` | Generated, importable TypingMind plugin. Committed so the repo can be imported from GitHub. |
| `test/spawn_subagent.test.mjs` | Tests against a local fake provider. |

## Build

Requires Node.js 20 or newer. There are no dependencies to install.

```sh
node build.mjs                    # writes plugin.json
node --test test/*.test.mjs       # runs the tests
```

`build.mjs` reads `spawn_subagent.js`, embeds it as the function's `code` string and writes `plugin.json`. Edit `spawn_subagent.js` or `build.mjs`, never `plugin.json` by hand. Rebuild after every change and commit `plugin.json` along with the source. One test fails if `plugin.json` is out of date.

## Install in TypingMind

Use either of these:

- **Import from GitHub:** give TypingMind's plugin import this repository's URL. It reads `plugin.json` from the repository root.
- **JSON editor:** Plugins → Create plugin → JSON Editor, then paste the contents of `plugin.json`.

Then open the plugin's Settings tab and fill in:

| Setting | Required | Default | Notes |
|---|---|---|---|
| `base_url` | yes | | For example `https://openrouter.ai/api/v1`. `/chat/completions` is appended unless already present. |
| `api_key` | yes | | Sent as `Authorization: Bearer <key>`. |
| `model` | yes | | The worker model's id. |
| `provider` | no | | OpenRouter provider routing as JSON, sent as the request's `provider` field. For example `{"order": ["novita/fp8"], "allow_fallbacks": false}`. |
| `temperature` | no | `0.2` | |
| `max_tokens` | no | `64000` | Reasoning tokens count against this limit on most providers. |
| `timeout_ms` | no | `60000` | Raise it for long or reasoning-heavy tasks. |

In the personal version of TypingMind the plugin runs in the browser, so the provider must allow CORS requests from TypingMind.
