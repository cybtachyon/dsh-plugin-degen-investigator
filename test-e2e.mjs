// End-to-end sanity test for the dsh-plugin-degen-investigator plugin.
// Simulates the Cordis event surface and verifies detection -> halt -> report.
import { apply, Config, name } from './index.js';

let pass = 0, fail = 0;
function check(label, cond) {
  if (cond) { pass++; console.log(`  ok  ${label}`); }
  else { fail++; console.log(` FAIL ${label}`); }
}

// --- mock Cordis context: capture listeners, dispatch on demand ---
function makeCtx() {
  const listeners = new Map(); // event -> [handlers]
  return {
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(handler);
    },
    async emit(event, ...args) {
      for (const h of listeners.get(event) ?? []) await h(...args);
    },
    // waterfall: handlers are called with (...args, next); the last next() yields base
    async emitWaterfall(event, args, base) {
      const hs = listeners.get(event) ?? [];
      let i = 0;
      const next = async () => {
        if (i < hs.length) {
          const h = hs[i++];
          return h(...args, next);
        }
        return base;
      };
      return next();
    },
  };
}

// --- mock agent ---
function makeAgent() {
  const appended = [];
  const cancelled = [];
  const agent = {
    id: 'agent-test',
    cancel(opts) { cancelled.push(opts); },
    inject(msg) { appended.push({ via: 'inject', msg }); },
    session: {
      append(type, msg, opts) { appended.push({ via: 'append', type, msg, opts }); },
      snapshotEvents() { return [
        { seq: 1, type: 'user/message', data: { content: [{ type: 'text', text: 'please help me' }] } },
        { seq: 2, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'I will do it I will do it I will do it I will do it I will do it' }] } } },
      ]; },
    },
    _appended: appended,
    _cancelled: cancelled,
  };
  return agent;
}

const config = {
  triggerWords: ['POISON'],
  wordRepeatThreshold: 6,
  ngramRepeatThreshold: 3,
  charRepeatThreshold: 20,
  temperatureHighThreshold: 0.8,
  maxTokensLowThreshold: 512,
  contextLengthHighThreshold: 200000,
  recentToolCalls: 5,
  contextSearchMessages: 20,
  contextSnippetChars: 240,
  reportSummary: 'Repetitive Degeneration Detected',
};

console.log(`\n=== ${name} end-to-end test ===\n`);

// --- Test 1: repetitive reasoning (word-repeat) triggers halt + report ---
{
  const ctx = makeCtx();
  const agent = makeAgent();
  apply(ctx, config);

  const baseCfg = { provider: 'vllm', model: 'qwen38-27b', temperature: 0.7, maxTokens: 4096 };
  await ctx.emitWaterfall('agent/request', [{ agent }], baseCfg);

  await ctx.emit('agent/assistant-stream', { agent, frame: { type: 'start', turn: 3, step: 1 } });
  await ctx.emit('agent/assistant-stream', { agent, frame: { type: 'chunk', chunk: { type: 'reasoning-delta', text: 'the '.repeat(12) } } });

  check('word-repeat: agent.cancel called', agent._cancelled.length === 1);
  check('word-repeat: cancel kind=hook', agent._cancelled[0]?.kind === 'hook');
  check('word-repeat: report appended', agent._appended.length === 1);
  const msg = agent._appended[0]?.msg;
  check('word-repeat: message is user role', msg?.role === 'user');
  check('word-repeat: source.form=notice', msg?.source?.form === 'notice');
  check('word-repeat: summary is reportSummary', msg?.source?.summary === config.reportSummary);
  const text = msg?.content?.[0]?.text ?? '';
  check('word-repeat: report has title', text.includes('# ' + config.reportSummary));
  check('word-repeat: report names detection (repeated word)', /repeated word/i.test(text));
  check('word-repeat: report has temperature', /temperature/i.test(text));
  check('word-repeat: report has repetition_penalty note', /repetition_penalty/i.test(text));
  check('word-repeat: report has model/weights', /qwen38-27b/i.test(text));
  check('word-repeat: report has causes checklist', /Common Causes Checklist/i.test(text));
  check('word-repeat: report has recommended fixes', /Recommended Fixes/i.test(text));

  await ctx.emit('agent/assistant-stream', { agent, frame: { type: 'chunk', chunk: { type: 'reasoning-delta', text: ' the' } } });
  check('word-repeat: no double-halt in same turn', agent._cancelled.length === 1);
}

// --- Test 2: trigger word in reasoning ---
{
  const ctx = makeCtx();
  const agent = makeAgent();
  apply(ctx, config);
  await ctx.emitWaterfall('agent/request', [{ agent }], { provider: 'vllm', model: 'qwen38-27b', temperature: 0.2 });
  await ctx.emit('agent/assistant-stream', { agent, frame: { type: 'start', turn: 1, step: 1 } });
  await ctx.emit('agent/assistant-stream', { agent, frame: { type: 'chunk', chunk: { type: 'reasoning-delta', text: 'thinking about the POISON word here' } } });
  check('trigger-word(reasoning): cancel called', agent._cancelled.length === 1);
  check('trigger-word(reasoning): report names trigger word', /trigger word/i.test(agent._appended[0]?.msg?.content?.[0]?.text ?? ''));
  check('trigger-word(reasoning): report mentions trigger', (agent._appended[0]?.msg?.content?.[0]?.text ?? '').includes('POISON'));
}

