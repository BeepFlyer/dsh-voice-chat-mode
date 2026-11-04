// 驱动 voice-mode Host 半身：工具注册、提示词节/状态上下文、控制队列与状态回报。
import { apply } from '../index.js';

let tool = null;
const routes = new Map();
const sections = [];
const contexts = [];

const ctx = {
  inject(names, callback) {
    const context = {
      effect(fn) {
        fn();
      },
      connection: {
        fetch: {
          register(route) {
            routes.set(route.path, route);
            return () => Promise.resolve();
          }
        }
      },
      tools: {
        register(definition) {
          tool = definition;
          return () => {};
        }
      },
      systemPrompt: {
        section(definition) {
          sections.push(definition);
          return () => {};
        },
        context(definition) {
          contexts.push(definition);
          return () => {};
        }
      }
    };
    callback(context);
  }
};

apply(ctx);
if (tool === null) throw new Error('tool not registered');
console.log('tool:', tool.name);
console.log('parameters:', JSON.stringify(tool.parameters.properties));
console.log('prompt section:', sections.map((s) => s.name + '@' + s.order).join(', '));
console.log('prompt context:', contexts.map((c) => c.name + '@' + c.order).join(', '));
console.log('routes:', Array.from(routes.keys()).join(', '));
console.log('section text lines:', sections[0].text.split('\n').length);

const control = routes.get('/api/voice-mode.control');
let clientState = 'OFF';
let clientSpeaking = false;

// 模拟浏览器：每 100ms 拉命令并回报状态。
async function report() {
  const response = await fetchLike(control, 'POST', {
    state: clientState,
    speaking: clientSpeaking,
    sessionId: 'session-test',
    at: Date.now()
  });
  void response;
}
const clientLoop = setInterval(async () => {
  const pulled = await fetchLike(control, 'GET');
  const body = await pulled.json();
  for (const command of body.commands || []) {
    if (command.action === 'enable') clientState = 'LISTENING';
    if (command.action === 'disable') {
      clientState = 'OFF';
      clientSpeaking = false;
    }
    if (command.action === 'speak') clientSpeaking = true;
  }
  await report();
}, 100);

function fetchLike(route, method, payload) {
  return route.fetch(
    new Request('http://127.0.0.1/api/voice-mode.control', {
      method,
      headers: payload === undefined ? undefined : { 'content-type': 'application/json' },
      body: payload === undefined ? undefined : JSON.stringify(payload)
    })
  );
}

await new Promise((resolve) => setTimeout(resolve, 300));
console.log('status(initial):', JSON.stringify(await tool.execute({ action: 'status' }, {})));

const started = Date.now();
const enable = await tool.execute({ action: 'enable' }, {});
console.log('enable:', JSON.stringify(enable), 'ms', Date.now() - started);

const speak = await tool.execute({ action: 'speak', text: '你好，我是自动化测试。' }, {});
console.log('speak:', JSON.stringify(speak));

const disable = await tool.execute({ action: 'disable' }, {});
console.log('disable:', JSON.stringify(disable));

console.log('context text:', contexts[0].text());

console.log('invalid action:');
try {
  await tool.execute({ action: 'nope' }, {});
} catch (error) {
  console.log('  throws:', error.message);
}

console.log('render sample:', JSON.stringify(tool.output.render({}, { action: 'enable', applied: true })));

// 队列上限：先停掉模拟客户端，再一口气塞 12 条。
clearInterval(clientLoop);
const pending = [];
for (let index = 0; index < 12; index += 1) pending.push(tool.execute({ action: 'disable' }, {}));
await new Promise((resolve) => setTimeout(resolve, 50));
const pull = await fetchLike(control, 'GET');
const pulled = await pull.json();
console.log('queued after 12 disables (limit 10):', pulled.commands.length);
await Promise.all(pending);
console.log('done');
