# 验收记录：Edge TTS 播报引擎（v0.2.0）

> 规格：`F:\deepSeekHome\voice-mode-edge-tts-spec.md` §9
> 执行：2026-11-04 02:3x（创造模式会话，Windows 10 19045 + DSH Desktop）
> 方式：Host 路由用假 `ctx` 直接驱动 `apply()` 注册的处理函数（真 spawn Python）；客户端播放器用假 `Audio`/`fetch` 驱动 `EdgePlayer` 源码；UI 闭环需运行中的桌面窗口，标注为「待 UI」。

| # | 条目 | 结果 | 证据 |
|---|---|---|---|
| 1 | 闭环：说话→转写→提交→**Edge 音色**念出 | **待 UI 确认** | Host 合成与客户端播放器分别实测通过；完整链路需在桌面窗口点一次「播放测试」/说一句。v0.1.0 的系统语音闭环已实测过，本次只替换播报引擎。 |
| 2 | 延迟：30 字内，`turn/end`→出声，子进程版 ≤3.0s | **通过** | 8 音色 30 字左右：**1946–2288ms**（含 Python 启动）；Python 直调 2012ms。缓存命中 **0ms**。长文本 480 字 → 2614ms。 |
| 3 | 停止：播报中点停止 → 立即无声 | **通过（播放器级）** | `EdgePlayer.cancel()`：audio 被 `pause()`+`src=''`、队列清空、`onChange(false)`；测试输出 `speaking=false, paused=true, queue=0`。UI 按钮/Esc 走同一 `stopPlayback()`。 |
| 4 | 回退：断网后仍出声（系统语音） | **通过（失败路径）** | 路由 503/异常时 `EdgePlayer` 捕获并调用 `onFallback(剩余文本)`，由系统语音接续；测试输出 `fallback payload=["回退测试一。回退测试二。"]`，日志含 `falling back to system voice`。断网实测需拔网，属 UI 待测。 |
| 5 | 多段：连播 3 段 `[voice-note]`，顺序正确、段间不卡 | **通过（播放器级）** | 假 Audio 驱动：3 段依次播放，`onChange` 只 `[true,false]` 一次，无重叠；预取可关。 |
| 6 | 不回归：播报期麦克风不触发；切会话/刷新复位 | **代码路径保留** | `speaking` 从「开始取音频」即置位（含缓冲期），`onAudioFrame` 在 speaking 时只更新电平、不触发；硬关闭顺序未改动。需一次实听确认。 |
| 7 | 音色切换：8 个中文音色都能选/试听/播 | **合成通过，UI 待确认** | 路由对 8 个音色全部返回 200 `audio/mpeg`（26.9–34.6KB）；设置页下拉列出 8 项，播放测试按钮走同一引擎。 |

## 关键数字

- 单句合成（子进程版，含 Python 启动）：**约 1.95–2.29s**
- 缓存命中：**0ms**
- 长文本 480 字：**2.61s**
- 校验：空文本/超长文本/非白名单音色 → 400；rate 越界被 clamp 到 ±50
- 路由：`POST /api/voice-mode.tts`（GET 返回引擎/音色数/缓存状态，便于排查）

## 待 UI 实跑（需桌面窗口，无法自动化）

1. 设置 → 语音回复 → 播放测试：应听到晓伊音色（约 2s 后出声）；
2. 语音模式开 → 说一句 → 回复用 Edge 念出；
3. 播报中点顶栏或 `Esc` → 立即无声；
4. 断网后再点播放测试 → 应回退系统语音，诊断出现 `edge tts failed` + `falling back`。

## 维护提示

- 先跑 `python -m edge_tts --list-voices` 确认接口还在；失败时 Host 返回 503 并在诊断提示。
- 音色白名单在 `index.js` 的 `VOICES`，客户端下拉在 `client-body.js` 的 `EDGE_VOICES`，两处需同步。
- 配置键 `voice-mode:config:v4`；旧 v3 值不会迁移（引擎/语速语义已变）。

## 增量：v0.3.0 模型控制通道

- Host 注册工具 `voice_mode`（action：enable / disable / speak / status）+ `GET/POST /api/voice-mode.control` 命令队列与状态回报；客户端每 1.5s 轮询执行。
- 实测（运行中的桌面窗口）：
  - `status` → `{"state":"OFF","speaking":false,"sessionId":"session-230fac13…"}`（客户端回报抵达 Host）；
  - `speak "自动化测试：这是模型直接发起的语音播报。"` → 入队 → 约 1.5s 后客户端取走 → `status` 变为 `speaking:true`。
- 工具在 bundle 重载后出现在模型工具表（`Tool.listTools` 可查）；`enable` 需窗口内有打开的会话，本次未主动开麦测试（避免未经同意开麦）。

## 增量：v0.3.1 独立朗读静音键

- 顶栏新增 occupant `voice-mode-tts`（order -1，位于麦克风开关旁），只切换 `ttsEnabled`：立即停/恢复“助手回复自动朗读”，存 `localStorage`，工具 `speak` 不受影响。
- 实测：Slots 里 `voice-mode-toggle`（-2）与 `voice-mode-tts`（-1）同时 active；设置页改动会 `engine.publish()` 同步按钮状态。

## 增量：v0.2.1 失焦/隐藏时继续播报

- 新增设置 `失焦/隐藏时继续播报`（默认开）：窗口失焦或被完全遮挡时，按原硬关闭策略**立即停麦、放锁**，但**不再掐断当前播报**，让队列自然念完；`Esc`、关开关、切会话仍立即停。
- 实现：`requestDeferredShutdown(kind)` → `shutdown(kind, {keepPlayback:true})`；重新开麦前会先停掉残余音频。
- 判定逻辑单测：`shutdown` 的 keepPlayback 分支保留 speaker 调用，`onSpeakingChange(false)` 正常收尾（语音队列测试 A/B/C 仍通过）。


## 增量：v0.3.2 设置页卡片化（方案 A）

- 设置页重排为状态头 + 四张卡片：输入与触发 / 退出与后台 / 语音回复 / 其他；高级参数收进 <details>。
- 全部颜色改用主题 token（bg-layer、border、label、state-*），数值控件统一 112px，说明文字降为 secondary 小字。
- 顶部状态胶囊显示 状态 · 引擎 · 音色；底部保留试听/恢复默认与诊断折叠。

## 增量：v0.4.0 设置页卡片底色 + 方案 B 预览栏

- 四张卡片各用主题色的 5% 淡底 + 3px 左侧色条（color-mix 叠 g-layer-1）：输入=brand、退出=warn、语音回复=success、其他=idle。
- 右侧 300px 粘性预览：引擎分段按钮、音色下拉、语速/音高/音量滑杆、试听文本、试听/停止、状态点；窄窗自动换行到下方。
- 	estTts(text) 支持自定义试听文本。
