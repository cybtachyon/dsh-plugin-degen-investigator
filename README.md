# Repetitive Degeneration Investigator

A DeepSeek Harness **Host** Cordis plugin that watches a running agent and, when it
detects **repetitive-token degeneration** or a **configured trigger word**, halts the
agent and prints a debug report into the conversation.

## Online Install

```bash
dsh plugin --profile web add github:cybtachyon/dsh-plugin-degen-investigator
```

## What it detects

1. **Repetitive-token degeneration** (always on) — the model loops on:
   - a repeated **word** (`wordRepeatThreshold`, default 6×) in its thinking,
   - a repeated **2–4 word phrase** (`ngramRepeatThreshold`, default 3×) in its thinking,
   - a **single-character run** (`charRepeatThreshold`, default 20×) in its thinking.
2. **Trigger words** (user-configurable) — any word in `triggerWords` that appears in
   **thinking**, **assistant text**, **tool-call arguments**, or **tool results**
   immediately triggers the investigator.

## What it does on a hit

1. **Halts** the active turn via `agent.cancel({ kind: 'hook' })`.
2. **Prints** a report into the conversation as a plugin-attributed message rendered
   as a collapsed **notice** row whose one-line account is
   `Repetitive Degeneration Detected` (expandable for the full report). The report
   includes:
   - the detected token, where it appears, and the surrounding context;
   - **debug information**: agent id, turn/step, provider, **model (current
     weights)**, `temperature`, `repetition_penalty` status (not exposed by DSH —
     it is a provider/server-side parameter), `maxTokens`, `reasoningEffort`, `stop`;
   - **recent tool calls**;
   - **session context** containing the detected token;
   - a **common-causes checklist** (auto-detected where possible: high temperature,
     missing `repetition_penalty`, long context, low `maxTokens`, high reasoning
     effort, small model);
   - a numbered list of **recommended fixes**.
3. Leaves the agent **idle**. Resume by sending a new message.

## Configuration

The plugin row's `config` (see `cordis.patch.yml`):

| Key | Default | Meaning |
| --- | --- | --- |
| `triggerWords` | `[]` | Words that immediately trigger the investigator when found in any output surface. |
| `wordRepeatThreshold` | `6` | Same word repeated N+ times consecutively in reasoning = degeneration. |
| `ngramRepeatThreshold` | `3` | Same 2–4 word phrase repeated N+ times consecutively in reasoning = degeneration. |
| `charRepeatThreshold` | `20` | Same non-space character repeated N+ times in a row = degeneration. |
| `temperatureHighThreshold` | `0.8` | Checklist flags "temperature too high" above this. |
| `maxTokensLowThreshold` | `512` | Checklist flags "maxTokens too low" below this. |
| `contextLengthHighThreshold` | `200000` | Checklist flags "context too long" above this (input tokens). |
| `recentToolCalls` | `5` | How many recent tool calls to include in the report. |
| `contextSearchMessages` | `20` | How many recent session messages to search for the detected token. |
| `contextSnippetChars` | `240` | Snippet width around a detected token in the report. |
| `reportSummary` | `Repetitive Degeneration Detected` | The one-line account shown on the collapsed report row. |

## Offline Install

```
plugin_manager install_bundle <absolute path to this directory>
```

The bundle mounts the `dsh-plugin-degen-investigator` plugin row. Adjust the
`config` in the row (or via Settings) to add trigger words and tune thresholds.

## Notes

- Detection is **process-local and per-agent**; nothing is persisted beyond the
  committed report message.
- `repetition_penalty` is intentionally reported as *not set* because DSH does not
  expose it — it must be set on the model server (e.g. vLLM `--repetition-penalty`)
  or in the provider request.
- "Current weights" is reported as the active **provider + model** of the request,
  which identifies the loaded model weights (e.g. a local vLLM model id).
