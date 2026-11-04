// 驱动 voice-mode Host 半身：工具注册 + 控制队列 + 状态回报。
import { apply } from '../index.js';

let tool = null;
const routes = new Map();

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
      }
    };
    callback(context);
  }
};

apply(ctx);
if (tool === null) throw new Error('tool not registered');
console.log('tool:', tool.name, 'params:', JSON.stringify(tool.parameters.properties), 'required:', JSON.stringify(tool.parameters.required));
console.log('routes:', Array.from(routes.keys()).join(', '));

const control = routes.get('/api/voice-mode.control');
const started = Date.now();
const status = await tool.execute({ action: 'status' }, {});
console.log('status(empty):', JSON.stringify(status), 'ms', Date.now() - started);

const speak = await tool.execute({ action: 'speak', text: '你好，我是自动化测试。' }, {});
console.log('speak:', JSON.stringify(speak));

const enable = await tool.execute({ action: 'enable' }, {});
console.log('enable:', JSON.stringify(enable));

const pull = await control.fetch(new Request('http://127.0.0.1/api/voice-mode.control', { method: 'GET' }));
const pulled = await pull.json();
console.log('client pull:', JSON.stringify(pulled));

await control.fetch(
  new Request('http://127.0.0.1/api/voice-mode.control', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ state: 'LISTENING', speaking: false, sessionId: 'session-test', at: Date.now() })
  })
);
const status2 = await tool.execute({ action: 'status' }, {});
console.log('status(reported):', JSON.stringify(status2));

console.log('invalid action:');
try {
  await tool.execute({ action: 'nope' }, {});
} catch (error) {
  console.log('  throws:', error.message);
}
console.log('render sample:', JSON.stringify(tool.output.render({}, { queued: true, action: 'enable' })));
console.log('queue limit check:');
for (let i = 0; i < 12; i += 1) await tool.execute({ action: 'disable' }, {});
const pull2 = await (await control.fetch(new Request('http://127.0.0.1/api/voice-mode.control'))).json();
console.log('  queued after 12 disables:', pull2.commands.length);
