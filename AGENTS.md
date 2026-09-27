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
node test-e2e.mjs                        # 30 cases; no env needed anymore
DSH_PROFILE_DIR=/home/derek/.dsh/profiles/web node test-e2e.mjs   # exercises tier 1
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
`ERR_MODULE_NOT_FOUND`. `loadDsh()` instead anchors a `createRequire` to a file
*inside* a DSH tree and climbs an ascending ladder of anchors:

1. `$DSH_PROFILE_DIR/index.js` — honored **only when the variable is set**.
2. Walk-up from this file's real path (real-dir installs inside a DSH tree).
3. `realpath(process.argv[1])` — the `dsh` bin; its realpath lives inside
   `@deepseek-ai/dsh`, whose `node_modules` holds every DSH package. **This is
   the anchor that rescues the stock `dsh web` host.**
4. The DSH dist co-located with the running node binary
   (`<node root>/lib/node_modules/@deepseek-ai/dsh/lib/bin.js`) — covers
   dev/test processes where `argv[1]` is not the dsh bin.

**THE TRAP (caused the 2026-09-26 outage):** the running `dsh` host process
carries **no `DSH_*` environment variables at all** (verified via
`/proc/<pid>/environ`); `DSH_PROFILE_DIR` et al. are injected only into
*child shells* by the `dsh-shell-env` plugin. That poisons developers' login
shells, so a "fresh-process replication" run from a shell *passed* while the
host *failed*: the old two-tier ladder exhausted at `/home/index.js` with
`Cannot find module '@deepseek-ai/schemastery'`, the import failure was
swallowed, the row sat "not running", and the guard never armed — a
degenerating session sailed through unchecked. Scrub the env before any
replication (recipe below). Keep all four tiers if you add other DSH-tree
imports.

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
  exact import (internal cascaded loader at the profile `baseUrl`). To be
  honest it must replicate the host's *conditions*, not just its import:

  ```sh
  SCRUBBED="env -u DSH_PROFILE_DIR -u DSH_HOME -u DSH_PROFILE -u DSH_WEB_URL -u DSH_SESSION_ID -u DSH_SHELL"
  # run from the host's actual cwd (readlink /proc/<pid>/cwd), argv[1] pointed
  # at the dsh bin (the script must set process.argv[1] itself — node's argv[1]
  # is the script path, not the launcher):
  $SCRUBBED node --expose-internals repl-script.cjs
  #   repl-script.cjs: set process.argv[1]='…/bin/dsh', then
  #   createRequire('<profile>/index.js')('internal/modules/esm/loader')
  #     .getOrInitializeCascadedLoader()
  #     .import('dsh-plugin-degen-investigator','file://<profile>/',{})
  ```

  (Profile `baseUrl` is `file://<profile dir>/`.) Skipping the env scrub makes
  the `dsh-shell-env`-poisoned login shell masquerade as a pass. If a truly
  faithful replication succeeds but the running host still reports "failed to
  import", it is a stale-generation issue — restart the host; it is **not** a
  code bug.
- **The profile row can be corrupted out-of-band (2026-09-26).** A
  plugin-manager patch merge once replaced this bundle's row with a stub
  (lost `name` and all tuning fields, kept a stray test trigger word
  `"duct!"`). Symptom: the row still composes, so `--dump-config` looks sane,
  yet behavior is gone. Diff the composed row against the bundle's
  `cordis.patch.yml` regularly; repair the row in the profile's
  `cordis.patch.yml` (the designated user layer) if they diverge.

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

- **Every agent-subjected event payload is fused with `agent`** by the
  agent's dispatcher (`agentEvents` in `@deepseek-ai/dsh-agent`): listeners
  receive `{ ...payload, agent }`. Verified in `dsh-webhook`
  (`on("agent/request", async ({ agent }, next) …)`) and `dsh-headless`.
  Correlate per-agent state through `payload.agent`.
- `agent/request` (**waterfall**, dispatched as `{ turn, step, signal }` +
  fused `agent`): the base continuation yields the seed `LlmCallConfig` =
  `{ provider, model, reasoningEffort?, maxTokens? }`; `await next()` resolves
  to the final config after downstream modifications (capturing it that way
  records what the call actually ran with). **DSH does not expose
  `repetition_penalty`** — it's a server-side param (set on the model server,
  e.g. vLLM `--repetition-penalty`), so the report flags it as "not set by
  DSH". `temperature` is frequently absent from this config (adapter-supplied
  later) — the checklist must cope.
- `agent/assistant-stream` (**emit**): `start { turn, step }` then `chunk`
  frames `{ type, chunk: StreamChunk }` with `chunk.type` ∈
  `reasoning-delta | text-delta | tool-call-delta | usage | …`; `usage` chunks
  carry `{ usage }`.
- `tools/post-execute` (**waterfall**, `(exec, result, next)`): `exec` carries
  `{ agent, name, arguments, … }`; the base decision is `{ kind: 'accept' }`,
  a `block` decision carries `feedback`. **Drain first, then act** (mirror
  `dsh-repeat-tool-reminder`): `const downstream = await next(); … return
  downstream;` — acting before downstream handlers can cancel the agent
  under a still-running chain.
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
