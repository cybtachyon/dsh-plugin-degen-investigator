/**
 * Repetitive Degeneration Investigator — a Host guard plugin.
 *
 * Detects two failure modes in a running agent and, on a hit, halts the agent
 * and prints a debug report into the conversation:
 *
 *   1. Repetitive-token degeneration: the model loops on a repeated token,
 *      word, short phrase (n-gram), or single-character run in its thinking
 *      (reasoning) stream.
 *   2. Trigger words: a user-configurable list of words that, when they appear
 *      in thinking, assistant text, tool-call arguments, or tool results,
 *      immediately trigger the investigator.
 *
 * On detection the plugin:
 *   - cancels the active turn (`agent.cancel({ kind: 'hook' })`),
 *   - commits a plugin-attributed `user/message` (rendered as a `notice` row
 *     whose collapsed line is the report summary) carrying a full debug dump:
 *     sampling config (temperature, repetition_penalty status, maxTokens,
 *     reasoningEffort, stop), the current provider/model ("weights"), recent
 *     tool calls, and the session context containing the detected token,
 *   - runs a checklist of common causes (auto-detected where possible) and
 *     prints a list of recommended fixes.
 *
 * The agent is left idle after a halt; the user resumes by sending a new
 * message. Detection state is per-agent and process-local.
 *
 * @module dsh-plugin-degen-investigator
 */
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';

const name = 'dsh-plugin-degen-investigator';

/**
 * Load a DSH-tree package by name.
 *
 * This plugin installs as a pnpm *symlink* into the profile's `node_modules`,
 * so a static `import` resolves from the plugin's real path (outside the DSH
 * tree) and fails. Anchoring a `createRequire` to a file *inside* a DSH tree
 * (a dir that owns a `node_modules` containing the package) resolves it
 * correctly.
 *
 * IMPORTANT: the running `dsh` host process does NOT carry `DSH_PROFILE_DIR`
 * (nor any other `DSH_*` variable) in its own environment — those are injected
 * only into *child shells* by the `dsh-shell-env` plugin. An anchor ladder that
 * trusts that env var therefore dies inside the host. The ladder below covers
 * every real-world placement:
 *
 *   1. `$DSH_PROFILE_DIR` (setups that export it; honors the profile's own
 *      pinned copies of DSH packages),
 *   2. a walk-up from this file's real path (real-dir installs sitting inside
 *      a DSH tree),
 *   3. the DSH distribution that spawned this process (`process.argv[1]` is
 *      the `dsh` bin; its realpath lives inside `@deepseek-ai/dsh`, whose
 *      `node_modules` holds every DSH package) — the anchor that saves the
 *      stock `dsh web` host,
 *   4. the DSH distribution co-located with the running node binary (mise/npm
 *      prefix layout: `<node root>/lib/node_modules/@deepseek-ai/dsh`) —
 *      covers dev/test processes where `argv[1]` is not the dsh bin.
 */
