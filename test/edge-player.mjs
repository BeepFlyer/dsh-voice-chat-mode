// 从 client-body.js 抽出 EdgePlayer 代码，用假 Audio/fetch 驱动，验证队列/停止/回退。
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../client-body.js', import.meta.url), 'utf8');
const start = source.indexOf('    // ── Edge TTS 播放器');
const end = source.indexOf('    // ── 统一播放器');
if (start < 0 || end < 0) throw new Error('EdgePlayer block not found');
const edgeBlock = source.slice(start, end);

const prelude = `
const CONFIG = {
  ttsSentenceChars: 120,
  ttsEdgeTimeoutMs: 5000,
  ttsEdgePrefetch: false,
  ttsEdgeVoice: 'zh-CN-XiaoyiNeural',
  ttsEdgeRate: 10,
  ttsEdgeVolume: 0,
  ttsEdgePitch: 0,
  ttsPauseMs: 0,
  ttsFallbackToSystem: true
};
function splitSentences(text, maxChars) {
  const raw = String(text).trim();
  if (!raw) return [];
  const pieces = raw.split(/(?<=[。！？!?；;\\n])/);
  return pieces.map((p) => p.trim()).filter(Boolean);
}
const created = [];
const revoked = [];
globalThis.__fetched = [];
globalThis.URL.createObjectURL = (blob) => { created.push(blob); return 'blob:' + created.length; };
globalThis.URL.revokeObjectURL = (url) => { revoked.push(url); };
class FakeAudio {
  constructor() { this.src = ''; this.paused = false; this.ended = false; this.onended = null; this.onerror = null; this.played = false; }
  play() { this.played = true; return Promise.resolve(); }
  pause() { this.paused = true; }
  end() { this.ended = true; if (this.onended) this.onended(); }
}
globalThis.Audio = FakeAudio;
globalThis.fetch = (url, init) => {
  globalThis.__fetched.push({ url, body: JSON.parse(init.body), signal: init.signal });
  return new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new Error('aborted')));
    setTimeout(() => resolve({ ok: true, blob: async () => ({ size: 1, text: JSON.parse(init.body).text }) }), 5);
  });
};
`;

const exportsLine = `
globalThis.__EdgePlayer = EdgePlayer;
`;

const moduleCode = prelude + edgeBlock + exportsLine;
const dataUrl = 'data:text/javascript;base64,' + Buffer.from(moduleCode).toString('base64');
await import(dataUrl);

const EdgePlayer = globalThis.__EdgePlayer;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const realFetch = globalThis.fetch;

function makePlayer(events, logs, fallbacks) {
  const player = new EdgePlayer(
    (speaking) => events.push(speaking),
    (message) => logs.push(message),
    (text) => fallbacks.push(text)
  );
  return player;
}

function currentAudio() {
  return created.length > 0 ? null : null;
}

console.log('== A. multi-segment order ==');
{
  const events = [];
  const logs = [];
  const fallbacks = [];
  const player = makePlayer(events, logs, fallbacks);
  player.append('第一段。');
  player.append('第二段。');
  player.append('第三段。');
  await sleep(30);
  // 逐句结束
  for (let i = 0; i < 3; i += 1) {
    const audio = player.audio;
    if (!audio) throw new Error('audio missing at ' + i);
    console.log('playing', i + 1, 'text', audio.src, 'queue', JSON.stringify(player.queue), 'index', player.index);
    audio.end();
    await sleep(20);
  }
  console.log('events', JSON.stringify(events), 'logs', JSON.stringify(logs.slice(0, 3)), 'fallbacks', fallbacks.length);
}

console.log('== B. stop is immediate ==');
{
  const events = [];
  const logs = [];
  const fallbacks = [];
  const player = makePlayer(events, logs, fallbacks);
  player.append('停止测试一。停止测试二。');
  await sleep(30);
  const before = player.audio;
  player.cancel();
  console.log('after cancel speaking', player.isSpeaking(), 'audio paused', before ? before.paused : null, 'events', JSON.stringify(events), 'queue', player.queue.length);
  await sleep(50);
  console.log('fetch count after cancel', globalThis.__fetched.length, 'events after wait', JSON.stringify(events));
}

console.log('== C. failure falls back ==');
{
  const events = [];
  const logs = [];
  const fallbacks = [];
  globalThis.fetch = () => Promise.resolve({ ok: false, status: 503, json: async () => ({ error: 'missing-edge-tts', message: 'edge-tts is not installed' }) });
  const player = makePlayer(events, logs, fallbacks);
  player.append('回退测试一。回退测试二。');
  // 先失败一次 → 400ms 后重试 → 再失败 → 回退，因此等久一点再看结果。
  await sleep(700);
  console.log('fallback payload', JSON.stringify(fallbacks), 'logs', JSON.stringify(logs), 'speaking', player.isSpeaking());
  globalThis.fetch = realFetch;
}

console.log('== D. remaining text for barge-in resume ==');
{
  const events = [];
  const logs = [];
  const fallbacks = [];
  const player = makePlayer(events, logs, fallbacks);
  player.append('第一句。第二句。第三句。');
  await sleep(40);
  const remaining = player.remainingText();
  console.log('remaining', JSON.stringify(remaining), 'isSpeaking', player.isSpeaking());
  if (!remaining.includes('第二句') || !remaining.includes('第三句')) throw new Error('remaining text lost queued sentences');
  if (!remaining.includes('第一句')) throw new Error('remaining text lost the sentence in flight');
}
