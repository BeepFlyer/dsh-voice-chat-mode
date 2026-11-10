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
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const ROUTE_PATH = '/api/voice-mode.tts';
const CONTROL_PATH = '/api/voice-mode.control';
const DIAG_PATH = '/api/voice-mode.log';
const ASR_PATH = '/api/voice-mode.asr';
const ASR_CONFIG_PATH = '/api/voice-mode.asr/config';
const ASR_TEST_PATH = '/api/voice-mode.asr/test';
const ASR_FILE = path.join(homedir(), '.dsh', 'voice-mode', 'asr.json');
const VAD_PATH = '/api/voice-mode.vad';
const VAD_FILE = path.join(homedir(), '.dsh', 'voice-mode', 'vad.json');
const VAD_KEYS = ['energyThreshold', 'silenceMs', 'preRollMs', 'minSpeechMs', 'maxSeconds', 'cooldownMs', 'frameSize'];
const ASR_AUDIO_LIMIT = 10 * 1024 * 1024;
const DIAG_MAX_BYTES = 4 * 1024 * 1024;
const DIAG_MAX_EVENTS = 500;
const diagMarkerWritten = new Set();

function localDay(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate());
}
const pluginDir = path.dirname(fileURLToPath(import.meta.url));
// 自带依赖目录：npm 包内包含 edge-tts 及其依赖（vendor/python），
// 优先用它而不是系统 site-packages，避免 DSH 重建运行时后丢包。
const vendorDir = path.join(pluginDir, 'vendor', 'python');
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

function pythonEnv() {
  const env = { ...process.env };
  if (existsSync(path.join(vendorDir, 'edge_tts'))) {
    env.PYTHONPATH = env.PYTHONPATH ? vendorDir + path.delimiter + env.PYTHONPATH : vendorDir;
    env.PYTHONNOUSERSITE = '1';
  }
  return env;
}

async function probeEdgeTts() {
  if (edgeTtsProbe !== null) return edgeTtsProbe;
  try {
    const { stdout } = await execFileAsync(
      resolvePython(),
      ['-c', "import importlib.metadata as m; print(m.version('edge-tts'))"],
      { timeout: 5000, windowsHide: true, env: pythonEnv() }
    );
    edgeTtsProbe = {
      status: 'ok',
      version: String(stdout).trim(),
      source: existsSync(path.join(vendorDir, 'edge_tts')) ? 'vendor' : 'system'
    };
  } catch (error) {
    const stderr = String((error && error.stderr) || '');
    edgeTtsProbe =
      /No module named ['"]?edge_tts|PackageNotFoundError|No package metadata/i.test(stderr)
        ? { status: 'missing', version: null, source: null }
        : { status: 'unknown', version: null, source: null };
  }
  return edgeTtsProbe;
}

// 自带依赖缺失时自动装进插件目录（一次性），用户无需手动 pip。
let ensureEdgeTtsPromise = null;
async function ensureEdgeTts() {
  if (edgeTtsProbe !== null && edgeTtsProbe.status === 'ok') return true;
  if (ensureEdgeTtsPromise !== null) return ensureEdgeTtsPromise;
  ensureEdgeTtsPromise = (async () => {
    try {
      await execFileAsync(
        resolvePython(),
        ['-m', 'pip', 'install', 'edge-tts', '--target', vendorDir, '--no-cache-dir', '--quiet', '--disable-pip-version-check'],
        { timeout: 240000, windowsHide: true }
      );
      edgeTtsProbe = null;
      const probe = await probeEdgeTts();
      return probe.status === 'ok';
    } catch (_error) {
      return false;
    } finally {
      ensureEdgeTtsPromise = null;
    }
  })();
  return ensureEdgeTtsPromise;
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
    for (let attempt = 0; ; attempt += 1) {
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
          { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024, env: pythonEnv() }
        );
        break;
      } catch (error) {
        // 首次缺包：自动装进插件自带目录后重试一次，不让用户手装 pip 包。
        if (
          attempt === 0 &&
          (classifyError(error) === 'missing-edge-tts' || /DLL load failed|ImportError|ModuleNotFoundError/i.test(String((error && error.stderr) || ''))) &&
          (await ensureEdgeTts())
        ) {
          continue;
        }
        throw error;
      }
    }
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
        edgeTtsVersion: edge.version,
        edgeTtsSource: edge.source
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