function loadDsh(specifier) {
  const anchors = [];
  const seen = new Set();
  const add = (candidate) => {
    if (!candidate || typeof candidate !== 'string') return;
    let real = candidate;
    try {
      real = fs.realpathSync(candidate);
    } catch {
      /* keep the candidate as-is; resolution may still succeed */
    }
    if (seen.has(real)) return;
    seen.add(real);
    anchors.push(real);
  };

  // 1. explicit profile dir
  if (process.env.DSH_PROFILE_DIR) add(path.join(process.env.DSH_PROFILE_DIR, 'index.js'));

  // 2. walk-up from this file's real path
  try {
    let real = new URL('./index.js', import.meta.url).pathname;
    add(real);
    let dir = path.dirname(real);
    for (let i = 0; i < 8 && dir.length > 1; i++) {
      add(path.join(dir, 'index.js'));
      dir = path.dirname(dir);
    }
  } catch {
    /* import.meta.url unavailable; lean on the remaining tiers */
  }

  // 3. the DSH distribution that spawned this process
  try {
    if (process.argv[1]) add(fs.realpathSync(process.argv[1]));
  } catch {
    /* argv[1] unusable */
  }

  // 4. the DSH distribution co-located with the running node binary
  try {
    const nodeRoot = path.dirname(path.dirname(fs.realpathSync(process.execPath)));
    add(path.join(nodeRoot, 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'));
  } catch {
    /* execPath unusable */
  }

  let lastErr;
  for (const anchor of anchors) {
    try {
      return createRequire(anchor)(specifier);
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(
    `dsh-plugin-degen-investigator: cannot resolve ${specifier} from the DSH tree. Tried anchors: ${anchors.join(', ')} (last error: ${lastErr?.message ?? lastErr})`,
  );
}

const z = loadDsh('@deepseek-ai/schemastery');

/**
 * Plugin configuration. Every field has a default; the row's `config` is
 * validated against this schema at activation (fail-loud).
 */
const Config = z.object({
  /** Words that immediately trigger the investigator when found in any output surface. */
  triggerWords: z.array(z.string()).default([]),
  /** Same word repeated N+ times consecutively in reasoning counts as degeneration. */
  wordRepeatThreshold: z.number().default(6),
  /** Same 2-4 word phrase repeated N+ times consecutively in reasoning counts as degeneration. */
  ngramRepeatThreshold: z.number().default(3),
  /** Same non-space character repeated N+ times in a row counts as degeneration. */
  charRepeatThreshold: z.number().default(20),
  /** Cause-checklist: flag "temperature too high" when temperature exceeds this. */
  temperatureHighThreshold: z.number().default(0.8),
  /** Cause-checklist: flag "maxTokens too low" when maxTokens is below this. */
  maxTokensLowThreshold: z.number().default(512),
  /** Cause-checklist: flag "context too long" when input tokens exceed this. */
  contextLengthHighThreshold: z.number().default(200000),
  /** How many recent tool calls to include in the report. */
  recentToolCalls: z.number().default(5),
  /** How many recent session messages to search for the detected token. */
  contextSearchMessages: z.number().default(20),
  /** Snippet radius (chars each side) around a detected token in the report. */
  contextSnippetChars: z.number().default(240),
  /** The one-line account shown on the collapsed report row. */
  reportSummary: z.string().default('Repetitive Degeneration Detected'),
});

/* -------------------------------------------------------------------------- */
/* Small helpers                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Minimal `UserMessage` factory. Mirrors `createUserMessage` from
 * `@deepseek-ai/dsh-llm` (role `user`, fresh stable id) without taking a
 * runtime dependency on that package resolving from this install location.
 * The session's `append` snapshots and freezes the data on commit, so a plain
 * `randomUUID()` id is equivalent at runtime (the `MessageId` brand is a
 * compile-time tag only).
 */
function createUserMessage(input) {
  return { ...input, role: 'user', id: randomUUID() };
}

/** One-line bounded account for a `notice` source (mirrors dsh-llm's bound). */
function boundSummary(summary, max = 120) {
  return summary.length <= max ? summary : `${summary.slice(0, max - 1)}…`;
}

/**
 * A window of `text` around `index`, ellipsized on both sides when truncated.
 * `radius` is the number of characters to include on each side.
 */
function snippetAround(text, index, radius) {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length === 0) return '(empty)';
  const start = Math.max(0, index - radius);
  const end = Math.min(clean.length, index + radius);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < clean.length ? '…' : '';
  return `${prefix}${clean.slice(start, end)}${suffix}`;
}

/** Concatenate the text of a content-block array into one searchable string. */
function extractText(content) {
  if (!Array.isArray(content)) return '';
  return content
    .map((b) => (b && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string' ? b.text : ''))
    .join(' ');
}

/* -------------------------------------------------------------------------- */
/* Detection                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Scan a reasoning buffer for repetitive-token degeneration.
 *
 * Checks, in priority order, against the most recent ~4000 characters:
 *   - a single non-space character run of `charRepeatThreshold`+;
 *   - the trailing word repeated `wordRepeatThreshold`+ consecutively;
 *   - a trailing 2-4 word phrase repeated `ngramRepeatThreshold`+ consecutively.
 *
 * @returns `{ kind, token, count, context }` or `null`.
 */
function detectRepetition(text, config, charRe) {
  const tail = text.slice(-4000);
  if (tail.length === 0) return null;

  // 1. single-character run
  const charRun = tail.match(charRe);
  if (charRun && charRun[0].length >= config.charRepeatThreshold) {
    return {
      kind: 'char-repeat',
      token: charRun[1],
      count: charRun[0].length,
      context: snippetAround(tail, charRun.index, 80),
    };
  }

  const words = tail.trim().split(/\s+/).filter(Boolean);

  // 2. trailing word repeated consecutively
  if (words.length >= config.wordRepeatThreshold) {
    const last = words[words.length - 1];
    let count = 0;
    for (let i = words.length - 1; i >= 0 && words[i] === last; i--) count++;
    if (count >= config.wordRepeatThreshold) {
      return {
        kind: 'word-repeat',
        token: last,
        count,
        context: snippetAround(tail, Math.max(0, tail.length - last.length * count), 80),
      };
    }
  }

  // 3. trailing 2-4 word phrase repeated consecutively
  for (const n of [2, 3, 4]) {
    if (words.length < n * config.ngramRepeatThreshold) continue;
    const lastN = words.slice(-n).join(' ');
    let count = 1;
    let i = words.length - n;
    while (i - n >= 0 && words.slice(i - n, i).join(' ') === lastN) {
      count++;
      i -= n;
    }
    if (count >= config.ngramRepeatThreshold) {
      return {
        kind: 'ngram-repeat',
        token: lastN,
        count,
        context: snippetAround(tail, Math.max(0, tail.length - lastN.length * count), 80),
      };
    }
  }

  return null;
}

/**
 * Scan an output buffer for a configured trigger word (case-insensitive
 * substring).
 *
 * @returns `{ kind: 'trigger-word', token, count, context }` or `null`.
 */
function detectTriggerWord(text, triggerWords) {
  if (!triggerWords || triggerWords.length === 0) return null;
  const lower = text.toLowerCase();
  for (const word of triggerWords) {
    const w = String(word).toLowerCase().trim();
    if (!w) continue;
    const idx = lower.indexOf(w);
    if (idx >= 0) {
      return {
        kind: 'trigger-word',
        token: word,
        count: 1,
        context: snippetAround(text, idx, 80),
      };
    }
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Report                                                                      */
/* -------------------------------------------------------------------------- */

/** Read the most recent session messages that contain `token`. */
function findContextWithToken(agent, token, config) {
  const session = agent?.session;
  if (!session || typeof session.snapshotEvents !== 'function') return [];
  let events;
  try {
    events = session.snapshotEvents();
  } catch {
    return [];
  }
  const messageEvents = events.filter(
    (e) => e.type === 'user/message' || e.type === 'assistant/message' || e.type === 'tool/result',
  );
  const recent = messageEvents.slice(-config.contextSearchMessages);
  const lower = String(token).toLowerCase();
  const matches = [];
  for (const e of recent) {
    const msg = e.type === 'user/message' ? e.data : e.data?.message;
    if (!msg) continue;
    const text = extractText(msg.content);
    const idx = text.toLowerCase().indexOf(lower);
    if (idx < 0) continue;
    const role = e.type === 'user/message' ? 'user' : e.type === 'assistant/message' ? 'assistant' : 'tool';
    matches.push({
      role,
      seq: e.seq,
      snippet: snippetAround(text, idx, Math.max(24, Math.floor(config.contextSnippetChars / 2))),
    });
  }
  return matches;
}

/**
 * Build the common-causes checklist. Each entry is `{ checked, cause, rec }`;
 * `checked` marks a cause the plugin auto-detected, and `rec` is the fix to
 * print (empty for non-matching rows).
 */
function buildChecklist(cfg, st, config) {
  const checks = [];

  // 1. temperature
  if (cfg?.temperature !== undefined && cfg.temperature > config.temperatureHighThreshold) {
    checks.push({
      checked: true,
      cause: `temperature is high (${cfg.temperature} > ${config.temperatureHighThreshold})`,
      rec: 'Lower the sampling temperature (e.g. to 0.2–0.5). Higher temperature makes the model more likely to re-sample the same token and loop.',
    });
  } else {
    checks.push({ checked: false, cause: `temperature is not high (${cfg?.temperature ?? 'not set'})`, rec: '' });
  }

  // 2. repetition_penalty (not exposed by DSH — always a candidate for local models)
  checks.push({
    checked: true,
    cause: 'repetition_penalty is not set (DSH does not expose it; it is a provider/server-side parameter)',
    rec: 'Set repetition_penalty to 1.05–1.2 on the model server (vLLM: `--repetition-penalty 1.1`, or the request field). This directly penalizes repeated tokens and is the most effective single fix for local models.',
  });

  // 3. context length
  const inputTokens = st.lastUsage?.inputTokens;
  if (typeof inputTokens === 'number' && inputTokens > config.contextLengthHighThreshold) {
    checks.push({
      checked: true,
      cause: `context is long (${inputTokens} input tokens > ${config.contextLengthHighThreshold})`,
      rec: 'Compact the conversation or start a fresh session. Very long contexts degrade local models and can drive repetitive output.',
    });
  } else {
    checks.push({
      checked: false,
      cause: `context length is not excessive (${inputTokens ?? 'unknown'} input tokens)`,
      rec: '',
    });
  }

  // 4. maxTokens
  if (cfg?.maxTokens !== undefined && cfg.maxTokens < config.maxTokensLowThreshold) {
    checks.push({
      checked: true,
      cause: `maxTokens is low (${cfg.maxTokens} < ${config.maxTokensLowThreshold})`,
      rec: 'Raise maxTokens. A small output budget can force the model to keep re-attempting the same content instead of finishing.',
    });
  } else {
    checks.push({ checked: false, cause: `maxTokens is not low (${cfg?.maxTokens ?? 'not set'})`, rec: '' });
  }

  // 5. reasoning effort
  if (cfg?.reasoningEffort && ['high', 'xhigh'].includes(String(cfg.reasoningEffort).toLowerCase())) {
    checks.push({
      checked: true,
      cause: `reasoning effort is high (${cfg.reasoningEffort})`,
      rec: 'Lower the reasoning effort. Excessive reasoning on a small model can loop; try `low` or `medium`.',
    });
  } else {
    checks.push({ checked: false, cause: `reasoning effort is not high (${cfg?.reasoningEffort ?? 'not set'})`, rec: '' });
  }

  // 6. model size (heuristic on the model id)
  const model = cfg?.model ?? '';
  const smallMatch = /(^|[-/ ])([0-5](\.[0-9])?)\s*b/i.exec(model);
  if (smallMatch) {
    checks.push({
      checked: true,
      cause: `model appears small (${model})`,
      rec: 'Consider a larger model for this task. Small local models degenerate into repetition more easily, especially under load or with long contexts.',
    });
  } else {
    checks.push({ checked: false, cause: `model size not flagged (${model || 'unknown'})`, rec: '' });
  }

  return checks;
}

/** Assemble the full report text. */
function buildReport(agent, st, det, bufferKind, config) {
  const cfg = st.lastConfig;
  const kindLabel = {
    'char-repeat': 'single-character run',
    'word-repeat': 'repeated word',
    'ngram-repeat': 'repeated phrase (n-gram)',
    'trigger-word': 'trigger word',
  }[det.kind] ?? det.kind;

  const lines = [];
  lines.push(`# ${config.reportSummary}`);
  lines.push('');
  lines.push(`**Detected:** ${kindLabel} — \`${det.token}\` (${det.count}×) in ${bufferKind}`);
  lines.push('');
  lines.push('**Context (where it appears):**');
  lines.push('```');
  lines.push(det.context);
  lines.push('```');
  lines.push('');

  lines.push('## Debug Information');
  lines.push('');
  lines.push(`- **Agent:** \`${agent?.id ?? 'unknown'}\``);
  lines.push(`- **Turn / Step:** ${st.turn} / ${st.step}`);
  lines.push(`- **Provider:** \`${cfg?.provider ?? 'unknown'}\``);
  lines.push(`- **Model (current weights):** \`${cfg?.model ?? 'unknown'}\``);
  lines.push(`- **temperature:** ${cfg?.temperature !== undefined ? cfg.temperature : 'not set'}`);
  lines.push(
    '- **repetition_penalty:** not exposed by DSH — it is a provider/server-side parameter (e.g. vLLM `--repetition-penalty`, or the request `repetition_penalty`). DSH sends only `temperature`, `max_tokens`, `stop`, and `reasoning_effort`.',
  );
  lines.push(`- **maxTokens:** ${cfg?.maxTokens !== undefined ? cfg.maxTokens : 'not set'}`);
  lines.push(`- **reasoningEffort:** ${cfg?.reasoningEffort ?? 'not set'}`);
  lines.push(`- **stop:** ${cfg?.stop ? JSON.stringify(cfg.stop) : 'not set'}`);
  lines.push('');

  lines.push('## Recent Tool Calls');
  lines.push('');
  if (!st.recentToolCalls.length) {
    lines.push('(none recorded for this attempt)');
  } else {
    for (const tc of st.recentToolCalls) {
      const argStr = safeStringify(tc.args);
      lines.push(`- \`${tc.name}\` — ${argStr.length > 160 ? `${argStr.slice(0, 160)}…` : argStr}`);
    }
  }
  lines.push('');

  lines.push('## Session Context Containing the Detected Token');
  lines.push('');
  const ctxMatches = findContextWithToken(agent, det.token, config);
  if (!ctxMatches.length) {
    lines.push('(no recent messages contain the token)');
  } else {
    for (const m of ctxMatches) {
      lines.push(`- **${m.role}** @ seq ${m.seq}: ${m.snippet}`);
    }
  }
  lines.push('');

  lines.push('## Common Causes Checklist');
  lines.push('');
  const checks = buildChecklist(cfg, st, config);
  for (const c of checks) {
    lines.push(`- [${c.checked ? 'x' : ' '}] **${c.cause}**${c.rec ? ` — ${c.rec}` : ''}`);
  }
  lines.push('');

  lines.push('## Recommended Fixes');
  lines.push('');
  const recs = checks.filter((c) => c.rec);
  if (!recs.length) {
    lines.push(
      '1. No single cause was auto-detected. Review the prompt for repetitive instructions, consider a larger model, and enable a server-side `repetition_penalty`.',
    );
  } else {
    recs.forEach((c, i) => lines.push(`${i + 1}. ${c.rec}`));
  }
  lines.push('');
  lines.push('_The agent was halted. Adjust the configuration above, then send a new message to continue._');

  return lines.join('\n');
}

/** JSON.stringify that never throws (falls back to a string tag). */
function safeStringify(value) {
  try {
    return JSON.stringify(value) ?? 'undefined';
  } catch {
    return String(value);
  }
}

/* -------------------------------------------------------------------------- */
/* apply                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Install the investigator's listeners.
 *
 * @param ctx - the plugin context; listeners are scoped to it and disposed with it.
 * @param config - validated {@link Config}.
 */
export function apply(ctx, config) {
  // Fail-loud validation of the numeric thresholds.
  if (config.wordRepeatThreshold < 2) throw new Error('dsh-plugin-degen-investigator: wordRepeatThreshold must be >= 2');
  if (config.ngramRepeatThreshold < 2) throw new Error('dsh-plugin-degen-investigator: ngramRepeatThreshold must be >= 2');
  if (config.charRepeatThreshold < 2) throw new Error('dsh-plugin-degen-investigator: charRepeatThreshold must be >= 2');
  if (config.reportSummary.length === 0) throw new Error('dsh-plugin-degen-investigator: reportSummary must not be empty');

  const triggerWords = config.triggerWords;
  // Pre-compiled single-char-run regex (a non-space char repeated N+ times).
  const charRe = new RegExp(`([^\\s])\\1{${Math.max(1, config.charRepeatThreshold - 1)},}`);

  /** Per-agent, process-local detection state. */
  const agents = new Map();

  function stateFor(agent) {
    let st = agents.get(agent);
    if (!st) {
      st = {
        lastConfig: undefined,
        lastUsage: undefined,
        recentToolCalls: [],
        reasoning: '',
        text: '',
        toolCall: '',
        turn: 0,
        step: 0,
        haltedTurn: -1,
      };
      agents.set(agent, st);
    }
    return st;
  }

  /**
   * Act on a detection: halt the agent, then commit the report as a
   * plugin-attributed `user/message` (rendered as a `notice` row). Guarded so a
   * single turn can only ever fire once.
   */
  function handleDetection(agent, st, det, bufferKind) {
    if (st.turn === st.haltedTurn) return; // already halted this turn
    st.haltedTurn = st.turn;

    // 1. Halt the active turn.
    try {
      agent.cancel({ kind: 'hook', reason: `dsh-plugin-degen-investigator: ${det.kind} "${det.token}" in ${bufferKind}` });
    } catch {
      // The agent may already be disposed; the report below still lands.
    }

    // 2. Build and commit the report.
    let report;
    try {
      report = buildReport(agent, st, det, bufferKind, config);
    } catch (err) {
      report = `# ${config.reportSummary}\n\nDetection fired (${det.kind}: "${det.token}" in ${bufferKind}) but the report builder failed: ${err?.message ?? err}`;
    }

    const message = createUserMessage({
      content: [{ type: 'text', text: report }],
      source: {
        kind: name,
        form: 'notice',
        summary: boundSummary(config.reportSummary),
      },
    });

    // Commit directly so the report renders immediately (a spliced-only message
    // would stay invisible until the next claim). If a direct append is
    // rejected in the current session state, park the report in the agent
    // inbox: it joins the session at the next claim and still reaches the
    // user. Never lose the report silently.
    try {
      agent.session.append('user/message', message, { surfaceOp: 'append' });
    } catch {
      try {
        agent.inject(message);
      } catch (err) {
        try {
          ctx.logger?.warn?.(
            `dsh-plugin-degen-investigator: agent "${agent.id ?? '?'}" halt landed but the report could not be committed: ${err?.message ?? err}`,
          );
        } catch {
          /* give up; the cancel already halted the turn */
        }
      }
    }
  }

  // Capture the per-request sampling config (temperature, model, etc.).
  // The loop dispatches this waterfall as { turn, step, signal } and the
  // agent-event plumbing fuses in `agent`; `await next()` resolves to the
  // final LlmCallConfig after downstream modifications.
  ctx.on('agent/request', async (payload, next) => {
    const cfg = await next();
    const agent = payload?.agent;
    if (agent && cfg && typeof cfg === 'object') stateFor(agent).lastConfig = cfg;
    return cfg;
  });

  // Detect in the live assistant stream (reasoning, text, tool-call args).
  ctx.on('agent/assistant-stream', (payload) => {
    const { agent, frame } = payload ?? {};
    if (!agent || !frame) return;
    const st = stateFor(agent);

    if (frame.type === 'start') {
      st.turn = frame.turn;
      st.step = frame.step;
      st.reasoning = '';
      st.text = '';
      st.toolCall = '';
      st.lastUsage = undefined;
      return;
    }
    if (frame.type !== 'chunk') return;

    const chunk = frame.chunk;
    if (chunk.type === 'usage') {
      st.lastUsage = chunk.usage;
      return;
    }

    let det = null;
    let bufferKind = '';
    if (chunk.type === 'reasoning-delta') {
      st.reasoning += chunk.text;
      bufferKind = 'thinking (reasoning)';
      det = detectRepetition(st.reasoning, config, charRe) ?? detectTriggerWord(st.reasoning, triggerWords);
    } else if (chunk.type === 'text-delta') {
      st.text += chunk.text;
      bufferKind = 'assistant text';
      det = detectTriggerWord(st.text, triggerWords);
    } else if (chunk.type === 'tool-call-delta') {
      st.toolCall += chunk.argumentsDelta ?? '';
      bufferKind = 'tool-call arguments';
      det = detectTriggerWord(st.toolCall, triggerWords);
    }
    if (det) handleDetection(agent, st, det, bufferKind);
  });

  // Track recent tool calls and detect trigger words in tool output.
  // Mirror the shipped `dsh-repeat-tool-reminder` discipline: drain the
  // waterfall first (`await next()`), then act on the settled decision, and
  // return it untouched. Acting before downstream handlers could cancel the
  // agent underneath a still-running chain. Scanning both the raw result
  // content and any `block` feedback covers every text that surfaced.
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const downstream = await next();
    const agent = exec?.agent;
    if (agent) {
      const st = stateFor(agent);
      st.recentToolCalls.push({ name: exec.name, args: exec.arguments, time: Date.now() });
      if (st.recentToolCalls.length > config.recentToolCalls) st.recentToolCalls.shift();
      const surfaced = `${extractText(result?.content)} ${extractText(downstream?.feedback)}`;
      const det = detectTriggerWord(surfaced, triggerWords);
      if (det) handleDetection(agent, st, det, `tool result (${exec.name})`);
    }
    return downstream;
  });

  // Drop per-agent state when an agent is disposed.
  ctx.on('agent/disposed', (payload) => {
    if (payload?.agent) agents.delete(payload.agent);
  });

  return () => {
    agents.clear();
  };
}

export { Config, name };
