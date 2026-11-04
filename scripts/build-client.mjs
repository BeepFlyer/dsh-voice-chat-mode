// 重新生成 voice-mode/client.js：
//   1) 从安装内的 app.asar 取出内置语音客户端的 cypert 协议垫片（createTypertRemoteInfo 等）
//   2) 取出 @deepseek-ai/dsh-experimental-api-speech-to-text 的生成 Remote 定义并内联
//   3) 拼上本包的客户端逻辑（client-body.js）
//
// 用法：node scripts/build-client.mjs
// 可选环境变量：DSH_ASAR（app.asar 路径）、DSH_ASAR_HEADER（默认取 u32@12 作为 JSON 头长度）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgDir = path.resolve(here, '..');
const asarPath = process.env.DSH_ASAR || 'G:/Software/DeepSeek Harness/resources/app.asar';

const fd = fs.openSync(asarPath, 'r');
const meta = Buffer.alloc(16);
fs.readSync(fd, meta, 0, 16, 0);
const headerSize = meta.readUInt32LE(12);
const headerBuf = Buffer.alloc(headerSize);
fs.readSync(fd, headerBuf, 0, headerSize, 16);
const asarHeader = JSON.parse(headerBuf.toString('utf8'));
const baseOffset = 16 + headerSize;

function readMember(member) {
  let node = asarHeader;
  for (const part of member.split('/').filter(Boolean)) {
    node = node && node.files ? node.files[part] : undefined;
  }
  if (!node || node.files) throw new Error(`asar member not found: ${member}`);
  const bytes = Buffer.alloc(node.size);
  fs.readSync(fd, bytes, 0, node.size, baseOffset + Number(node.offset));
  return bytes.toString('utf8');
}

const builtinClient = readMember('dsh/node_modules/@deepseek-ai/dsh-experimental-client-ui-voice-input/lib/client.js');
const builtinLines = builtinClient.split('\n');
const helperStart = builtinLines.findIndex((line) => line.includes('function createTypertRemoteInfo(spec, zod) {'));
const helperEnd = builtinLines.findIndex((line, index) => index > helperStart && line.includes('//#region ../api-speech-to-text'));
if (helperStart < 0 || helperEnd < 0) throw new Error('helper block not found in builtin client bundle');
const helper = builtinLines.slice(helperStart, helperEnd).join('\n');

const remoteClient = readMember('dsh/node_modules/@deepseek-ai/dsh-experimental-api-speech-to-text/lib/typert.remote-client.js');
const remoteLines = remoteClient.split('\n');
const specStart = remoteLines.findIndex((line) => line.startsWith('let _deepseek_ai_dsh_experimental_api_speech_to_text_'));
if (specStart < 0) throw new Error('remote spec block not found');
const spec = remoteLines
  .slice(specStart)
  .join('\n')
  .replace(/^export const TYPERT_REMOTE = /m, 'const TYPERT_REMOTE = ')
  .replace(/\nexport default TYPERT_REMOTE\s*$/, '\n');

fs.closeSync(fd);

const body = fs.readFileSync(path.join(pkgDir, 'client-body.js'), 'utf8');

const header = `// ─────────────────────────────────────────────────────────────
// 语音聊天模式 · 客户端模块（覆盖 ui-voice-input 行的实现）
//
// 维护注释（覆盖内置行的理由与升级对照项，见 cordis.patch.yml 同款）：
//   内置 @deepseek-ai/dsh-experimental-client-ui-voice-input 的 client 半身是私有闭包——
//   录音实例 / MediaRecorder / AudioContext 都在 registerUi 内部，只用 inject 交给
//   自己注册的 slot 占用者；没有 provide、没有对外事件。外部无法驱动它，并列挂载会
//   抢同一支麦克风并产生两套采集指示。故只能整行替换。依据：app.asar 行 968240–968330。
//
//   上游升级时对照：slot 名（conversation.input.activity / .left）、
//   speech Remote 方法名（catalog/follow/prepare/transcribe）、
//   transcribe 入参（base64 的 16kHz mono PCM16 WAV）、hidden/blur 策略（行 967241）。
//
//   注意：下方 TYPERT_REMOTE 段落由 @deepseek-ai/dsh-experimental-api-speech-to-text
//   的生成物（lib/typert.remote-client.js）原样内联；上游改 Remote 定义时，
//   运行 scripts/build-client.mjs 重新生成本文件。
// ─────────────────────────────────────────────────────────────
window.__ModuleLoader__.load({
  id: '@local/dsh-voice-mode',
  factory(require) {
    'use strict';
    const React = require('react');
    const zod = require('zod');
    const z = zod.z;
`;

const footer = `  },
});
`;

fs.writeFileSync(path.join(pkgDir, 'client.js'), `${header}${helper}\n${spec}\n${body}${footer}`, 'utf8');
console.log('wrote client.js');