// --- Test 3: trigger word in tool result ---
{
  const ctx = makeCtx();
  const agent = makeAgent();
  apply(ctx, config);
  await ctx.emitWaterfall('agent/request', [{ agent }], { provider: 'vllm', model: 'qwen38-27b', temperature: 0.2 });
  await ctx.emit('agent/assistant-stream', { agent, frame: { type: 'start', turn: 2, step: 1 } });
  await ctx.emitWaterfall('tools/post-execute', [
    { agent, name: 'bash', arguments: '{"cmd":"ls"}' },
    { content: [{ type: 'text', text: 'output contains POISON marker' }] },
  ], {});
  check('trigger-word(tool result): cancel called', agent._cancelled.length === 1);
  check('trigger-word(tool result): report mentions tool', (agent._appended[0]?.msg?.content?.[0]?.text ?? '').includes('bash'));
}

// --- Test 4: normal text does NOT trigger ---
{
  const ctx = makeCtx();
  const agent = makeAgent();
  apply(ctx, config);
  await ctx.emitWaterfall('agent/request', [{ agent }], { provider: 'vllm', model: 'qwen38-27b', temperature: 0.2 });
  await ctx.emit('agent/assistant-stream', { agent, frame: { type: 'start', turn: 1, step: 1 } });
  await ctx.emit('agent/assistant-stream', { agent, frame: { type: 'chunk', chunk: { type: 'reasoning-delta', text: 'Let me think about this carefully and plan the next step.' } } });
  await ctx.emit('agent/assistant-stream', { agent, frame: { type: 'chunk', chunk: { type: 'text-delta', text: 'Here is my answer to your question.' } } });
  check('normal text: no cancel', agent._cancelled.length === 0);
  check('normal text: no report', agent._appended.length === 0);
}

// --- Test 5: char-repeat (single char run) ---
{
  const ctx = makeCtx();
  const agent = makeAgent();
  apply(ctx, config);
  await ctx.emitWaterfall('agent/request', [{ agent }], { provider: 'vllm', model: 'qwen38-27b', temperature: 0.2 });
  await ctx.emit('agent/assistant-stream', { agent, frame: { type: 'start', turn: 1, step: 1 } });
  await ctx.emit('agent/assistant-stream', { agent, frame: { type: 'chunk', chunk: { type: 'reasoning-delta', text: 'a'.repeat(40) } } });
  check('char-repeat: cancel called', agent._cancelled.length === 1);
  check('char-repeat: report names single-character run', /single-character run/i.test(agent._appended[0]?.msg?.content?.[0]?.text ?? ''));
}

// --- Test 6: ngram-repeat (repeated phrase) ---
{
  const ctx = makeCtx();
  const agent = makeAgent();
  apply(ctx, config);
  await ctx.emitWaterfall('agent/request', [{ agent }], { provider: 'vllm', model: 'qwen38-27b', temperature: 0.2 });
  await ctx.emit('agent/assistant-stream', { agent, frame: { type: 'start', turn: 1, step: 1 } });
  await ctx.emit('agent/assistant-stream', { agent, frame: { type: 'chunk', chunk: { type: 'reasoning-delta', text: 'I will do it '.repeat(5) } } });
  check('ngram-repeat: cancel called', agent._cancelled.length === 1);
  check('ngram-repeat: report names repeated phrase', /repeated phrase/i.test(agent._appended[0]?.msg?.content?.[0]?.text ?? ''));
}

// --- Test 7: apply() validates thresholds (throws on bad config) ---
{
  const ctx = makeCtx();
  let threw = false;
  try { apply(ctx, { ...config, wordRepeatThreshold: 1 }); } catch { threw = true; }
  check('apply: rejects wordRepeatThreshold < 2', threw);
  let threw2 = false;
  try { apply(ctx, { ...config, reportSummary: '' }); } catch { threw2 = true; }
  check('apply: rejects empty reportSummary', threw2);
}

// --- Config schema (Standard Schema) ---
{
  const std = Config['~standard'];
  check('Config has ~standard v1', std?.version === 1);
  const r1 = std.validate({});
  check('Config validate({}) -> value with defaults', r1 && !r1.issues && r1.value.wordRepeatThreshold === 6);
  const r2 = std.validate({ triggerWords: ['abc'] });
  check('Config validate(triggerWords) -> value', r2 && !r2.issues && r2.value.triggerWords[0] === 'abc');
}

console.log(`\n=== result: ${pass} passed, ${fail} failed ===\n`);
process.exit(fail === 0 ? 0 : 1);