// ── ASR 引擎配置（~/.dsh/voice-mode/asr.json；Key 只在 host 侧，永不回显）──
function asrDefaults() {
  return {
    engine: 'dsh',
    dashscope: {
      apiKey: '',
      region: 'cn-beijing',
      workspaceId: '',
      language: 'zh',
      enableItn: false,
      timeoutMs: 15000
    }
  };
}

function readAsrConfig() {
  const fallback = asrDefaults();
  try {
    const parsed = JSON.parse(readFileSync(ASR_FILE, 'utf8'));
    if (parsed === null || typeof parsed !== 'object') return fallback;
    const ds = parsed.dashscope !== null && typeof parsed.dashscope === 'object' ? parsed.dashscope : {};
    const engine = ['dsh', 'dashscope', 'off'].includes(parsed.engine) ? parsed.engine : 'dsh';
    const region = ['cn-beijing', 'ap-southeast-1', 'us-east-1'].includes(ds.region) ? ds.region : 'cn-beijing';
    const timeout = Number(ds.timeoutMs);
    return {
      engine,
      dashscope: {
        apiKey: typeof ds.apiKey === 'string' ? ds.apiKey : '',
        region,
        workspaceId: typeof ds.workspaceId === 'string' ? ds.workspaceId : '',
        language: typeof ds.language === 'string' && ds.language !== '' ? ds.language : 'zh',
        enableItn: ds.enableItn === true,
        timeoutMs: Number.isFinite(timeout) && timeout >= 1000 && timeout <= 60000 ? Math.round(timeout) : 15000
      }
    };
  } catch (_error) {
    return fallback;
  }
}

