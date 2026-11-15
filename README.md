# @baymaxhit/dsh-idle

> **Idle-time task scheduler for [DeepSeek Harness](https://www.deepseek.com/en/harness/)** — queue goal-oriented tasks and they run autonomously in their own sessions whenever the host is idle. The off-peak "watchdog" pattern, as a standalone plugin.

A community plugin (MIT) for the DeepSeek Harness plugin system. Not an official DeepSeek product.

## What it does

Tell it what "done" means; it figures out *when* to work. Tasks sit in a queue and dispatch automatically when:

1. the host is **quiet** — no person-driven agent activity for `quietMinutes` (default 10)
2. **budget allows** — at most `maxConcurrent` (default 1) idle session at a time, `maxPerDay` (default 3) dispatches per calendar day
3. then the task's session runs until it finishes, errors, or hits `maxRuntimeMinutes` (default 120) — whichever first

Person priority is absolute: a task dispatches only into silence, and your own sessions are never touched.

## Install

```sh
dsh plugin --profile <profile> add @baymaxhit/dsh-idle
```

(or `link:` a clone of this repo for development — quit the Desktop app first and use the bundled CLI)

## Use

**HTTP API** on the Harness web server:

```sh
# enqueue a goal task
curl -s -X POST http://127.0.0.1:<port>/idle/api/tasks \
  -H "content-type: application/json" \
  -d '{"title":"polish the docs","prompt":"You are the docs-polish watchdog: autonomously iterate until every doc matches the code, then stop."}'
curl -s http://127.0.0.1:<port>/idle/api/tasks        # list
curl -s -X POST http://127.0.0.1:<port>/idle/api/tasks/<id>/cancel
```

**For other plugins**: the bundle provides a `ctx.idle`-style capability via the standard plugin interface — inject the plugin and call `enqueue` (dsh-superagent consumes it this way to dispatch governed polish tickets).

## Configuration

`~/.dsh/plugins-data/dsh-idle/config.json` (all optional):

```json
{
  "enabled": true,
  "checkSeconds": 30,
  "quietMinutes": 10,
  "maxConcurrent": 1,
  "maxRuntimeMinutes": 120,
  "maxPerDay": 3
}
```

Task records persist at `~/.dsh/plugins-data/dsh-idle/tasks.json`; tasks mid-run when the host stops re-queue on the next start.

## Writing task prompts

The prompt is the whole contract — make it **self-contained and self-terminating**:

```text
You are the docs-polish watchdog. Autonomously iterate until every document matches the code
(acceptance: no doc references a deleted symbol; every new feature is documented).
When done, stop and summarize what changed. Never ask the user questions.
```

## Development

```sh
pnpm install
pnpm check   # typecheck + tests + build
```

## License

[MIT](LICENSE)
