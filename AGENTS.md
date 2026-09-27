# AGENTS.md — dsh-plugin-degen-investigator

Session-learned notes (2025-09-26) about building, verifying, and deploying this
Cordis host plugin. These are DSH/Cordis-specific and were established by
hands-on work in this session; they differ from general knowledge, so treat them
as ground truth here.

## What this plugin is

A Host "guard" plugin. It listens to the live agent stream, detects
repetitive-token degeneration (word / n-gram / char-run) or a configured trigger
word, halts the agent, and commits a debug-report notice row. Detection is
per-agent and process-local; nothing is persisted beyond the committed message.

## Build & test

```sh
node --check index.js
DSH_PROFILE_DIR=/home/derek/.dsh/profiles/web node test-e2e.mjs   # 30 cases
```

- `test-e2e.mjs` drives the real `apply()`/`Config` against a **mock Cordis
  context** (a listeners map + `emit`). Its waterfall mock is the correct
  semantics: a handler's `next` invokes `handlers[i++](...args, next)`, else the
  base continuation. If you change listener logic, keep the mock in sync.
- `Config` is a **Standard Schema** (from `@deepseek-ai/schemastery`). Validate
  with `['~standard'].validate(value)` — never `.safeParse`/`.parse` (it is not
  zod).

## Why `loadDsh()` exists (resolution gotcha)

This plugin installs into the profile as a pnpm **`link:` symlink**. Its real
path is *outside* the DSH tree, so a bare `import '@deepseek-ai/schemastery'`
from `index.js` resolves from the real path and fails with
`ERR_MODULE_NOT_FOUND`. `loadDsh()` instead anchors a `createRequire` to a path
*inside* the DSH tree — the profile's `index.js` (via `$DSH_PROFILE_DIR`), then
a walk-up from the real install dir — and requires the DSH package from there.
Keep this helper if you add any other DSH-tree imports.

## Deploy / activation lifecycle (the part that bit us)

- Install with `plugin_manager install_bundle <absolute dir>`. **Do not**
  hand-write the profile's `package.json` / `cordis.*` files or run `pnpm` in
  the profile dir — `install_bundle` does all of that (and runs pnpm with
  supply-chain lockfile verification).
- **A replaced package needs a host restart.** Installing a *new* bundle can
  activate through HMR, but once a package is installed, updating it keeps the
  running `dsh web` host on the **first (possibly failed) module generation**
  until the process restarts. So a code fix or a rename only goes live after a
  `dsh web` restart.
- **Import failures are swallowed.** A failed import never reaches the host's
  stdout/stderr (the web log only carries startup lines). Read the truth from
  the `plugin_manager` result (`application`, `error.diagnostic`) and from
  `list_bundles` (each bundle has an `error` field when its row can't load).
  `application` values seen: `applied` (disable always works, even on a broken
  import), `failed` (import rejected), `restart-required` (not live yet).
- **Prove the code is fine with a fresh-process replication** of the host's
  exact import (internal cascaded loader at the profile `baseUrl`):

  ```sh
  node --expose-internals -e "
    const {createRequire}=require('node:module');
    const req=createRequire('<profile>/index.js');
    req('internal/modules/esm/loader').getOrInitializeCascadedLoader()
      .import('dsh-plugin-degen-investigator','file://<profile>/',{})
      .then(m=>console.log('OK', m.name));"
  ```

  (Profile `baseUrl` is `file://<profile dir>/`.) If this succeeds in a fresh
  process but the running host still reports "failed to import", it is a
  stale-generation issue — restart the host; it is **not** a code bug.

## Renaming a `link:` bundle

1. Rename the directory and update `package.json` `name`, the `cordis.patch.yml`
   row `id`/`name`, and any in-code name references.
2. `plugin_manager remove_bundle <old name>`, then `install_bundle <new abs dir>`.
3. **pnpm leaves the old `node_modules` symlink behind** (the old scoped
   `@local/...` entry survived removal) — delete it by hand.
4. Unscoped names get a **top-level** `node_modules/<name>` entry; scoped names
   get `node_modules/@scope/<name>`.

Naming convention: dsh-standard plugins use `dsh-*` (e.g. `dsh-find-plugin`,
`dsh-qwen38-local-qol`, `dshmarket`); community ones are scoped
(`@huanlin/dsh-plugin-codegraph`). In `cordis.patch.yml`, the row `id` is a
short row identifier and `name` is the **exact package name**.

## Host event contracts used by this plugin

- `agent/request` (**waterfall**): yields the per-call `LlmCallConfig` =
  `{ provider, model, reasoningEffort?, temperature?, maxTokens?, stop? }`.
  **DSH does not expose `repetition_penalty`** — it's a server-side param (set
  on the model server, e.g. vLLM `--repetition-penalty`), so the report flags
  it as "not set by DSH".
- `agent/assistant-stream` (**emit**): `start { turn, step }` then `chunk` with
  one of `reasoning-delta` | `text-delta` | `tool-call-delta` | `usage`.
- `tools/post-execute` (**waterfall**): tool results.
- **Waterfall rule:** a listener that does not own the decision must
  `return next()`.
- **Halt:** `agent.cancel({ kind: 'hook', reason })`.
- **Report:** commit a user-role message via
  `agent.session.append('user/message', msg, { surfaceOp: 'append' })` carrying
  `source: { form: 'notice' }` (reuses the existing `user/message` type — do
  **not** invent a new session event type; a new type can't set `ignorable`).
- `agent.inject()` does **not** wake the agent; `agent.followup()` does.

## Verifying in the live host

- `dsh --profile web --dump-config` prints the composed profile; the row appears
  as a `# == dsh-plugin-degen-investigator` section with its `config`.
- `cordis_inspect_query` → `Config.listConfigs` (no approval needed) is the
  recommended way to confirm a row. Note: this session's inspect bridge
  **rejected a non-empty `input` object** ("input must be an object"); the
  no-arg call returns a paged directory (~190 entries) you can page through.
- The running host's row stays `failed to import` until a restart; a fresh boot
  re-imports and activates it (confirmed by the replication above).