function saveAsrConfig(next) {
  mkdirSync(path.dirname(ASR_FILE), { recursive: true });
  writeFileSync(ASR_FILE, JSON.stringify(next, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
}

function asrStatus() {
  const cfg = readAsrConfig();
  return {
    ok: true,
    engine: cfg.engine,
    hasKey: cfg.dashscope.apiKey !== '',
    region: cfg.dashscope.region,
    workspaceId: cfg.dashscope.workspaceId,
    language: cfg.dashscope.language,
    enableItn: cfg.dashscope.enableItn,
    timeoutMs: cfg.dashscope.timeoutMs
  };
}

/** 客户端给的是 16k mono WAV；若已是 RIFF 则原样用，否则补 44 字节头（兼容裸 PCM）。 */
function wavFromAudioBase64(audioBase64) {
  const bytes = Buffer.from(audioBase64, 'base64');
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF') return audioBase64;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + bytes.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24);
  header.writeUInt32LE(32000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(bytes.length, 40);
  return Buffer.concat([header, bytes]).toString('base64');
}

function dashscopeEndpoint(cfg) {
  const ds = cfg.dashscope;
  if (ds.workspaceId !== '') return 'https://' + ds.workspaceId + '.' + ds.region + '.maas.aliyuncs.com/compatible-mode/v1/chat/completions';
  const host = ds.region === 'cn-beijing' ? 'dashscope.aliyuncs.com' : 'dashscope-intl.aliyuncs.com';
  return 'https://' + host + '/compatible-mode/v1/chat/completions';
}

async function callDashScope(audioBase64, cfg) {
  const ds = cfg.dashscope;
  if (ds.apiKey === '') return { ok: false, error: 'dashscope-no-key' };
  const wavBase64 = wavFromAudioBase64(audioBase64);
  if (wavBase64.length > ASR_AUDIO_LIMIT) return { ok: false, error: 'audio-too-large' };
  const body = {
    model: 'qwen3-asr-flash',
    messages: [
      {
        role: 'user',
        content: [{ type: 'input_audio', input_audio: { data: 'data:audio/wav;base64,' + wavBase64 } }]
      }
    ],
    stream: false,
    asr_options: { language: ds.language || 'zh', enable_itn: ds.enableItn === true }
  };
  let response;
  try {
    response = await fetch(dashscopeEndpoint(cfg), {
      method: 'POST',
      headers: { authorization: 'Bearer ' + ds.apiKey, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(ds.timeoutMs)
    });
  } catch (error) {
    const name = String((error && error.name) || '');
    const code = name === 'TimeoutError' || /timeout/i.test(name) ? 'dashscope-timeout' : 'dashscope-network';
    return { ok: false, error: code };
  }
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) return { ok: false, error: 'dashscope-auth' };
    if (response.status === 429) return { ok: false, error: 'dashscope-rate-limit' };
    return { ok: false, error: 'dashscope-http-' + response.status };
  }
  let data = null;
  try {
    data = await response.json();
  } catch (_error) {
    return { ok: false, error: 'dashscope-bad-json' };
  }
  // OpenAI 兼容端点：choices[0].message.content 是字符串；兼容旧的原生 output 形状。
  const choices = data && Array.isArray(data.choices) ? data.choices : data && data.output && Array.isArray(data.output.choices) ? data.output.choices : [];
  const message = choices.length > 0 ? choices[0].message : null;
  let text = '';
  if (message && typeof message.content === 'string') {
    text = message.content;
  } else if (message && Array.isArray(message.content)) {
    text = message.content.map((part) => (typeof part === 'string' ? part : part && typeof part.text === 'string' ? part.text : '')).join('');
  }
  const annotation = message && Array.isArray(message.annotations) && message.annotations.length > 0 && message.annotations[0] !== null && typeof message.annotations[0] === 'object' ? message.annotations[0] : {};
  return { ok: true, text, emotion: typeof annotation.emotion === 'string' ? annotation.emotion : '', language: typeof annotation.language === 'string' ? annotation.language : '' };
}

function pickVadConfig(input) {
  const out = {};
  if (input === null || typeof input !== 'object') return out;
  for (const key of VAD_KEYS) {
    const value = Number(input[key]);
    if (Number.isFinite(value)) out[key] = value;
  }
  return out;
}

async function handleVadRoute(request) {
  if (request.method === 'GET') {
    try {
      if (!existsSync(VAD_FILE)) return Response.json({ ok: true, config: null }, { headers: { 'cache-control': 'no-store' } });
      const parsed = JSON.parse(readFileSync(VAD_FILE, 'utf8'));
      return Response.json({ ok: true, config: pickVadConfig(parsed) }, { headers: { 'cache-control': 'no-store' } });
    } catch (error) {
      return Response.json({ ok: false, error: 'read failed: ' + String((error && error.message) || error) }, { headers: { 'cache-control': 'no-store' } });
    }
  }
  if (request.method !== 'POST') {
    return Response.json({ ok: false, error: 'method-not-allowed' }, { status: 405, headers: { 'cache-control': 'no-store' } });
  }
  try {
    const payload = await request.json();
    const config = pickVadConfig(payload && payload.config ? payload.config : payload);
    if (Object.keys(config).length === 0) return badRequest('no vad fields');
    mkdirSync(path.dirname(VAD_FILE), { recursive: true });
    writeFileSync(VAD_FILE, JSON.stringify(config, null, 2) + '\n', 'utf8');
    return Response.json({ ok: true, config }, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    return Response.json({ ok: false, error: String((error && error.message) || error) }, { status: 500, headers: { 'cache-control': 'no-store' } });
  }
}

async function handleAsrRoute(request) {
  if (request.method !== 'POST') {
    return Response.json({ ok: false, error: 'method-not-allowed' }, { status: 405, headers: { 'cache-control': 'no-store' } });
  }
  try {
    let payload;
    try {
      payload = await request.json();
    } catch (_error) {
      return badRequest('body must be JSON');
    }
    const audioBase64 = payload && typeof payload.audioBase64 === 'string' ? payload.audioBase64 : '';
    if (audioBase64 === '') return badRequest('audioBase64 is required');
    if (audioBase64.length > ASR_AUDIO_LIMIT) {
      return Response.json({ ok: false, error: 'audio-too-large', text: '' }, { status: 413, headers: { 'cache-control': 'no-store' } });
    }
    const cfg = readAsrConfig();
    if (cfg.engine === 'off') {
      return Response.json({ ok: true, text: '', engine: 'off' }, { headers: { 'cache-control': 'no-store' } });
    }
    if (cfg.engine === 'dsh') {
      // 没有 host 侧 speech 服务；回 'engine-dsh'，由 client 回落到官方 remote speech。
      return Response.json({ ok: false, error: 'engine-dsh', engine: 'dsh' }, { headers: { 'cache-control': 'no-store' } });
    }
    const startedAt = Date.now();
    const result = await callDashScope(audioBase64, cfg);
    if (!result.ok) {
      return Response.json({ ok: false, error: result.error, engine: 'dashscope', ms: Date.now() - startedAt }, { headers: { 'cache-control': 'no-store' } });
    }
    return Response.json({ ok: true, text: result.text, engine: 'dashscope', ms: Date.now() - startedAt, emotion: result.emotion || '', language: result.language || '' }, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    return Response.json(
      { ok: false, error: 'asr-internal: ' + String((error && error.message) || error), text: '' },
      { status: 500, headers: { 'cache-control': 'no-store' } }
    );
  }
}

async function handleAsrConfigRoute(request) {
  if (request.method === 'GET') {
    return Response.json(asrStatus(), { headers: { 'cache-control': 'no-store' } });
  }
  if (request.method !== 'POST') {
    return Response.json({ ok: false, error: 'method-not-allowed' }, { status: 405, headers: { 'cache-control': 'no-store' } });
  }
  try {
    const payload = await request.json();
    if (payload === null || typeof payload !== 'object') return badRequest('body must be an object');
    const cfg = readAsrConfig();
    if (typeof payload.engine === 'string' && ['dsh', 'dashscope', 'off'].includes(payload.engine)) cfg.engine = payload.engine;
    if (typeof payload.region === 'string' && ['cn-beijing', 'ap-southeast-1', 'us-east-1'].includes(payload.region)) cfg.dashscope.region = payload.region;
    if (typeof payload.workspaceId === 'string') cfg.dashscope.workspaceId = payload.workspaceId.slice(0, 120);
    if (typeof payload.language === 'string' && payload.language !== '') cfg.dashscope.language = payload.language.slice(0, 16);
    if (typeof payload.enableItn === 'boolean') cfg.dashscope.enableItn = payload.enableItn;
    if (typeof payload.apiKey === 'string' && payload.apiKey !== '') cfg.dashscope.apiKey = payload.apiKey.slice(0, 200);
    if (payload.clearKey === true) cfg.dashscope.apiKey = '';
    saveAsrConfig(cfg);
    return Response.json(asrStatus(), { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    return Response.json(
      { ok: false, error: String((error && error.message) || error) },
      { status: 500, headers: { 'cache-control': 'no-store' } }
    );
  }
}

async function handleAsrTestRoute(request) {
  if (request.method !== 'POST') {
    return Response.json({ ok: false, error: 'method-not-allowed' }, { status: 405, headers: { 'cache-control': 'no-store' } });
  }
  try {
    const cfg = readAsrConfig();
    if (cfg.engine === 'off') return Response.json({ ok: false, error: 'engine-off' }, { headers: { 'cache-control': 'no-store' } });
    const silence = Buffer.alloc(16000 * 2).toString('base64');
    const startedAt = Date.now();
    const result = await callDashScope(silence, cfg);
    const base = { ms: Date.now() - startedAt, engine: 'dashscope' };
    return Response.json(
      result.ok ? { ok: true, text: result.text, emotion: result.emotion || '', language: result.language || '', ...base } : { ok: false, error: result.error, ...base },
      { headers: { 'cache-control': 'no-store' } }
    );
  } catch (error) {
    return Response.json(
      { ok: false, error: String((error && error.message) || error) },
      { status: 500, headers: { 'cache-control': 'no-store' } }
    );
  }
}

// 诊断日志落盘：客户端把内存事件批量 POST 到这里，按本地日期追加 JSONL。
// 4MB 封顶，超出后停止写事件并只追加一行 diag file full。
async function handleDiagLog(request) {
  if (request.method !== 'POST') {
    return Response.json({ ok: false, error: 'method-not-allowed' }, { status: 405, headers: { 'cache-control': 'no-store' } });
  }
  try {
    let payload;
    try {
      payload = await request.json();
    } catch (_error) {
      return badRequest('body must be JSON');
    }
    if (payload === null || typeof payload !== 'object' || !Array.isArray(payload.events)) {
      return badRequest('events must be an array');
    }
    const lines = [];
    for (const event of payload.events.slice(0, DIAG_MAX_EVENTS)) {
      if (event === null || typeof event !== 'object') continue;
      const t = Number(event.t);
      if (!Number.isFinite(t)) continue;
      const kind = String(event.kind === undefined ? '' : event.kind).slice(0, 120);
      const detail = String(event.detail === undefined ? '' : event.detail).slice(0, 2000);
      lines.push(JSON.stringify({ t, kind, detail }));
    }
    const dir = path.join(homedir(), '.dsh', 'voice-mode');
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'diag-' + localDay(new Date()) + '.jsonl');
    let size = 0;
    try {
      size = statSync(file).size;
    } catch (_error) {}
    let written = 0;
    if (lines.length > 0 && size < DIAG_MAX_BYTES) {
      const remaining = DIAG_MAX_BYTES - size;
      const accepted = [];
      let used = 0;
      for (const line of lines) {
        const bytes = Buffer.byteLength(line, 'utf8') + 1;
        if (used + bytes > remaining) break;
        accepted.push(line);
        used += bytes;
      }
      if (accepted.length > 0) {
        appendFileSync(file, accepted.join('\n') + '\n', 'utf8');
        written = accepted.length;
        size += used;
      }
    }
    if (size >= DIAG_MAX_BYTES && !diagMarkerWritten.has(file)) {
      diagMarkerWritten.add(file);
      appendFileSync(file, JSON.stringify({ t: Date.now(), kind: 'log', detail: 'diag file full' }) + '\n', 'utf8');
    }
    return Response.json({ ok: true, written }, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    return Response.json(
      { ok: false, error: String((error && error.message) || error) },
      { status: 500, headers: { 'cache-control': 'no-store' } }
    );
  }
}

const VOICE_MODE_PROMPT = [
  'The DSH window may run the voice-chat-mode plugin, which listens through the microphone and reads replies aloud. Facts you can rely on:',
  '- A user message whose text starts with `[语音] ` was spoken aloud and transcribed locally; treat it as an ordinary request.',
  '- Your reply may be spoken. You may include several `[voice-note]: <one to three spoken sentences>` blocks in a single reply, one at each stage; each block is spoken as it arrives, in order, and hidden from the rendered chat. Keep each block plain prose: no Markdown, code, URLs, lists, or emoji. Without any block the plugin may read the opening sentences of your reply.',
  '- Add `[voice-note]` blocks only when the user message was voice-dictated; never to typed messages.',
  '- Ordinary replies are already spoken by the plugin: do not call `voice_mode speak` to read a reply yourself.',
  '- Use `voice_mode enable`/`disable`/`status` only when the user asks to start or stop listening, or asks about its state; use `speak` only for a standalone announcement the user requests, for example while the microphone is closed.'
].join('\n');

function voiceStateText() {
  if (clientStatus === null) return 'Voice chat mode (plugin): no DSH window has reported state yet.';
  const state = String(clientStatus.state || 'OFF');
  const speaking = clientStatus.speaking === true ? 'yes' : 'no';
  let extra = '';
  const emotion = typeof clientStatus.voiceEmotion === 'string' ? clientStatus.voiceEmotion : '';
  const at = Number(clientStatus.voiceEmotionAt);
  if (emotion !== '' && Number.isFinite(at) && Date.now() - at <= 5 * 60 * 1000) {
    const date = new Date(at);
    const hh = String(date.getHours()).padStart(2, '0');
    const mm = String(date.getMinutes()).padStart(2, '0');
    extra = ' lastVoiceEmotion=' + emotion + ' lastVoiceAt=' + hh + ':' + mm;
  }
  return `Voice chat mode (plugin): state=${state}, speaking=${speaking}${extra}.`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForClient(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (clientStatus !== null && predicate(clientStatus)) return true;
    await sleep(100);
  }
  return clientStatus !== null && predicate(clientStatus);
}

const voiceModeTool = {
  name: 'voice_mode',
  description: [
    'Control the voice-chat plugin in the open DSH window.',
    'enable starts listening in the current session; disable stops listening and any playback; speak reads text aloud now; status reports the window state.',
    'Use it only when the user asks for hands-free or automated voice interaction.'
  ].join(' '),
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['enable', 'disable', 'speak', 'status'],
        description: 'enable = start listening; disable = stop; speak = read `text` aloud; status = current state.'
      },
      text: {
        type: 'string',
        description: 'Spoken text for speak: 1-500 characters, plain prose, no Markdown or URLs.'
      }
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
      return { status: clientStatus, pending: controlQueue.length, note: clientStatus === null ? 'no DSH window has reported yet' : 'latest window state' };
    }
    let text;
    if (action === 'speak') {
      text = args && typeof args.text === 'string' ? args.text.trim() : '';
      if (text === '') throw new Error('voice_mode: speak requires non-empty text');
      if (text.length > 500) throw new Error('voice_mode: speak text is longer than 500 characters');
    }
    const command = enqueueCommand(action, text);
    const applied = await waitForClient((status) => {
      if (action === 'enable') return status.state !== undefined && status.state !== 'OFF' && status.state !== 'ARMING';
      if (action === 'disable') return status.state === 'OFF';
      return status.speaking === true;
    }, 2500);
    return {
      action,
      applied,
      commandId: command.id,
      state: clientStatus === null ? null : clientStatus.state,
      speaking: clientStatus !== null && clientStatus.speaking === true
    };
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
    disposers.push(c.connection.fetch.register({
      path: DIAG_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: (request) => handleDiagLog(request)
    }));
    disposers.push(c.connection.fetch.register({
      path: ASR_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: (request) => handleAsrRoute(request)
    }));
    disposers.push(c.connection.fetch.register({
      path: VAD_PATH,
      methods: ['GET', 'POST'],
      requestBody: 'buffered',
      fetch: (request) => handleVadRoute(request)
    }));
    disposers.push(c.connection.fetch.register({
      path: ASR_CONFIG_PATH,
      methods: ['GET', 'POST'],
      requestBody: 'buffered',
      fetch: (request) => handleAsrConfigRoute(request)
    }));
    disposers.push(c.connection.fetch.register({
      path: ASR_TEST_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: (request) => handleAsrTestRoute(request)
    }));
  });
  ctx.inject(['tools'], (c) => {
    c.effect(() => c.tools.register(voiceModeTool));
  });
  ctx.inject(['systemPrompt'], (c) => {
    c.effect(() => c.systemPrompt.section({ name: 'plugin:voice-chat-mode', order: 3200, text: VOICE_MODE_PROMPT }));
    c.effect(() => c.systemPrompt.context({ name: 'plugin:voice-chat-mode', order: 215, text: () => voiceStateText() }));
  });
}
