// ─────────────────────────────────────────────────────────────
// voice-mode 的 Host 半身：Edge TTS 合成路由。
//
// 为什么走 /api 的精确 Fetch 路由（而不是 webServer 裸路由）：
//   桌面端页面 origin 是 dsh-app://app，裸 HTTP 路由拿不到会话鉴权；
//   connection.fetch.register 注册在 /api 的 Host/Origin 栅栏与浏览器 Cookie
//   之后，客户端只需同源 POST /api/voice-mode.tts。
//
// 安全性：只在本机 profile 内提供；路由本身要求已认证浏览器连接，
// 不对外暴露。非官方 Edge 接口，客户端保留 speechSynthesis 回退。
//
// 维护提示：
//   · edge-tts 版本变化后先跑 `python -m edge_tts --list-voices` 确认还能通；
//   · 音色白名单在下方 VOICES，客户端 options 需同步；
//   · 若 Python 路径变化，用环境变量 VOICE_MODE_PYTHON 覆盖。
// ─────────────────────────────────────────────────────────────
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const ROUTE_PATH = '/api/voice-mode.tts';
const CONTROL_PATH = '/api/voice-mode.control';
const VOICES = [
  'zh-CN-XiaoxiaoNeural',
  'zh-CN-XiaoyiNeural',
  'zh-CN-YunjianNeural',
  'zh-CN-YunxiNeural',
  'zh-CN-YunxiaNeural',
  'zh-CN-YunyangNeural',
  'zh-CN-liaoning-XiaobeiNeural',
  'zh-CN-shaanxi-XiaoniNeural'
];
const MAX_TEXT = 500;
const CACHE_LIMIT = 50;
const RATE_LIMIT_PER_MINUTE = 20;
const DEFAULT_TIMEOUT_MS = 10000;

const cache = new Map();
const requestTimes = [];
const controlQueue = [];
const CONTROL_LIMIT = 10;
let pythonPath = null;
let clientStatus = null;
let edgeTtsProbe = null;

async function probeEdgeTts() {
  if (edgeTtsProbe !== null) return edgeTtsProbe;
  try {
    const { stdout } = await execFileAsync(
      resolvePython(),
      ['-c', "import importlib.metadata as m; print(m.version('edge-tts'))"],
      { timeout: 5000, windowsHide: true }
    );
    edgeTtsProbe = { status: 'ok', version: String(stdout).trim() };
  } catch (error) {
    const stderr = String((error && error.stderr) || '');
    edgeTtsProbe =
      /No module named ['"]?edge_tts|PackageNotFoundError|No package metadata/i.test(stderr)
        ? { status: 'missing', version: null }
        : { status: 'unknown', version: null };
  }
  return edgeTtsProbe;
}

function resolvePython() {
  if (pythonPath !== null) return pythonPath;
  const candidates = [
    process.env.VOICE_MODE_PYTHON,
    'C:/Users/Lenovo/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/python.exe',
    'python'
  ].filter((value) => typeof value === 'string' && value !== '');
  for (const candidate of candidates) {
    if (candidate === 'python' || existsSync(candidate)) {
      pythonPath = candidate;
      return candidate;
    }
  }
  pythonPath = 'python';
  return pythonPath;
}

function signed(value, unit) {
  const rounded = Math.round(Number(value) || 0);
  return `${rounded >= 0 ? '+' : ''}${rounded}${unit}`;
}

function clampInteger(value, min, max, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, Math.round(numeric)));
}

function badRequest(message) {
  return Response.json({ error: 'bad-request', message }, { status: 400, headers: { 'cache-control': 'no-store' } });
}

