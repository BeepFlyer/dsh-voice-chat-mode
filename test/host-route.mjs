// 直接驱动 voice-mode/index.js 注册的 /api/voice-mode.tts 处理函数。
// 用法：node .work/test-host-route.mjs [mode]
//   mode=basic 默认；mode=missing-python 用坏路径验证 503；mode=timeout 用极短超时验证 504。
import { apply } from '../index.js';

const mode = process.argv[2] || 'basic';
if (mode === 'missing-python') process.env.VOICE_MODE_PYTHON = 'C:/definitely/missing/python.exe';

let captured = null;
const ctx = {
  inject(names, callback) {
    callback({
      effect(fn) {
        fn();
      },
      connection: {
        fetch: {
          register(route) {
            captured = route;
            return () => Promise.resolve();
          }
        }
      }
    });
  }
};

apply(ctx);
if (captured === null) throw new Error('route was not registered');
console.log('route:', captured.path, captured.methods.join(','), 'body:', captured.requestBody);

function request(payload, timeoutMs) {
  const body = JSON.stringify(payload);
  const request = new Request('http://127.0.0.1/api/voice-mode.tts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body
  });
  const started = performance.now();
  return captured.fetch(request).then(async (response) => {
    const elapsed = Math.round(performance.now() - started);
    const buffer = Buffer.from(await response.arrayBuffer());
    return {
      status: response.status,
      elapsed,
      type: response.headers.get('content-type') || '',
      engine: response.headers.get('x-voice-mode-engine') || '',
      bytes: buffer.length,
      body: response.status === 200 ? null : buffer.toString('utf8')
    };
  });
}

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

const text = '主人，本鲸鱼娘第一次用这个声音说话，测试一二三。';

if (mode === 'basic') {
  console.log('\n-- 8 voices --');
  for (const voice of VOICES) {
    const result = await request({ text, voice, rate: 10, volume: 0, pitch: 0 });
    console.log(voice, JSON.stringify(result));
  }
  console.log('\n-- cache hit --');
  const a = await request({ text, voice: VOICES[1], rate: 10, volume: 0, pitch: 0 });
  const b = await request({ text, voice: VOICES[1], rate: 10, volume: 0, pitch: 0 });
  console.log('first', JSON.stringify(a), 'second', JSON.stringify(b));

  console.log('\n-- validation --');
  for (const payload of [
    { text: '', voice: VOICES[1] },
    { text: 'x'.repeat(501), voice: VOICES[1] },
    { text: 'ok', voice: 'en-US-AriaNeural' },
    { text: 'ok', voice: VOICES[1], rate: 999 }
  ]) {
    console.log(JSON.stringify(payload).slice(0, 80), JSON.stringify(await request(payload)));
  }

  console.log('\n-- long text --');
  const longText = '这是用来测试长文本合成耗时的句子，'.repeat(8).slice(0, 480);
  console.log(JSON.stringify(await request({ text: longText, voice: VOICES[0], rate: 10 })));
} else if (mode === 'timeout') {
  console.log(JSON.stringify(await request({ text, voice: VOICES[1], timeoutMs: 1000 })));
} else if (mode === 'missing-python') {
  console.log(JSON.stringify(await request({ text, voice: VOICES[1] })));
}