function classifyError(error) {
  if (error && (error.killed === true || error.signal)) return 'timeout';
  const stderr = String((error && error.stderr) || '');
  if (/No module named ['"]?edge_tts/i.test(stderr)) return 'missing-edge-tts';
  if (error && error.code === 'ENOENT') return 'missing-python';
  return 'synthesis-failed';
}

async function synthesize(text, voice, rate, volume, pitch, timeoutMs) {
  const key = createHash('sha256').update([text, voice, rate, volume, pitch].join('\u0000')).digest('hex');
  const cached = cache.get(key);
  if (cached !== undefined) {
    cache.delete(key);
    cache.set(key, cached);
    return cached;
  }
  const directory = await mkdtemp(path.join(tmpdir(), 'voice-mode-'));
  const media = path.join(directory, 'out.mp3');
  try {
    await execFileAsync(
      resolvePython(),
      [
        '-m',
        'edge_tts',
        '--text',
        text,
        '--voice',
        voice,
        '--rate',
        signed(rate, '%'),
        '--volume',
        signed(volume, '%'),
        '--pitch',
        signed(pitch, 'Hz'),
        '--write-media',
        media
      ],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }
    );
    const buffer = await readFile(media);
    cache.set(key, buffer);
    while (cache.size > CACHE_LIMIT) {
      const oldest = cache.keys().next().value;
      cache.delete(oldest);
    }
    return buffer;
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}

async function handleRoute(request) {
  if (request.method === 'GET') {
    const edge = await probeEdgeTts();
    return Response.json(
      {
        engine: 'edge-tts',
        voices: VOICES.length,
        cache: cache.size,
        python: resolvePython(),
        edgeTts: edge.status,
        edgeTtsVersion: edge.version
      },
      { headers: { 'cache-control': 'no-store' } }
    );
  }
  const now = Date.now();
  while (requestTimes.length > 0 && now - requestTimes[0] > 60000) requestTimes.shift();
  if (requestTimes.length >= RATE_LIMIT_PER_MINUTE) {
    return Response.json({ error: 'rate-limited', message: 'too many synthesis requests' }, { status: 429, headers: { 'cache-control': 'no-store' } });
  }
  let payload;
  try {
    payload = await request.json();
  } catch (_error) {
    return badRequest('body must be JSON');
  }
  if (payload === null || typeof payload !== 'object') return badRequest('body must be an object');
  const text = typeof payload.text === 'string' ? payload.text.trim() : '';
  if (text === '' || text.length > MAX_TEXT) return badRequest(`text must be 1..${MAX_TEXT} characters`);
  const voice = typeof payload.voice === 'string' ? payload.voice : VOICES[1];
  if (VOICES.indexOf(voice) < 0) return badRequest('voice is not in the allow-list');
  const rate = clampInteger(payload.rate, -50, 50, 10);
  const volume = clampInteger(payload.volume, -50, 50, 0);
  const pitch = clampInteger(payload.pitch, -50, 50, 0);
  const timeoutMs = clampInteger(payload.timeoutMs, 3000, 30000, DEFAULT_TIMEOUT_MS);
  requestTimes.push(now);
  try {
    const buffer = await synthesize(text, voice, rate, volume, pitch, timeoutMs);
    return new Response(buffer, {
      status: 200,
      headers: {
        'content-type': 'audio/mpeg',
        'content-length': String(buffer.length),
        'cache-control': 'no-store',
        'x-voice-mode-engine': 'edge-tts'
      }
    });
  } catch (error) {
    const reason = classifyError(error);
    const status = reason === 'timeout' ? 504 : reason === 'synthesis-failed' ? 502 : 503;
    const message =
      reason === 'missing-edge-tts'
        ? 'edge-tts is not installed in the DSH Python runtime (python -m pip install edge-tts)'
        : reason === 'missing-python'
          ? 'Python runtime not found (set VOICE_MODE_PYTHON)'
          : reason === 'timeout'
            ? 'synthesis timed out'
            : 'synthesis failed';
    return Response.json({ error: reason, message }, { status, headers: { 'cache-control': 'no-store' } });
  }
}

function enqueueCommand(action, text) {
  const command = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    action,
    at: Date.now()
  };
  if (typeof text === 'string') command.text = text.slice(0, 500);
  controlQueue.push(command);
  while (controlQueue.length > CONTROL_LIMIT) controlQueue.shift();
  return command;
}

async function handleControl(request) {
  if (request.method === 'GET') {
    const commands = controlQueue.splice(0, controlQueue.length);
    return Response.json({ commands, status: clientStatus }, { headers: { 'cache-control': 'no-store' } });
  }
  let payload;
  try {
    payload = await request.json();
  } catch (_error) {
    return badRequest('body must be JSON');
  }
  if (payload !== null && typeof payload === 'object') {
    clientStatus = { ...payload, at: Date.now() };
  }
  return Response.json({ ok: true }, { headers: { 'cache-control': 'no-store' } });
}

const voiceModeTool = {
  name: 'voice_mode',
  description: [
    'Control the local voice-chat plugin running in the open DSH window.',
    'Use it only when the user asks for hands-free/automated voice interaction (for example "open the microphone and call me").',
    'Actions: enable (open the microphone in the currently open session), disable (close it), speak (read text aloud with the configured TTS engine), status (report what the window last said).',
    'Commands are queued and applied by the browser within about 1.5 seconds; the returned status is the window report from its latest poll, not a synchronous result.'
  ].join(' '),
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['enable', 'disable', 'speak', 'status'], description: 'Voice-chat operation to perform.' },
      text: { type: 'string', description: 'Text to read aloud, required for speak; at most 500 characters.' }
    },
    required: ['action'],
    additionalProperties: false
  },
  output: {
    schema: { type: 'object', additionalProperties: true },
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]
  },
  execute: async (args) => {
    const action = args && typeof args.action === 'string' ? args.action : '';
    if (['enable', 'disable', 'speak', 'status'].indexOf(action) < 0) {
      throw new Error('voice_mode: unknown action');
    }
    if (action === 'status') {
      return { status: clientStatus, pending: controlQueue.length, note: clientStatus === null ? 'no client has reported yet (open or refresh the DSH window)' : 'status from the latest client poll' };
    }
    let text;
    if (action === 'speak') {
      text = args && typeof args.text === 'string' ? args.text.trim() : '';
      if (text === '') throw new Error('voice_mode: speak requires non-empty text');
    }
    const command = enqueueCommand(action, text);
    return { queued: true, action, commandId: command.id, applyWithinMs: 1500, status: clientStatus };
  }
};

export function apply(ctx) {
  ctx.inject(['connection'], (c) => {
    const disposers = [];
    c.effect(() => async () => {
      await Promise.allSettled(disposers.map((dispose) => dispose()));
    });
    disposers.push(c.connection.fetch.register({
      path: ROUTE_PATH,
      methods: ['GET', 'POST'],
      requestBody: 'buffered',
      fetch: (request) => handleRoute(request)
    }));
    disposers.push(c.connection.fetch.register({
      path: CONTROL_PATH,
      methods: ['GET', 'POST'],
      requestBody: 'buffered',
      fetch: (request) => handleControl(request)
    }));
  });
  ctx.inject(['tools'], (c) => {
    c.effect(() => c.tools.register(voiceModeTool));
  });
}
