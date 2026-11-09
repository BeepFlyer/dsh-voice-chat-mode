    // ── 语音聊天模式：状态机引擎（依据 voice-mode-state-machine.md） ──
    // 状态：OFF → ARMING → LISTENING ⇄ CAPTURING → TRANSCRIBING → SUBMITTING → LISTENING
    //       ARMING → BLOCKED（权限/未准备/无 AudioContext/被另一窗口占用）
    // 采集：ScriptProcessorNode 直接取 PCM（不经过 MediaRecorder 容器，避免 decodeAudioData 的兼容坑），
    //       环形缓冲保留 pre-roll；收尾后重采样到 16k mono PCM16 WAV。
    var NS = 'voice-mode';

    // 语音提交的可见标记：前缀进入用户消息正文（模型也会看到）。设置页可改。
    var DEFAULT_MARKER = '[语音] ';
    var voiceMarker = DEFAULT_MARKER;

    var STORAGE_KEY = 'voice-mode:config:v4';

    var EDGE_VOICES = [
      'zh-CN-XiaoxiaoNeural',
      'zh-CN-XiaoyiNeural',
      'zh-CN-YunjianNeural',
      'zh-CN-YunxiNeural',
      'zh-CN-YunxiaNeural',
      'zh-CN-YunyangNeural',
      'zh-CN-liaoning-XiaobeiNeural',
      'zh-CN-shaanxi-XiaoniNeural'
    ];

    // 用户可调参数（设置页顺序即此顺序）。idleExitMs / blurExitMs 以分钟展示，内部仍存毫秒。
    var CONFIG_DEFAULTS = {
      energyThreshold: 0.01,
      minSpeechMs: 300,
      preRollMs: 300,
      silenceMs: 1500,
      cooldownMs: 500,
      maxSeconds: 60,
      minChars: 2,
      maxFailures: 3,
      idleExitMs: 10 * 60 * 1000,
      blurExitMs: 0,
      listenWhileHidden: false,
      longPressMs: 500,
      ttsEnabled: true,
      ttsEngine: 'edge',
      ttsEdgeVoice: 'zh-CN-XiaoyiNeural',
      ttsEdgeRate: 10,
      ttsEdgeVolume: 0,
      ttsEdgePitch: 0,
      ttsEdgePrefetch: true,
      ttsFallbackToSystem: true,
      ttsEdgeTimeoutMs: 20000,
      ttsKeepPlayingOnUnfocused: true,
      // 未开麦时也播报：开着这个，即使模式是 OFF/待机，AI 给出的口播稿照样念出来。
      ttsSpeakWhenIdle: true,
      ttsScope: 'head3',
      ttsMaxChars: 220,
      ttsSkipOpener: true,
      ttsSentenceChars: 120,
      ttsRate: 3,
      ttsPauseMs: 150,
      ttsPitch: 1,
      ttsVolume: 1,
      ttsVoice: '',
      ttsSuppressDuringSpeech: true,
      ttsBargeIn: true
    };

    var TTS_SCOPES = ['head3', 'tail', 'full', 'short', 'off'];

    var FIELDS = [
      { key: 'energyThreshold', min: 0.001, max: 0.5, step: 0.005, digits: 3 },
      { key: 'minSpeechMs', min: 100, max: 2000, step: 50, unit: 'ms' },
      { key: 'preRollMs', min: 0, max: 1000, step: 50, unit: 'ms' },
      { key: 'silenceMs', min: 300, max: 3000, step: 100, unit: 'ms' },
      { key: 'cooldownMs', min: 0, max: 3000, step: 100, unit: 'ms' },
      { key: 'maxSeconds', min: 5, max: 600, step: 5, unit: 's' },
      { key: 'minChars', min: 1, max: 20, step: 1 },
      { key: 'maxFailures', min: 1, max: 10, step: 1 },
      { key: 'idleExitMs', min: 0, max: 60, step: 1, minutes: true },
      { key: 'blurExitMs', min: 0, max: 60, step: 1, minutes: true },
      { key: 'listenWhileHidden', boolean: true },
      { key: 'longPressMs', min: 200, max: 2000, step: 50, unit: 'ms' },
      { key: 'ttsEnabled', boolean: true, section: 'tts' },
      { key: 'ttsEngine', options: ['edge', 'system'], section: 'tts' },
      { key: 'ttsEdgeVoice', options: EDGE_VOICES },
      { key: 'ttsEdgeRate', min: -50, max: 50, step: 5, unit: '%' },
      { key: 'ttsEdgeVolume', min: -50, max: 50, step: 5, unit: '%' },
      { key: 'ttsEdgePitch', min: -50, max: 50, step: 5, unit: 'Hz' },
      { key: 'ttsEdgePrefetch', boolean: true },
      { key: 'ttsFallbackToSystem', boolean: true },
      { key: 'ttsEdgeTimeoutMs', min: 3000, max: 30000, step: 500, unit: 'ms' },
      { key: 'ttsKeepPlayingOnUnfocused', boolean: true },
      { key: 'ttsSpeakWhenIdle', boolean: true },
      { key: 'ttsScope', options: TTS_SCOPES },
      { key: 'ttsMaxChars', min: 80, max: 2000, step: 20, unit: '字' },
      { key: 'ttsSkipOpener', boolean: true },
      { key: 'ttsSentenceChars', min: 40, max: 400, step: 10, unit: '字' },
      { key: 'ttsRate', min: 0.5, max: 5, step: 0.1, digits: 1 },
      { key: 'ttsPauseMs', min: 0, max: 1000, step: 50, unit: 'ms' },
      { key: 'ttsPitch', min: 0, max: 2, step: 0.1, digits: 1 },
      { key: 'ttsVolume', min: 0, max: 1, step: 0.05, digits: 2 },
      { key: 'ttsVoice', voice: true },
      { key: 'ttsSuppressDuringSpeech', boolean: true },
      { key: 'ttsBargeIn', boolean: true }
    ];

    var CONFIG = {
      energyThreshold: CONFIG_DEFAULTS.energyThreshold,
      minSpeechMs: CONFIG_DEFAULTS.minSpeechMs,
      preRollMs: CONFIG_DEFAULTS.preRollMs,
      silenceMs: CONFIG_DEFAULTS.silenceMs,
      cooldownMs: CONFIG_DEFAULTS.cooldownMs,
      maxSeconds: CONFIG_DEFAULTS.maxSeconds,
      minChars: CONFIG_DEFAULTS.minChars,
      maxFailures: CONFIG_DEFAULTS.maxFailures,
      idleExitMs: CONFIG_DEFAULTS.idleExitMs,
      blurExitMs: CONFIG_DEFAULTS.blurExitMs,
      listenWhileHidden: CONFIG_DEFAULTS.listenWhileHidden,
      longPressMs: CONFIG_DEFAULTS.longPressMs,
      ttsEnabled: CONFIG_DEFAULTS.ttsEnabled,
      ttsEngine: CONFIG_DEFAULTS.ttsEngine,
      ttsEdgeVoice: CONFIG_DEFAULTS.ttsEdgeVoice,
      ttsEdgeRate: CONFIG_DEFAULTS.ttsEdgeRate,
      ttsEdgeVolume: CONFIG_DEFAULTS.ttsEdgeVolume,
      ttsEdgePitch: CONFIG_DEFAULTS.ttsEdgePitch,
      ttsEdgePrefetch: CONFIG_DEFAULTS.ttsEdgePrefetch,
      ttsFallbackToSystem: CONFIG_DEFAULTS.ttsFallbackToSystem,
      ttsEdgeTimeoutMs: CONFIG_DEFAULTS.ttsEdgeTimeoutMs,
      ttsKeepPlayingOnUnfocused: CONFIG_DEFAULTS.ttsKeepPlayingOnUnfocused,
      ttsSpeakWhenIdle: CONFIG_DEFAULTS.ttsSpeakWhenIdle,
      ttsScope: CONFIG_DEFAULTS.ttsScope,
      ttsMaxChars: CONFIG_DEFAULTS.ttsMaxChars,
      ttsSkipOpener: CONFIG_DEFAULTS.ttsSkipOpener,
      ttsSentenceChars: CONFIG_DEFAULTS.ttsSentenceChars,
      ttsRate: CONFIG_DEFAULTS.ttsRate,
      ttsPauseMs: CONFIG_DEFAULTS.ttsPauseMs,
      ttsPitch: CONFIG_DEFAULTS.ttsPitch,
      ttsVolume: CONFIG_DEFAULTS.ttsVolume,
      ttsVoice: CONFIG_DEFAULTS.ttsVoice,
      ttsSuppressDuringSpeech: CONFIG_DEFAULTS.ttsSuppressDuringSpeech,
      ttsBargeIn: CONFIG_DEFAULTS.ttsBargeIn,
      armTimeoutMs: 30000,
      frameSize: 2048
    };

    function normalizeStored(field, value) {
      if (field.boolean) return value === true;
      if (field.options) return field.options.indexOf(value) >= 0 ? value : CONFIG_DEFAULTS[field.key];
      if (field.voice) return typeof value === 'string' ? value.slice(0, 120) : '';
      var numeric = Number(value);
      if (!isFinite(numeric)) return CONFIG_DEFAULTS[field.key];
      if (field.minutes) {
        var minutes = numeric / 60000;
        var bounded = Math.min(field.max, Math.max(field.min, minutes));
        return Math.round(bounded) * 60000;
      }
      return Math.min(field.max, Math.max(field.min, numeric));
    }

    function defaultsVoiceConfig() {
      var next = {};
      for (var index = 0; index < FIELDS.length; index += 1) {
        next[FIELDS[index].key] = CONFIG_DEFAULTS[FIELDS[index].key];
      }
      next.marker = DEFAULT_MARKER;
      return next;
    }

    function readVoiceConfig() {
      var next = defaultsVoiceConfig();
      try {
        var raw = window.localStorage.getItem(STORAGE_KEY);
        if (raw) {
          var parsed = JSON.parse(raw);
          for (var cursor = 0; cursor < FIELDS.length; cursor += 1) {
            var item = FIELDS[cursor];
            if (item.boolean) {
              if (typeof parsed[item.key] === 'boolean') next[item.key] = parsed[item.key];
            } else if (item.options) {
              if (typeof parsed[item.key] === 'string' && item.options.indexOf(parsed[item.key]) >= 0) next[item.key] = parsed[item.key];
            } else if (item.voice) {
              if (typeof parsed[item.key] === 'string') next[item.key] = parsed[item.key].slice(0, 120);
            } else if (typeof parsed[item.key] === 'number') {
              next[item.key] = normalizeStored(item, parsed[item.key]);
            }
          }
          if (typeof parsed.marker === 'string' && parsed.marker.length <= 12) next.marker = parsed.marker;
        }
      } catch (_error) {}
      return next;
    }

    function applyVoiceConfig(next) {
      for (var index = 0; index < FIELDS.length; index += 1) {
        var field = FIELDS[index];
        if (field.boolean) {
          CONFIG[field.key] = next[field.key] === true;
        } else if (field.options) {
          CONFIG[field.key] = field.options.indexOf(next[field.key]) >= 0 ? next[field.key] : CONFIG_DEFAULTS[field.key];
        } else if (field.voice) {
          CONFIG[field.key] = typeof next[field.key] === 'string' ? next[field.key].slice(0, 120) : '';
        } else if (typeof next[field.key] === 'number') {
          CONFIG[field.key] = next[field.key];
        }
      }
      voiceMarker = typeof next.marker === 'string' ? next.marker : DEFAULT_MARKER;
    }

    function saveVoiceConfig(next) {
      applyVoiceConfig(next);
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch (_error) {}
    }

    applyVoiceConfig(readVoiceConfig());

    var STATE = {
      OFF: 'OFF',
      ARMING: 'ARMING',
      LISTENING: 'LISTENING',
      CAPTURING: 'CAPTURING',
      TRANSCRIBING: 'TRANSCRIBING',
      SUBMITTING: 'SUBMITTING',
      BLOCKED: 'BLOCKED'
    };

    var ZH = {
      'toggle.off': '开启语音聊天模式',
      'toggle.arming': '正在准备语音',
      'toggle.listening': '语音模式：在听',
      'toggle.capturing': '语音模式：录音中',
      'toggle.transcribing': '语音模式：识别中',
      'toggle.submitting': '语音模式：发送中',
      'toggle.blocked': '语音模式不可用',
      'toggle.steerArmed': '长按已生效：下一次说话将插话',
      'chip.OFF': '语音',
      'chip.ARMING': '准备中',
      'chip.LISTENING': '在听',
      'chip.CAPTURING': '录音中',
      'chip.TRANSCRIBING': '识别中',
      'chip.SUBMITTING': '发送中',
      'chip.BLOCKED': '语音',
      'chip.SPEAKING': '播报中',
      'toggle.speaking': '正在播报（点击停止）',
      'toggle.statusHint': '语音状态；在输入框旁开关麦克风',
      'sessionDot.active': '这个会话正在使用语音模式',
      'sessionDot.enabled': '这个会话已开启语音模式（切回时自动恢复）',
      'ttsToggle.on': '语音回复：开（点击静音）',
      'ttsToggle.off': '语音回复：关（点击打开）',
      'ttsToggle.shortOn': '朗读',
      'ttsToggle.shortOff': '静音',
      'section.tts': '语音回复',
      'section.input': '输入与触发',
      'section.input.hint': '麦克风什么时候开始、什么时候收尾。',
      'section.exit': '退出与后台',
      'section.exit.hint': '隐私相关：失焦或后台时是否继续听。',
      'section.tts.hint': '用哪种引擎、什么音色、念多少。',
      'section.advanced': '高级参数',
      'section.misc': '其他',
      'section.misc.hint': '语音提交的可见标记。',
      'f.ttsEnabled': '启用语音回复',
      'f.ttsEnabled.hint': '助手回复到达时念出来；只在语音模式开启时播。',
      'f.ttsScope': '播报范围',
      'f.ttsMaxChars': '播报字数上限',
      'f.ttsMaxChars.hint': '超过就截断，避免一次念太久。',
      'f.ttsSkipOpener': '跳过开场白',
      'f.ttsSkipOpener.hint': '「好的/稍等」这类短句不念。',
      'f.ttsSentenceChars': '单句上限',
      'f.ttsSentenceChars.hint': '超长句会按逗号再切。',
      'f.ttsRate': '语速',
      'f.ttsPauseMs': '句间停顿',
      'f.ttsPauseMs.hint': '相邻两段之间的停顿，Edge 与系统引擎都生效；0 为不停。',
      'f.ttsPitch': '音调',
      'f.ttsPitch.hint': '0 低沉、2 尖细，1 为默认。',
      'f.ttsVolume': '音量',
      'f.ttsVolume.hint': '0–1，默认 1。',
      'f.ttsEngine': '播报引擎',
      'f.ttsEngine.hint': 'Edge 音色更自然（需联网）；系统语音可离线。',
      'f.ttsEdgeVoice': 'Edge 音色',
      'f.ttsEdgeRate': 'Edge 语速',
      'f.ttsEdgeRate.hint': '百分比，-50% 到 +50%。',
      'f.ttsEdgeVolume': 'Edge 音量',
      'f.ttsEdgeVolume.hint': '百分比，-50% 到 +50%。',
      'f.ttsEdgePitch': 'Edge 音高',
      'f.ttsEdgePitch.hint': 'Hz，-50 到 +50。',
      'f.ttsEdgePrefetch': '预取下一句',
      'f.ttsEdgePrefetch.hint': '当前句播放时提前合成下一句，减少空白。',
      'f.ttsFallbackToSystem': '失败回退系统语音',
      'f.ttsFallbackToSystem.hint': '断网/超时/接口异常时自动改用本机语音。',
      'f.ttsEdgeTimeoutMs': '单句超时',
      'f.ttsEdgeTimeoutMs.hint': '超过就先重试一次，仍失败才回退；默认 20 秒，网络差可再调大。',
      'f.ttsKeepPlayingOnUnfocused': '失焦/隐藏时继续播报（只影响声音）',
      'f.ttsKeepPlayingOnUnfocused.hint': '只管播报：窗口失焦/被遮挡时让当前播报自然结束，不决定是否继续听（那是上面那一项）。',
      'f.ttsSpeakWhenIdle': '未开麦时也播报',
      'f.ttsSpeakWhenIdle.hint': '开着它：模式是关闭/待机时，AI 给出的口播稿依然会念出来。关掉它：只有模式运行中才念，其余时候的口播稿先攒着，等开麦再补。',
      'f.ttsVoice': '音色',
      'f.ttsVoice.hint': '仅系统引擎使用。',
      'option.edge': 'Edge 神经语音（在线）',
      'option.system': '系统语音（本机）',
      'option.zh-CN-XiaoxiaoNeural': '晓晓（女·温暖）',
      'option.zh-CN-XiaoyiNeural': '晓伊（女·活泼）',
      'option.zh-CN-YunjianNeural': '云健（男·激情）',
      'option.zh-CN-YunxiNeural': '云希（男·阳光）',
      'option.zh-CN-YunxiaNeural': '云夏（男·可爱）',
      'option.zh-CN-YunyangNeural': '云扬（男·专业）',
      'option.zh-CN-liaoning-XiaobeiNeural': '晓北（东北话）',
      'option.zh-CN-shaanxi-XiaoniNeural': '晓妮（陕西话）',
      'f.ttsSuppressDuringSpeech': '播报时忽略麦克风触发',
      'f.ttsSuppressDuringSpeech.hint': '播报期间只听不录，播完恢复。',
      'f.ttsBargeIn': '允许说话打断播报',
      'f.ttsBargeIn.hint': '开启后，播报中说话会立即停播并开始录音。',
      'tts.scope.head3': '前 3 句',
      'tts.scope.tail': '仅末段',
      'tts.scope.full': '全文',
      'tts.scope.short': '仅短回复',
      'tts.scope.off': '不播',
      'tts.voice.default': '系统默认',
      'notice.restored': '语音模式已恢复',
      'notice.resumed': '噪声已忽略，继续播报',
      'notice.yielded': '已让出麦克风给另一个 DSH 窗口',
      'notice.sent': '已发送',
      'notice.empty': '没听清，已丢弃',
      'notice.gate': '太短或没有内容，已丢弃',
      'reason.permission': '麦克风权限被拒绝或被占用',
      'reason.locked': '语音模式在另一个窗口开着',
      'reason.audio': '无法创建音频上下文或浏览器不支持采集',
      'reason.prepare': '语音模型未就绪，先在插件页下载并准备',
      'reason.runtime': '语音服务不可用',
      'reason.failures': '连续识别失败，已停麦',
      'reason.decode': '这段录音无法编码',
      'settings.title': '语音聊天模式',
      'settings.intro': '参数即时生效，保存在本机浏览器。',
      'settings.reset': '恢复默认',
      'settings.saved': '已保存',
      'settings.marker': '语音消息标记',
      'settings.markerHint': '加在语音提交的消息前面；留空则不标记。',
      'settings.diag': '诊断（最近 24 条引擎事件）',
      'settings.diagEmpty': '还没有事件。',
      'settings.ttsTest': '播放测试',
      'settings.ttsTestHint': '用系统语音念一句测试话；听不到就是系统语音/扬声器问题。',
      'settings.previewText': '试听文本',
      'settings.stopTest': '停止',
      'settings.previewHint': '这里的改动立即生效；试听会用当前音色与参数念上一段。' ,
      'deps.title': '依赖状态',
      'deps.probing': '正在检查 Edge TTS…',
      'deps.routeError': 'Host 路由不可用',
      'deps.edgeReady': 'Edge TTS 已就绪',
      'deps.edgeMissing': '未安装 edge-tts（将回退系统语音）',
      'deps.edgeUnknown': 'Edge TTS 状态未知',
      'deps.install': '需要时运行：python -m pip install edge-tts',
      'deps.sourceVendor': '插件自带依赖',
      'deps.sourceSystem': '系统已安装',
      'fallback.title': '语音播报已回退到系统语音',
      'fallback.detail': 'Edge 语音暂时不可用（网络或依赖问题），本次改用系统音色；恢复后会自动用回 Edge。',
      'fallback.dismiss': '知道了',
      'unit.minutes': '分钟',
      'f.energyThreshold': '触发阈值',
      'f.energyThreshold.hint': '麦克风电平超过它才开始录音；环境吵就调高。',
      'f.minSpeechMs': '最短说话时长',
      'f.minSpeechMs.hint': '短于它不触发，防键盘声误触。',
      'f.preRollMs': '前置缓冲',
      'f.preRollMs.hint': '触发前保留的音频，防止吃掉第一个字。',
      'f.silenceMs': '静音收尾',
      'f.silenceMs.hint': '静音超过它就把这段送去识别。',
      'f.cooldownMs': '提交冷却',
      'f.cooldownMs.hint': '提交后短暂忽略触发，避免自己触发自己。',
      'f.maxSeconds': '单段上限',
      'f.maxSeconds.hint': '一段最长录多久，到时强制收尾。',
      'f.minChars': '最短字数',
      'f.minChars.hint': '识别结果短于它则丢弃。',
      'f.maxFailures': '连续失败上限',
      'f.maxFailures.hint': '连续失败到它就停麦并置灰。',
      'f.idleExitMs': '空闲自动退出',
      'f.idleExitMs.hint': '这么久没有语音输入就自动关闭（分钟）；填 0 = 不自动退出。',
      'f.blurExitMs': '失焦自动退出',
      'f.blurExitMs.hint': '窗口失焦这么久后自动关闭（分钟）；填 0 = 不因失焦退出。',
      'f.blurExitMs.disabledHint': '未开启「后台/失焦时继续监听」时窗口一被遮挡就会停麦，这个时长实际不生效。',
      'f.ttsEnabled.disabledHint': '先开启「语音回复」，这一组参数才有意义。',
      'f.ttsScope.disabledHint': '播报范围设为「关闭」时不会朗读，这些参数不生效。',
      'f.ttsEngine.mismatchHint': '当前播报引擎用不到这个参数。',
      'f.ttsSkipOpener.disabledHint': '只有「前 3 句」范围才跳过开场白。',
      'f.ttsBargeIn.disabledHint': '未开启「播报时忽略麦克风触发」时，说话本来就能随时插话。',
      'f.listenWhileHidden': '后台/失焦时继续监听（麦克风）',
      'f.listenWhileHidden.hint': '只管麦克风：开启后窗口被遮挡/最小化也继续采集；默认关。注意别和下面的「失焦/隐藏时继续播报」混淆。',
      'f.longPressMs': '长按插话阈值',
      'f.longPressMs.hint': '按住开关超过它，下一次说话走 steer（毫秒）。'
    };

    var EN = {
      'toggle.off': 'Turn on voice chat mode',
      'toggle.arming': 'Preparing voice',
      'toggle.listening': 'Voice mode: listening',
      'toggle.capturing': 'Voice mode: recording',
      'toggle.transcribing': 'Voice mode: transcribing',
      'toggle.submitting': 'Voice mode: submitting',
      'toggle.blocked': 'Voice mode unavailable',
      'toggle.steerArmed': 'Long press armed: next utterance will steer',
      'chip.OFF': 'Voice',
      'chip.ARMING': 'Preparing',
      'chip.LISTENING': 'Listening',
      'chip.CAPTURING': 'Recording',
      'chip.TRANSCRIBING': 'Transcribing',
      'chip.SUBMITTING': 'Sending',
      'chip.BLOCKED': 'Voice',
      'chip.SPEAKING': 'Speaking',
      'toggle.speaking': 'Speaking (click to stop)',
      'toggle.statusHint': 'Voice state; toggle the microphone beside the composer',
      'sessionDot.active': 'Voice mode is active in this session',
      'sessionDot.enabled': 'Voice mode is enabled for this session (restores when switched back)',
      'ttsToggle.on': 'Voice replies: on (click to mute)',
      'ttsToggle.off': 'Voice replies: off (click to enable)',
      'ttsToggle.shortOn': 'Read',
      'ttsToggle.shortOff': 'Muted',
      'section.tts': 'Voice replies',
      'section.input': 'Input and triggers',
      'section.input.hint': 'When the microphone starts and when it finishes.',
      'section.exit': 'Exit and background',
      'section.exit.hint': 'Privacy: whether listening continues when unfocused or in the background.',
      'section.tts.hint': 'Which engine, which voice, and how much to read.',
      'section.advanced': 'Advanced parameters',
      'section.misc': 'Other',
      'section.misc.hint': 'Visible marker for voice-submitted messages.',
      'f.ttsEnabled': 'Enable voice replies',
      'f.ttsEnabled.hint': 'Read assistant replies aloud; only while voice mode is on.',
      'f.ttsScope': 'Playback scope',
      'f.ttsMaxChars': 'Max characters',
      'f.ttsMaxChars.hint': 'Truncate longer text so one reply never runs too long.',
      'f.ttsSkipOpener': 'Skip openers',
      'f.ttsSkipOpener.hint': 'Do not read short fillers such as "OK" or "one moment".',
      'f.ttsSentenceChars': 'Sentence limit',
      'f.ttsSentenceChars.hint': 'Overlong sentences are split at commas.',
      'f.ttsRate': 'Rate',
      'f.ttsPauseMs': 'Pause between sentences',
      'f.ttsPauseMs.hint': 'Silence between segments for both engines; 0 disables it.',
      'f.ttsPitch': 'Pitch',
      'f.ttsPitch.hint': '0 is low, 2 is high; 1 is the default.',
      'f.ttsVolume': 'Volume',
      'f.ttsVolume.hint': '0 to 1; default 1.',
      'f.ttsEngine': 'Playback engine',
      'f.ttsEngine.hint': 'Edge voices sound natural but need network; system voices work offline.',
      'f.ttsEdgeVoice': 'Edge voice',
      'f.ttsEdgeRate': 'Edge rate',
      'f.ttsEdgeRate.hint': 'Percent, -50% to +50%.',
      'f.ttsEdgeVolume': 'Edge volume',
      'f.ttsEdgeVolume.hint': 'Percent, -50% to +50%.',
      'f.ttsEdgePitch': 'Edge pitch',
      'f.ttsEdgePitch.hint': 'Hz, -50 to +50.',
      'f.ttsEdgePrefetch': 'Prefetch next sentence',
      'f.ttsEdgePrefetch.hint': 'Synthesize the next sentence while the current one plays.',
      'f.ttsFallbackToSystem': 'Fall back to system voice',
      'f.ttsFallbackToSystem.hint': 'Switch to the local voice on network/timeout/API failures.',
      'f.ttsEdgeTimeoutMs': 'Per-sentence timeout',
      'f.ttsEdgeTimeoutMs.hint': 'Retry once, then fall back; default 20s, raise it on slow networks.',
      'f.ttsKeepPlayingOnUnfocused': 'Keep speaking when unfocused (playback only)',
      'f.ttsKeepPlayingOnUnfocused.hint': 'Playback only: let the current speech finish when the window is unfocused; it does not keep listening for you.',
      'f.ttsSpeakWhenIdle': 'Speak even when the mic is off',
      'f.ttsSpeakWhenIdle.hint': 'On: voice notes are read out even while the mode is off/idle. Off: they are queued and played once you turn the mode back on.',
      'f.ttsVoice': 'Voice',
      'f.ttsVoice.hint': 'Used by the system engine only.',
      'option.edge': 'Edge neural voice (online)',
      'option.system': 'System voice (local)',
      'option.zh-CN-XiaoxiaoNeural': 'Xiaoxiao (F, warm)',
      'option.zh-CN-XiaoyiNeural': 'Xiaoyi (F, lively)',
      'option.zh-CN-YunjianNeural': 'Yunjian (M, passionate)',
      'option.zh-CN-YunxiNeural': 'Yunxi (M, sunny)',
      'option.zh-CN-YunxiaNeural': 'Yunxia (M, cute)',
      'option.zh-CN-YunyangNeural': 'Yunyang (M, professional)',
      'option.zh-CN-liaoning-XiaobeiNeural': 'Xiaobei (Northeastern)',
      'option.zh-CN-shaanxi-XiaoniNeural': 'Xiaoni (Shaanxi)',
      'f.ttsSuppressDuringSpeech': 'Ignore microphone while speaking',
      'f.ttsSuppressDuringSpeech.hint': 'Listen but do not record during playback; resume afterwards.',
      'f.ttsBargeIn': 'Allow speech to interrupt',
      'f.ttsBargeIn.hint': 'When on, speaking stops playback and starts recording immediately.',
      'tts.scope.head3': 'First 3 sentences',
      'tts.scope.tail': 'Last part',
      'tts.scope.full': 'Full text',
      'tts.scope.short': 'Short replies only',
      'tts.scope.off': 'Off',
      'tts.voice.default': 'System default',
      'notice.restored': 'Voice mode restored',
      'notice.resumed': 'Noise ignored; playback resumed',
      'notice.yielded': 'Microphone handed to another DSH window',
      'notice.sent': 'Sent',
      'notice.empty': 'Nothing recognized; dropped',
      'notice.gate': 'Too short or empty; dropped',
      'reason.permission': 'Microphone permission denied or in use',
      'reason.locked': 'Voice mode is on in another window',
      'reason.audio': 'No audio context or capture support',
      'reason.prepare': 'Speech model not ready; prepare it from Plugins',
      'reason.runtime': 'Speech service unavailable',
      'reason.failures': 'Recognition kept failing; microphone stopped',
      'reason.decode': 'The recording could not be encoded',
      'settings.title': 'Voice chat mode',
      'settings.intro': 'Changes apply immediately and are stored in this browser.',
      'settings.reset': 'Restore defaults',
      'settings.saved': 'Saved',
      'settings.marker': 'Voice message marker',
      'settings.markerHint': 'Prefixed to messages sent by voice; leave empty to disable.',
      'settings.diag': 'Diagnostics (last 24 engine events)',
      'settings.diagEmpty': 'No events yet.',
      'settings.ttsTest': 'Test playback',
      'settings.ttsTestHint': 'Speak a test sentence with the system voice; silence means a system-voice or speaker problem.',
      'settings.previewText': 'Sample text',
      'settings.stopTest': 'Stop',
      'settings.previewHint': 'Changes apply immediately; the sample is read with the current voice and parameters.',
      'deps.title': 'Dependencies',
      'deps.probing': 'Checking Edge TTS…',
      'deps.routeError': 'Host route unavailable',
      'deps.edgeReady': 'Edge TTS ready',
      'deps.edgeMissing': 'edge-tts is not installed (falls back to the system voice)',
      'deps.edgeUnknown': 'Edge TTS status unknown',
      'deps.install': 'Install with: python -m pip install edge-tts',
      'deps.sourceVendor': 'bundled with the plugin',
      'deps.sourceSystem': 'installed on the system',
      'fallback.title': 'Speech fell back to the system voice',
      'fallback.detail': 'Edge TTS is unavailable right now (network or dependency); this reply used the system voice. Edge is used again automatically once it recovers.',
      'fallback.dismiss': 'Dismiss',
      'unit.minutes': 'min',
      'f.energyThreshold': 'Trigger threshold',
      'f.energyThreshold.hint': 'Recording starts above this microphone level; raise it in noisy rooms.',
      'f.minSpeechMs': 'Minimum speech',
      'f.minSpeechMs.hint': 'Shorter sounds do not trigger; avoids keyboard noise.',
      'f.preRollMs': 'Pre-roll buffer',
      'f.preRollMs.hint': 'Audio kept before the trigger so the first syllable is not clipped.',
      'f.silenceMs': 'Silence to finish',
      'f.silenceMs.hint': 'After this much silence the utterance is transcribed.',
      'f.cooldownMs': 'Submit cooldown',
      'f.cooldownMs.hint': 'Ignore triggers briefly after a submit to avoid self-triggering.',
      'f.maxSeconds': 'Max duration',
      'f.maxSeconds.hint': 'Longest single recording; it is force-finished at this limit.',
      'f.minChars': 'Minimum characters',
      'f.minChars.hint': 'Transcripts shorter than this are dropped.',
      'f.maxFailures': 'Failure limit',
      'f.maxFailures.hint': 'After this many consecutive failures the microphone stops.',
      'f.idleExitMs': 'Idle exit',
      'f.idleExitMs.hint': 'Turn off after this long without voice input (minutes); 0 = never auto-exit.',
      'f.blurExitMs': 'Blur exit',
      'f.blurExitMs.hint': 'Turn off after the window stays unfocused this long (minutes); 0 = never exit on blur.',
      'f.blurExitMs.disabledHint': 'With background listening off, an occluded window stops the microphone right away, so this delay has no effect.',
      'f.ttsEnabled.disabledHint': 'Turn on voice replies first; the rest of this group has no effect until then.',
      'f.ttsScope.disabledHint': 'With the read-aloud scope set to off nothing is spoken, so these values do not apply.',
      'f.ttsEngine.mismatchHint': 'The current engine does not use this parameter.',
      'f.ttsSkipOpener.disabledHint': 'Only the first-3-sentences scope skips the opening line.',
      'f.ttsBargeIn.disabledHint': 'With microphone suppression off, speaking can always interrupt; this switch does nothing.',
      'f.listenWhileHidden': 'Keep listening in background (microphone)',
      'f.listenWhileHidden.hint': 'Microphone only: keep capturing when the window is occluded or minimized; off by default. Not the same as the playback option below.',
      'f.longPressMs': 'Long-press threshold',
      'f.longPressMs.hint': 'Holding the toggle longer arms steer for the next utterance (ms).'
    };

    function now() {
      return Date.now();
    }

    function delay(ms) {
      return new Promise(function (resolve) {
        setTimeout(resolve, ms);
      });
    }

    function describeError(error) {
      if (error === null || error === undefined) return 'unknown';
      if (typeof error === 'string') return error;
      var head = error.code ? String(error.code) : error.name ? String(error.name) : '';
      var message = error.message ? String(error.message) : '';
      var text = message ? (head ? head + ': ' + message : message) : head;
      return text || String(error);
    }

    // ── TTS：文本清洗 / 切句 / 播报范围 / Web Speech 播放器 ──
    function stripMarkdown(text) {
      return String(text)
        .replace(/^[ \t]*\[voice-note\]:.*$/gim, ' ')
        .replace(/<!--[\s\S]*?-->/g, ' ')        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/`([^`]*)`/g, '$1')
        .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replace(/^#{1,6}\s+/gm, '')
        .replace(/^\s*[-*+]\s+/gm, '')
        .replace(/^\s*\d+[.)]\s+/gm, '')
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/__([^_]+)__/g, '$1')
        .replace(/[*_~>#]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    }

    // 助手显式给出的口播稿：`[voice-note]: <内容>`，可在一轮回复里出现多次，
    // 按出现顺序逐段朗读（开始前/工作中/结束时各一段）。
    //
    // 清洗：模型偶尔会把字面转义（\n \r \t）和 Markdown 记号写进口播稿，
    // 直接送 TTS 会被念成「反斜杠 n」。这里统一洗成可念的纯文本。
    function sanitizeSpeech(raw) {
      var text = String(raw || '');
      // 1) 字面转义序列：反斜杠 + 字母 → 空格（\n \r \t \v \f \0 \a \b）
      text = text.replace(/\\[nrtvf0ab]/gi, ' ');
      // 2) 残留的孤立反斜杠
      text = text.replace(/\\+/g, ' ');
      // 3) Markdown 链接 [文字](地址) → 只留文字
      text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
      // 4) 强调 / 代码 / 标题 / 引用记号
      text = text.replace(/[*_`#>~|]+/g, ' ');
      // 5) HTML 标签
      text = text.replace(/<[^>]*>/g, ' ');
      // 6) 连续空白（含真实换行、制表）压成一个空格
      text = text.replace(/\s+/g, ' ').trim();
      return text;
    }

    function extractVoiceBlocks(text) {
      var raw = String(text || '');
      var blocks = [];
      var anglePattern = /^[ \t]*\[voice-note\]:[ \t]*<([\s\S]*?)>[ \t]*$/gim;
      var match = anglePattern.exec(raw);
      while (match !== null) {
        var angleContent = sanitizeSpeech(match[1]);
        if (angleContent !== '') blocks.push(angleContent);
        match = anglePattern.exec(raw);
      }
      if (blocks.length > 0) return blocks;
      var linePattern = /^[ \t]*\[voice-note\]:[ \t]*(.+)$/gim;
      match = linePattern.exec(raw);
      while (match !== null) {
        var lineContent = sanitizeSpeech(match[1]);
        if (lineContent !== '') blocks.push(lineContent);
        match = linePattern.exec(raw);
      }
      if (blocks.length > 0) return blocks;
      var commentPattern = /<!--\s*voice\s*([\s\S]*?)-->/gi;
      match = commentPattern.exec(raw);
      while (match !== null) {
        var content = sanitizeSpeech(match[1]);
        if (content !== '') blocks.push(content);
        match = commentPattern.exec(raw);
      }
      return blocks;
    }

    function splitSentences(text, maxChars) {
      var raw = String(text).trim();
      if (raw === '') return [];
      var pieces = raw.split(/(?<=[。！？!?；;\n])/);
      var sentences = [];
      for (var index = 0; index < pieces.length; index += 1) {
        var piece = pieces[index].trim();
        if (piece === '') continue;
        if (piece.length > maxChars) {
          var chunks = piece.split(/(?<=[，,、])/);
          var buffer = '';
          for (var cursor = 0; cursor < chunks.length; cursor += 1) {
            if (buffer !== '' && (buffer + chunks[cursor]).length > maxChars) {
              sentences.push(buffer);
              buffer = '';
            }
            buffer += chunks[cursor];
          }
          if (buffer !== '') sentences.push(buffer);
        } else {
          sentences.push(piece);
        }
      }
      return sentences;
    }

    function isOpenerSentence(sentence) {
      var trimmed = String(sentence).trim();
      // 只跳过“短且以填充词开头”的句子；真正带内容的句子不跳。
      if (trimmed.length > 24) return false;
      return /^(好的|好|收到|嗯+|明白|我看看|我先|稍等|等一下|让我|我来|行|可以|没问题)([，,。.!！…~\s]|$)/.test(trimmed);
    }

    function pickSpeechText(raw) {
      var text = stripMarkdown(raw);
      if (text === '') return '';
      var scope = CONFIG.ttsScope;
      if (scope === 'off') return '';
      var sentences = splitSentences(text, CONFIG.ttsSentenceChars);
      if (sentences.length === 0) return '';
      var picked = [];
      if (scope === 'head3') {
        var start = 0;
        if (CONFIG.ttsSkipOpener) {
          for (var skip = 0; skip < 2 && start < sentences.length; skip += 1) {
            if (isOpenerSentence(sentences[start])) start += 1;
            else break;
          }
          if (start >= sentences.length) start = 0;
        }
        picked = sentences.slice(start, start + 3);
      } else if (scope === 'tail') {
        var total = 0;
        for (var index = sentences.length - 1; index >= 0; index -= 1) {
          total += sentences[index].length;
          picked.unshift(sentences[index]);
          if (total >= CONFIG.ttsMaxChars) break;
        }
      } else if (scope === 'full') {
        picked = sentences;
      } else if (scope === 'short') {
        if (text.length > CONFIG.ttsMaxChars) return '';
        picked = sentences;
      }
      var joined = picked.join('');
      if (joined.length > CONFIG.ttsMaxChars) joined = joined.slice(0, CONFIG.ttsMaxChars);
      return joined.trim();
    }

    function SystemSpeaker(onChange) {
      this.onChange = onChange;
      this.queue = [];
      this.index = 0;
      this.speaking = false;
      this.utterance = null;
      this.voices = [];
      this.pauseTimer = null;
      var self = this;
      this.refreshVoices();
      try {
        if (window.speechSynthesis && typeof window.speechSynthesis.addEventListener === 'function') {
          window.speechSynthesis.addEventListener('voiceschanged', function () {
            self.refreshVoices();
          });
        }
      } catch (_error) {}
    }

    SystemSpeaker.prototype.refreshVoices = function () {
      try {
        this.voices = window.speechSynthesis ? window.speechSynthesis.getVoices() || [] : [];
      } catch (_error) {
        this.voices = [];
      }
    };

    SystemSpeaker.prototype.listVoices = function () {
      this.refreshVoices();
      return this.voices;
    };

    SystemSpeaker.prototype.remainingText = function () {
      if (!this.speaking) return '';
      return String(this.currentText || '') + this.queue.slice(this.index).join('');
    };

    SystemSpeaker.prototype.resolveVoice = function () {
      if (!CONFIG.ttsVoice) return null;
      for (var index = 0; index < this.voices.length; index += 1) {
        if (this.voices[index].name === CONFIG.ttsVoice) return this.voices[index];
      }
      return null;
    };

    // 追加到播放队列：正在播时接在后面，空闲时立即开始。
    SystemSpeaker.prototype.append = function (text) {
      if (!window.speechSynthesis) return;
      var parts = splitSentences(text, CONFIG.ttsSentenceChars);
      if (parts.length === 0) return;
      if (this.pauseTimer !== null) {
        clearTimeout(this.pauseTimer);
        this.pauseTimer = null;
      }
      if (this.speaking) {
        this.queue = this.queue.slice(this.index).concat(parts);
        this.index = 0;
        this.pump();
        return;
      }
      this.queue = parts;
      this.index = 0;
      this.startNext();
    };

    SystemSpeaker.prototype.speak = function (text) {
      if (!window.speechSynthesis) return;
      var parts = splitSentences(text, CONFIG.ttsSentenceChars);
      if (parts.length === 0) return;
      if (this.pauseTimer !== null) {
        clearTimeout(this.pauseTimer);
        this.pauseTimer = null;
      }
      this.queue = parts;
      this.index = 0;
      if (!this.speaking) this.startNext();
    };

    SystemSpeaker.prototype.startNext = function () {
      var self = this;
      if (this.index >= this.queue.length) {
        this.finish();
        return;
      }
      var text = this.queue[this.index];
      this.currentText = text;
      this.index += 1;
      var utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = CONFIG.ttsRate || 1;
      utterance.pitch = typeof CONFIG.ttsPitch === 'number' ? CONFIG.ttsPitch : 1;
      utterance.volume = typeof CONFIG.ttsVolume === 'number' ? CONFIG.ttsVolume : 1;
      var voice = this.resolveVoice();
      if (voice !== null) utterance.voice = voice;
      if (/[\u4e00-\u9fff]/.test(text)) utterance.lang = 'zh-CN';
      utterance.onend = function () {
        self.scheduleNext();
      };
      utterance.onerror = function () {
        self.scheduleNext();
      };
      this.utterance = utterance;
      if (!this.speaking) {
        this.speaking = true;
        if (typeof this.onChange === 'function') this.onChange(true);
      }
      try {
        window.speechSynthesis.speak(utterance);
      } catch (_error) {
        this.finish();
      }
    };

    SystemSpeaker.prototype.scheduleNext = function () {
      var self = this;
      if (this.index >= this.queue.length) {
        this.finish();
        return;
      }
      if (CONFIG.ttsPauseMs > 0) {
        if (this.pauseTimer !== null) clearTimeout(this.pauseTimer);
        this.pauseTimer = setTimeout(function () {
          self.pauseTimer = null;
          self.startNext();
        }, CONFIG.ttsPauseMs);
      } else {
        this.startNext();
      }
    };

    SystemSpeaker.prototype.finish = function () {
      if (this.pauseTimer !== null) {
        clearTimeout(this.pauseTimer);
        this.pauseTimer = null;
      }
      this.queue = [];
      this.index = 0;
      this.utterance = null;
      this.currentText = null;
      if (this.speaking) {
        this.speaking = false;
        if (typeof this.onChange === 'function') this.onChange(false);
      }
    };

    SystemSpeaker.prototype.cancel = function () {
      try {
        if (window.speechSynthesis) window.speechSynthesis.cancel();
      } catch (_error) {}
      this.finish();
    };

    SystemSpeaker.prototype.isSpeaking = function () {
      return this.speaking;
    };

    // ── Edge TTS 播放器：POST /api/voice-mode.tts → mp3 Blob → Audio ──
    function EdgePlayer(onChange, onLog, onFallback) {
      this.onChange = onChange;
      this.onLog = onLog;
      this.onFallback = onFallback;
      this.queue = [];
      this.index = 0;
      this.speaking = false;
      this.audio = null;
      this.audioUrl = null;
      this.abort = null;
      this.pauseTimer = null;
      this.cache = new Map();
      this.inflight = new Set();
      this.epoch = 0;
    }

    EdgePlayer.prototype.isSpeaking = function () {
      return this.speaking;
    };

    EdgePlayer.prototype.speak = function (text) {
      var parts = splitSentences(text, CONFIG.ttsSentenceChars);
      if (parts.length === 0) return;
      this.cancelAudio();
      this.queue = parts;
      this.index = 0;
      this.startNext();
    };

    EdgePlayer.prototype.append = function (text) {
      var parts = splitSentences(text, CONFIG.ttsSentenceChars);
      if (parts.length === 0) return;
      if (this.speaking) {
        this.queue = this.queue.slice(this.index).concat(parts);
        this.index = 0;
        return;
      }
      this.queue = this.queue.slice(this.index).concat(parts);
      this.index = 0;
      this.startNext();
    };

    EdgePlayer.prototype.startNext = function () {
      var self = this;
      if (this.index >= this.queue.length) {
        this.finish();
        return;
      }
      // 从「开始取音频」就算 speaking：缓冲期也抑制麦克风，避免自己触发自己。
      if (!this.speaking) {
        this.speaking = true;
        this.onChange(true);
      }
      var sentence = this.queue[this.index];
      this.currentText = sentence;
      var slot = this.index;
      this.index += 1;
      this.pump();
      var epoch = this.epoch;
      this.fetchSentence(sentence)
        .then(function (blob) {
          if (epoch !== self.epoch) return;
          self.play(blob);
          if (CONFIG.ttsEdgePrefetch && self.index < self.queue.length) self.prefetch(self.queue[self.index]);
        })
        .catch(function (error) {
          if (epoch !== self.epoch) return;
          self.onLog('edge tts failed: ' + String((error && error.message) || error));
          var rest = self.queue.slice(slot).join('');
          self.queue = [];
          self.index = 0;
          self.speaking = false;
          if (CONFIG.ttsFallbackToSystem) {
            self.onLog('falling back to system voice');
            self.onFallback(rest);
          } else {
            self.finish();
          }
        });
    };

    EdgePlayer.prototype.prefetch = function (sentence) {
      var self = this;
      if (this.cache.has(sentence)) return;
      if (this.inflight.has(sentence)) return;
      this.inflight.add(sentence);
      this.fetchSentence(sentence)
        .then(function (blob) {
          self.cache.set(sentence, blob);
          while (self.cache.size > 12) {
            var oldest = self.cache.keys().next().value;
            self.cache.delete(oldest);
          }
        })
        .catch(function () {})
        .finally(function () {
          self.inflight.delete(sentence);
          self.pump();
        });
    };

    // 读到哪里就并行取到哪里：窗口 6 段、同时在飞 3 条，结果进缓存等播放。
    EdgePlayer.prototype.pump = function () {
      if (!CONFIG.ttsEdgePrefetch) return;
      var window = 6;
      var limit = 3;
      for (var cursor = this.index; cursor < this.queue.length && cursor < this.index + window; cursor += 1) {
        if (this.inflight.size >= limit) return;
        // 正在念/正在取的那一段已经由 startNext 负责，不再重复请求。
        if (this.speaking && this.queue[cursor] === this.currentText) continue;
        this.prefetch(this.queue[cursor]);
      }
    };

    EdgePlayer.prototype.fetchSentence = function (sentence) {
      var self = this;
      var cachedBlob = this.cache.get(sentence);
      if (cachedBlob !== undefined) {
        this.cache.delete(sentence);
        return Promise.resolve(cachedBlob);
      }
      var attempt = 0;
      function run() {
        attempt += 1;
        return self.fetchSentenceOnce(sentence).catch(function (error) {
          var message = String((error && error.message) || error);
          // 网络抖动/超时会重试一次；4xx 属于请求本身的问题，重试无意义。
          if (attempt >= 2 || message.indexOf('http 4') === 0) throw error;
          self.onLog('edge tts retry after: ' + message);
          return new Promise(function (resolve) {
            setTimeout(resolve, 400);
          }).then(run);
        });
      }
      return run();
    };

    EdgePlayer.prototype.fetchSentenceOnce = function (sentence) {
      var self = this;
      var controller = new AbortController();
      this.abort = controller;
      var timer = setTimeout(function () {
        controller.abort();
      }, Math.max(3000, CONFIG.ttsEdgeTimeoutMs + 2000));
      return fetch('/api/voice-mode.tts', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          text: sentence,
          voice: CONFIG.ttsEdgeVoice,
          rate: CONFIG.ttsEdgeRate,
          volume: CONFIG.ttsEdgeVolume,
          pitch: CONFIG.ttsEdgePitch,
          timeoutMs: CONFIG.ttsEdgeTimeoutMs
        }),
        signal: controller.signal
      })
        .then(function (response) {
          if (!response.ok) {
            return response
              .json()
              .catch(function () {
                return {};
              })
              .then(function (body) {
                throw new Error('http ' + response.status + ' ' + String((body && body.message) || ''));
              });
          }
          return response.blob();
        })
        .finally(function () {
          clearTimeout(timer);
          if (self.abort === controller) self.abort = null;
        });
    };

    EdgePlayer.prototype.play = function (blob) {
      var self = this;
      this.releaseAudio();
      var url = URL.createObjectURL(blob);
      var audio = new Audio();
      audio.src = url;
      this.audio = audio;
      this.audioUrl = url;
      audio.onended = function () {
        self.releaseAudio();
        self.scheduleNext();
      };
      audio.onerror = function () {
        self.onLog('edge audio playback error');
        self.releaseAudio();
        self.scheduleNext();
      };
      audio.play().catch(function (error) {
        self.onLog('edge audio play rejected: ' + String((error && error.message) || error));
        self.releaseAudio();
        self.scheduleNext();
      });
    };

    EdgePlayer.prototype.scheduleNext = function () {
      var self = this;
      if (this.index >= this.queue.length) {
        this.finish();
        return;
      }
      // 下一段还没取回来时，网络等待已经构成停顿，不再额外加句间静音。
      var waitingForFetch = CONFIG.ttsEdgePrefetch === true && this.cache.has(this.queue[this.index]) !== true;
      if (CONFIG.ttsPauseMs > 0 && !waitingForFetch) {
        if (this.pauseTimer !== null) clearTimeout(this.pauseTimer);
        this.pauseTimer = setTimeout(function () {
          self.pauseTimer = null;
          self.startNext();
        }, CONFIG.ttsPauseMs);
      } else {
        this.startNext();
      }
    };

    EdgePlayer.prototype.releaseAudio = function () {
      if (this.audio !== null) {
        try {
          this.audio.onended = null;
          this.audio.onerror = null;
          this.audio.pause();
          this.audio.src = '';
        } catch (_error) {}
        this.audio = null;
      }
      if (this.audioUrl !== null) {
        try {
          URL.revokeObjectURL(this.audioUrl);
        } catch (_error) {}
        this.audioUrl = null;
      }
    };

    EdgePlayer.prototype.cancelAudio = function () {
      this.epoch += 1;
      if (this.abort !== null) {
        try {
          this.abort.abort();
        } catch (_error) {}
        this.abort = null;
      }
      this.releaseAudio();
      if (this.pauseTimer !== null) {
        clearTimeout(this.pauseTimer);
        this.pauseTimer = null;
      }
    };

    EdgePlayer.prototype.finish = function () {
      this.cancelAudio();
      this.queue = [];
      this.index = 0;
      this.currentText = null;
      if (this.speaking) {
        this.speaking = false;
        this.onChange(false);
      }
    };

    EdgePlayer.prototype.cancel = function (keepCache) {
      this.finish();
      if (keepCache !== true) {
        this.cache.clear();
        this.inflight.clear();
      }
    };

    EdgePlayer.prototype.remainingText = function () {
      if (!this.speaking) return '';
      return String(this.currentText || '') + this.queue.slice(this.index).join('');
    };

    // ── 统一播放器：edge 优先，失败回退系统语音 ──
    function VoiceSpeaker(onChange, onLog, onFallbackNotice) {
      this.onChange = onChange;
      this.onLog = onLog;
      var self = this;
      this.system = new SystemSpeaker(onChange);
      this.edge = new EdgePlayer(onChange, onLog, function (text) {
        if (typeof onFallbackNotice === 'function') onFallbackNotice();
        self.system.append(text);
      });
    }

    VoiceSpeaker.prototype.listVoices = function () {
      return this.system.listVoices();
    };

    VoiceSpeaker.prototype.isSpeaking = function () {
      return this.edge.isSpeaking() || this.system.isSpeaking();
    };

    VoiceSpeaker.prototype.speak = function (text) {
      if (CONFIG.ttsEngine === 'system') {
        this.edge.cancel();
        this.system.speak(text);
        return;
      }
      this.system.cancel();
      this.edge.speak(text);
    };

    VoiceSpeaker.prototype.append = function (text) {
      if (CONFIG.ttsEngine === 'system') {
        this.edge.cancel();
        this.system.append(text);
        return;
      }
      this.system.cancel();
      this.edge.append(text);
    };

    VoiceSpeaker.prototype.cancel = function (keepCache) {
      this.edge.cancel(keepCache);
      this.system.cancel();
    };

    VoiceSpeaker.prototype.remainingText = function () {
      // Edge 失败回退系统语音时，后半段在 system 队列里，两段都要接上。
      var edge = this.edge.remainingText();
      var system = this.system.remainingText();
      if (edge === '') return system;
      if (system === '') return edge;
      return edge + system;
    };

    // ── 引擎 ──
    function VoiceEngine(ctx) {
      this.ctx = ctx;
      this.listeners = new Set();
      this.state = STATE.OFF;
      this.reason = null;
      this.blockKind = null;
      this.detail = null;
      this.level = 0;
      this.steerArmed = false;
      this.notice = null;
      this.noticeTone = 'ok';
      this.noticeSeq = 0;
      this.sessionId = null;
      this.enabled = new Map();
      this.failures = 0;
      this.generation = 0;
      this.busy = false;
      this.pendingArmOptions = null;
      this.reconcileTimer = null;
      this.busyWatchdog = null;

      this.stream = null;
      this.audioCtx = null;
      this.source = null;
      this.processor = null;
      this.muteGain = null;
      this.sampleRate = 48000;
      this.pcmChunks = [];
      this.totalSamples = 0;
      this.captureFrom = 0;
      this.captureStartAt = 0;
      this.lastVoiceAt = 0;
      this.voiceRun = 0;
      this.interruptFlag = false;
      this.lastSubmitAt = 0;
      this.lastFrameAt = 0;
      this.events = [];
      this.watchdogTimer = null;
      this.idleTimer = null;
      this.noticeTimer = null;
      this.lockRelease = null;
      this.suspendedByOtherWindow = false;
      this.speaking = false;
      this.suppressUntil = 0;
      this.bargeInRemainder = null;
      this.sessionRef = null;
      this.eventUnsubscribe = null;
      this.lastEventSeq = 0;
      this.lastEventCount = 0;
      this.ttsRouteInfo = null;
      this.ttsFallbackAt = null;
      this.pendingSpeeches = [];
      this.lastAssistantTurn = -1;
      this.lastAssistantText = '';
      this.narratedTurn = -1;
      var self = this;
      this.speaker = new VoiceSpeaker(function (speaking) {
        self.onSpeakingChange(speaking);
      }, function (message) {
        self.logEvent('tts', message);
      }, function () {
        self.noteTtsFallback();
      });

      this.snapshot = this.buildSnapshot();
      this.subscribe = this.subscribe.bind(this);
      this.getSnapshot = this.getSnapshot.bind(this);
      this.attach = this.attach.bind(this);
      this.detach = this.detach.bind(this);
      this.toggleOrRetry = this.toggleOrRetry.bind(this);
      this.markInterrupt = this.markInterrupt.bind(this);
      this.dispose = this.dispose.bind(this);
    }

    VoiceEngine.prototype.buildSnapshot = function () {
      return {
        state: this.state,
        reason: this.reason,
        blockKind: this.blockKind,
        detail: this.detail,
        level: this.level,
        steerArmed: this.steerArmed,
        notice: this.notice,
        noticeTone: this.noticeTone,
        noticeSeq: this.noticeSeq,
        speaking: this.speaking,
        ttsFallbackAt: this.ttsFallbackAt,
        ttsEnabled: CONFIG.ttsEnabled === true
      };
    };

    VoiceEngine.prototype.subscribe = function (listener) {
      this.listeners.add(listener);
      var self = this;
      return function () {
        self.listeners.delete(listener);
      };
    };

    VoiceEngine.prototype.getSnapshot = function () {
      return this.snapshot;
    };

    VoiceEngine.prototype.publish = function () {
      this.snapshot = this.buildSnapshot();
      var snapshot = this.snapshot;
      this.listeners.forEach(function (listener) {
        listener(snapshot);
      });
    };

    VoiceEngine.prototype.setState = function (state, reason, blockKind, detail) {
      this.state = state;
      this.reason = reason === undefined ? null : reason;
      this.blockKind = blockKind === undefined ? null : blockKind;
      this.detail = detail === undefined ? null : detail;
      this.logEvent('state ' + state, detail || reason || '');
      this.publish();
    };

    VoiceEngine.prototype.logEvent = function (kind, detail) {
      var entry = { t: Date.now(), kind: String(kind), detail: detail === undefined ? '' : String(detail) };
      this.events.push(entry);
      if (this.events.length > 60) this.events.shift();
      try {
        if (typeof console !== 'undefined' && console.debug) console.debug('[voice-mode]', entry.kind, entry.detail);
      } catch (_error) {}
    };

    VoiceEngine.prototype.getDiagnostics = function () {
      var lines = [];
      for (var index = 0; index < this.events.length; index += 1) {
        var entry = this.events[index];
        var date = new Date(entry.t);
        var hh = ('0' + date.getHours()).slice(-2);
        var mm = ('0' + date.getMinutes()).slice(-2);
        var ss = ('0' + date.getSeconds()).slice(-2);
        lines.push(hh + ':' + mm + ':' + ss + '  ' + entry.kind + (entry.detail ? ' — ' + entry.detail : ''));
      }
      return lines.slice(-24);
    };

    VoiceEngine.prototype.showNotice = function (text, tone) {
      var self = this;
      this.notice = text;
      this.noticeTone = tone || 'ok';
      this.noticeSeq += 1;
      this.publish();
      if (this.noticeTimer !== null) clearTimeout(this.noticeTimer);
      this.noticeTimer = setTimeout(function () {
        self.notice = null;
        self.noticeTimer = null;
        self.publish();
      }, 2400);
    };

    VoiceEngine.prototype.isActive = function () {
      return this.state !== STATE.OFF && this.state !== STATE.BLOCKED;
    };

    // 切到另一个 DSH 窗口时让出麦克风；切回来恢复之前的状态。
    VoiceEngine.prototype.suspendForOtherWindow = function () {
      if (!this.isActive()) return false;
      this.suspendedByOtherWindow = true;
      this.logEvent('window', 'yielded the microphone to another DSH window');
      this.showNotice('notice.yielded', 'ok');
      this.shutdown('other-window');
      return true;
    };

    VoiceEngine.prototype.resumeAfterOtherWindow = function () {
      if (this.suspendedByOtherWindow !== true) return;
      this.suspendedByOtherWindow = false;
      if (this.sessionId === null) return;
      this.logEvent('window', 'back in focus, restoring voice mode');
      this.arm({ restored: true });
    };

    VoiceEngine.prototype.attach = function (sessionId) {
      if (this.sessionId === sessionId) return;
      if (this.sessionId !== null) this.detach(this.sessionId);
      this.sessionId = sessionId;
      this.maybeWatchMessages();
      if (this.enabled.get(sessionId) === true) {
        if (this.busy) {
          this.pendingArmOptions = { restored: true };
        } else {
          this.arm({ restored: true });
        }
      }
      this.scheduleReconcile(sessionId, 0);
    };

    // 自愈：attach 之后若仍停在 OFF/BLOCKED（或 arm 被竞态吞掉），补一次；最多两次。
    VoiceEngine.prototype.scheduleReconcile = function (sessionId, attempt) {
      var self = this;
      if (this.reconcileTimer !== null) clearTimeout(this.reconcileTimer);
      this.reconcileTimer = setTimeout(function () {
        self.reconcileTimer = null;
        if (self.sessionId !== sessionId) return;
        if (self.enabled.get(sessionId) !== true) return;
        if (self.state !== STATE.OFF && self.state !== STATE.BLOCKED) return;
        if (self.busy) {
          if (attempt < 2) self.scheduleReconcile(sessionId, attempt + 1);
          return;
        }
        self.logEvent('voice', 'reconcile: restoring voice mode for ' + String(sessionId));
        self.arm({ restored: true });
      }, 1500);
    };

    VoiceEngine.prototype.detach = function (sessionId) {
      if (this.sessionId !== sessionId) return;
      if (this.isActive() || this.state === STATE.BLOCKED) this.shutdown('switch', { keepPlayback: true });
      this.sessionId = null;
    };

    VoiceEngine.prototype.toggleOrRetry = function () {
      if (this.state === STATE.OFF || this.state === STATE.BLOCKED) {
        this.arm({ restored: false });
        return;
      }
      this.shutdown('toggle');
    };

    VoiceEngine.prototype.markInterrupt = function () {
      // 长按只在「已经在听 / 在录」时有意义；OFF/BLOCKED 下不武装，避免恢复后误用 steer。
      if (this.state !== STATE.LISTENING && this.state !== STATE.CAPTURING) return;
      this.steerArmed = true;
      this.publish();
    };

    // 硬关闭顺序固定：先停采集，再停播放，最后 cancel / 放锁。顺序不能反。
    VoiceEngine.prototype.shutdown = function (kind, options) {
      var sessionId = this.sessionId;
      var keepPlayback = !!(options && options.keepPlayback);
      this.logEvent('shutdown', kind + (keepPlayback ? ' (keep playback)' : ''));
      this.generation += 1;
      this.clearIdle();
      this.maybeWatchMessages();
      this.bargeInRemainder = null;
      this.teardownAudio();
      if (!keepPlayback) this.stopPlayback();
      this.releaseLock();
      if (kind !== 'switch') {
        this.pendingArmOptions = null;
        if (sessionId !== null) this.enabled.delete(sessionId);
        this.failures = 0;
      }
      if (this.reconcileTimer !== null) {
        clearTimeout(this.reconcileTimer);
        this.reconcileTimer = null;
      }
      this.steerArmed = false;
      this.interruptFlag = false;
      this.pendingSpeeches = [];
      this.lastAssistantText = '';
      this.narratedTurn = -1;
      this.level = 0;
      this.setState(STATE.OFF, null, null, null);
    };

    VoiceEngine.prototype.teardownAudio = function () {
      this.stopWatchdog();
      this.lastFrameAt = 0;
      var processor = this.processor;
      this.processor = null;
      if (processor !== null) {
        try {
          processor.onaudioprocess = null;
          processor.disconnect();
        } catch (_error) {}
      }
      var source = this.source;
      this.source = null;
      if (source !== null) {
        try {
          source.disconnect();
        } catch (_error) {}
      }
      var mute = this.muteGain;
      this.muteGain = null;
      if (mute !== null) {
        try {
          mute.disconnect();
        } catch (_error) {}
      }
      this.pcmChunks = [];
      this.totalSamples = 0;
      var stream = this.stream;
      this.stream = null;
      if (stream !== null) {
        try {
          stream.getTracks().forEach(function (track) {
            track.stop();
          });
        } catch (_error) {}
      }
      var ctx = this.audioCtx;
      this.audioCtx = null;
      if (ctx !== null) {
        try {
          ctx.close();
        } catch (_error) {}
      }
    };

    // 播放：MVP 只有 TTS；stopPlayback 也承担“硬关闭时停播”的钩子。
    VoiceEngine.prototype.stopPlayback = function (keepCache) {
      if (this.speaker) this.speaker.cancel(keepCache);
    };

    VoiceEngine.prototype.onSpeakingChange = function (speaking) {
      this.speaking = speaking;
      if (!speaking) {
        this.suppressUntil = now() + CONFIG.cooldownMs;
        this.logEvent('tts', 'finished speaking');
      } else {
        this.logEvent('tts', 'started speaking');
      }
      this.publish();
    };

    VoiceEngine.prototype.isSpeaking = function () {
      return this.speaking;
    };

    // 播报回退到系统语音时，给用户一个聊天里看得见的提示。
    VoiceEngine.prototype.noteTtsFallback = function () {
      this.ttsFallbackAt = Date.now();
      this.logEvent('tts', 'fallback notice shown to the user');
      this.publish();
    };

    VoiceEngine.prototype.clearTtsFallback = function () {
      if (this.ttsFallbackAt === null) return;
      this.ttsFallbackAt = null;
      this.publish();
    };

    // 失焦/隐藏触发的关闭：若正在播报且允许“失焦继续播”，先停麦但让播报自然结束。
    VoiceEngine.prototype.requestDeferredShutdown = function (kind) {
      if (CONFIG.ttsKeepPlayingOnUnfocused === true && this.isSpeaking()) {
        this.logEvent('shutdown', 'deferred playback (' + kind + '): microphone off, speech continues');
        this.shutdown(kind, { keepPlayback: true });
        return;
      }
      this.shutdown(kind);
    };

    VoiceEngine.prototype.extractAssistantText = function (message) {
      if (!message) return '';
      if (typeof message.text === 'string') return message.text;
      var content = message.content;
      if (!Array.isArray(content)) return '';
      var parts = [];
      for (var index = 0; index < content.length; index += 1) {
        var block = content[index];
        if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
      }
      return parts.join('\n');
    };

    VoiceEngine.prototype.onAssistantMessage = function (event) {
      var data = (event && event.data) || {};
      var message = data.message;
      var text = this.extractAssistantText(message);
      this.logEvent('tts', 'assistant event text=' + text.length + ' chars');
      if (text === '') return;
      var turn = typeof data.turn === 'number' ? data.turn : this.lastAssistantTurn;
      this.lastAssistantTurn = turn;
      var blocks = extractVoiceBlocks(text);
      if (blocks.length > 0) {
        // 显式口播：按出现顺序逐段加入播放队列，不再等 turn/end。
        this.narratedTurn = turn;
        for (var index = 0; index < blocks.length; index += 1) {
          var block = blocks[index].length > CONFIG.ttsMaxChars ? blocks[index].slice(0, CONFIG.ttsMaxChars) : blocks[index];
          this.logEvent('tts', 'voice block ' + (index + 1) + '/' + blocks.length + ' (' + block.length + ' chars)');
          this.queueSpeech(block);
        }
        return;
      }
      this.lastAssistantText = text;
      this.logEvent('tts', 'stored turn ' + turn + ' (' + text.length + ' chars)');
    };

    VoiceEngine.prototype.queueSpeech = function (speech) {
      if (speech === '') return;
      if (this.state !== STATE.LISTENING) {
        // 未开麦时也播报：口播稿是给耳朵的，不该因为麦克风没开就被扣下。
        // 关掉 ttsSpeakWhenIdle 才回到「先攒着、开麦再补」的老行为。
        if (CONFIG.ttsSpeakWhenIdle === true) {
          this.logEvent('tts', 'speak while idle ' + speech.length + ' chars');
          this.speaker.append(speech);
          return;
        }
        this.pendingSpeeches.push(speech);
        this.logEvent('tts', 'deferred (state ' + this.state + ')');
        return;
      }
      this.logEvent('tts', 'speak ' + speech.length + ' chars');
      this.speaker.append(speech);
    };

    VoiceEngine.prototype.onTurnEnd = function (event) {
      var data = (event && event.data) || {};
      // 这一轮已经用显式口播念过了：不再回退念正文。
      if (this.narratedTurn !== -1 && (typeof data.turn !== 'number' || data.turn === this.narratedTurn)) {
        this.narratedTurn = -1;
        this.lastAssistantText = '';
        this.logEvent('tts', 'turn narrated via voice blocks; fallback skipped');
        return;
      }
      if (this.lastAssistantText === '') return;
      // 未开麦时只念显式口播稿，不把正文前几句读出来——那是模式运行中才做的事。
      if (!this.isActive()) {
        this.lastAssistantText = '';
        this.logEvent('tts', 'idle: skip body fallback');
        return;
      }
      if (typeof data.turn === 'number' && data.turn !== this.lastAssistantTurn) return;
      var text = this.lastAssistantText;
      this.lastAssistantText = '';
      if (!CONFIG.ttsEnabled) return;
      var speech = pickSpeechText(text);
      if (speech === '') {
        this.logEvent('tts', 'skip: empty speech pick');
        return;
      }
      this.queueSpeech(speech);
    };

    VoiceEngine.prototype.speakNow = function (speech) {
      this.logEvent('tts', 'speak ' + speech.length + ' chars');
      this.speaker.append(speech);
    };

    // 供 Host 工具调用：直接念一段文本（不要求语音模式开着）。
    VoiceEngine.prototype.speakFromTool = function (text) {
      var trimmed = String(text || '').trim().slice(0, 500);
      if (trimmed === '') return false;
      this.logEvent('tts', 'tool speak ' + trimmed.length + ' chars');
      this.speaker.append(trimmed);
      return true;
    };

    VoiceEngine.prototype.probeTtsRoute = function () {
      var self = this;
      if (CONFIG.ttsEngine !== 'edge') return;
      fetch('/api/voice-mode.tts', { credentials: 'same-origin' })
        .then(function (response) {
          return response
            .json()
            .catch(function () {
              return {};
            })
            .then(function (body) {
              self.ttsRouteInfo = {
                resource: 'voice-mode.tts',
                ok: response.ok,
                status: response.status,
                edgeTts: body.edgeTts === undefined ? null : body.edgeTts,
                edgeTtsVersion: body.edgeTtsVersion === undefined ? null : body.edgeTtsVersion,
                voices: body.voices === undefined ? null : body.voices,
                python: body.python === undefined ? null : body.python,
                error: response.ok ? null : String(body.message || body.error || response.status)
              };
              self.logEvent('tts', 'route probe ' + response.status + ' edgeTts=' + String(self.ttsRouteInfo.edgeTts));
              self.publish();
            });
        })
        .catch(function (error) {
          self.ttsRouteInfo = { resource: 'voice-mode.tts', ok: false, error: String((error && error.message) || error) };
          self.logEvent('tts', 'route probe failed: ' + self.ttsRouteInfo.error);
          self.publish();
        });
    };

    VoiceEngine.prototype.testTts = function (text) {
      var speech = typeof text === 'string' && text.trim() !== '' ? text.trim().slice(0, 200) : '语音回复测试，一二三。';
      this.logEvent('tts', 'test requested (' + speech.length + ' chars)');
      if (!this.speaker) {
        this.logEvent('tts', 'no speaker available');
        return;
      }
      this.speaker.speak(speech);
    };

    VoiceEngine.prototype.onSessionEvents = function (windowSnapshot) {
      if (!windowSnapshot || !Array.isArray(windowSnapshot.entries)) return;
      var entries = windowSnapshot.entries;
      // 宿主不保证给 event.seq。0.2.2-rc.1 上实测缺失：seq 缺失时若仍按
      // “seq <= lastEventSeq 才跳过”，0 <= 0 会把每一条都吞掉（静默、无日志）。
      // 缺 seq 就退化成“只处理窗口尾部新追加的条目”：长度增加时从未见过的
      // 位置往后读；窗口回卷（变短）时从头扫。
      var fallbackStart = entries.length >= this.lastEventCount ? this.lastEventCount : 0;
      for (var index = 0; index < entries.length; index += 1) {
        var entry = entries[index];
        if (!entry || entry.type !== 'event' || !entry.event) continue;
        var event = entry.event;
        if (typeof event.seq === 'number') {
          if (event.seq <= this.lastEventSeq) continue;
          this.lastEventSeq = event.seq;
        } else if (index < fallbackStart) {
          continue;
        }
        if (event.type === 'assistant/message') this.onAssistantMessage(event);
        else if (event.type === 'turn/end') this.onTurnEnd(event);
      }
      this.lastEventCount = entries.length;
    };

    VoiceEngine.prototype.startMessageWatch = async function (generation) {
      if (!CONFIG.ttsEnabled) return;
      if (this.sessionRef !== null) return;
      var reference = null;
      try {
        reference = this.ctx.sessions.retain(this.sessionId, { source: 'voiceModeTts' });
        var binding = await reference.ready;
        if (generation !== this.generation || !CONFIG.ttsEnabled) {
          try {
            reference.release();
          } catch (_error) {}
          return;
        }
        this.sessionRef = reference;
        var source = binding.eventSource;
        var snapshot = typeof source.getSnapshot === 'function' ? source.getSnapshot() : null;
        this.lastEventSeq = 0;
        this.lastEventCount = 0;
        var seqSeen = false;
        if (snapshot && Array.isArray(snapshot.entries)) {
          this.lastEventCount = snapshot.entries.length;
          for (var index = 0; index < snapshot.entries.length; index += 1) {
            var entry = snapshot.entries[index];
            if (entry && entry.type === 'event' && entry.event && typeof entry.event.seq === 'number') {
              seqSeen = true;
              if (entry.event.seq > this.lastEventSeq) this.lastEventSeq = entry.event.seq;
            }
          }
        }
        var self = this;
        // ObservableSnapshot.subscribe(fn) 的回调不带参数：每次变化后自己 getSnapshot()。
        this.eventUnsubscribe = source.subscribe(function () {
          var next = typeof source.getSnapshot === 'function' ? source.getSnapshot() : null;
          self.onSessionEvents(next);
        });
        // 订阅后补读一次，覆盖「初始快照之后、订阅生效之前」到达的事件。
        if (typeof source.getSnapshot === 'function') this.onSessionEvents(source.getSnapshot());
        // 把去重依据记进诊断：宿主是否给 seq、窗口有多少条 —— 排查丢事件时先看这行。
        this.logEvent('tts', 'watching assistant messages (seq=' + (seqSeen ? 'yes' : 'no') + ', entries=' + this.lastEventCount + ')');
      } catch (error) {
        if (reference !== null) {
          try {
            reference.release();
          } catch (_error) {}
        }
        this.logEvent('tts', 'watch failed: ' + describeError(error));
      }
    };

    VoiceEngine.prototype.stopMessageWatch = function () {
      if (this.eventUnsubscribe !== null) {
        try {
          this.eventUnsubscribe();
        } catch (_error) {}
        this.eventUnsubscribe = null;
      }
      if (this.sessionRef !== null) {
        try {
          this.sessionRef.release();
        } catch (_error) {}
        this.sessionRef = null;
      }
      this.lastEventSeq = 0;
      this.lastEventCount = 0;
    };

    VoiceEngine.prototype.refreshTts = function () {
      if (!CONFIG.ttsEnabled) {
        this.stopMessageWatch();
        this.stopPlayback();
        return;
      }
      this.maybeWatchMessages();
    };

    // 消息监听该不该挂。
    // 运行中当然要挂；「未开麦时也播报」开着的时候，模式关着也要挂——
    // 否则连助手消息都收不到，口播稿根本没机会被念出来。
    VoiceEngine.prototype.maybeWatchMessages = function () {
      if (!CONFIG.ttsEnabled) {
        this.stopMessageWatch();
        return;
      }
      if (this.isActive() || CONFIG.ttsSpeakWhenIdle === true) {
        this.startMessageWatch(this.generation);
        return;
      }
      this.stopMessageWatch();
    };

    VoiceEngine.prototype.acquireLock = function () {
      var self = this;
      var name = 'voice-mode:mic';
      this.lockError = null;
      if (!navigator.locks || typeof navigator.locks.request !== 'function') {
        this.lockError = 'locks-unavailable';
        return Promise.resolve(true); // 非 Chromium：退化为假设单窗口
      }
      return new Promise(function (resolve) {
        var settled = false;
        var request = null;
        try {
          request = navigator.locks.request(name, { ifAvailable: true }, function (lock) {
            if (!lock) {
              settled = true;
              resolve(false);
              return undefined;
            }
            var hold = null;
            self.lockRelease = function () {
              self.lockRelease = null;
              if (hold !== null) {
                var release = hold;
                hold = null;
                release();
              }
            };
            if (!settled) {
              settled = true;
              resolve(true);
            }
            return new Promise(function (release) {
              hold = release;
            });
          });
        } catch (error) {
          self.lockError = describeError(error);
          settled = true;
          resolve(true); // 锁不可用不阻断：退化为单窗口假设
          return;
        }
        if (request && typeof request.catch === 'function') {
          request.catch(function (error) {
            self.lockError = describeError(error);
            if (!settled) {
              settled = true;
              resolve(true);
            }
          });
        }
      });
    };

    VoiceEngine.prototype.releaseLock = function () {
      var release = this.lockRelease;
      this.lockRelease = null;
      if (release !== null) release();
    };

    VoiceEngine.prototype.block = function (kind, reason, detail, options) {
      var sessionId = this.sessionId;
      if (sessionId !== null && !(options && options.keepEnabled)) this.enabled.delete(sessionId);
      this.generation += 1;
      this.clearIdle();
      this.maybeWatchMessages();
      this.teardownAudio();
      this.stopPlayback();
      this.releaseLock();
      this.steerArmed = false;
      this.interruptFlag = false;
      this.level = 0;
      var text = typeof detail === 'string' && detail !== '' ? detail : null;
      if (text !== null && typeof console !== 'undefined' && console.warn) {
        console.warn('[voice-mode] blocked: ' + kind + ' / ' + reason + ' / ' + text);
      }
      if (text !== null && typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        try {
          navigator.clipboard.writeText('voice-mode blocked (' + kind + '): ' + text).catch(function () {});
        } catch (_error) {}
      }
      this.detail = text;
      this.setState(STATE.BLOCKED, reason, kind, text);
    };

    VoiceEngine.prototype.arm = async function (options) {
      if (this.busy) {
        // 切换会话时上一个 arm 还没收尾：排队，等它结束后补一次。
        this.pendingArmOptions = options || {};
        return;
      }
      if (this.state !== STATE.OFF && this.state !== STATE.BLOCKED) return;
      if (this.sessionId === null) return;
      // 切换会话后旧回复可能还在播：保留它，不因重新开麦而掐断。
      this.bargeInRemainder = null;
      this.busy = true;
      var self = this;
      if (this.busyWatchdog !== null) clearTimeout(this.busyWatchdog);
      this.busyWatchdog = setTimeout(function () {
        self.busyWatchdog = null;
        if (self.busy !== true) return;
        self.logEvent('voice', 'busy watchdog: releasing a stuck arm');
        self.busy = false;
        var pending = self.pendingArmOptions;
        self.pendingArmOptions = null;
        if (pending !== null && self.sessionId !== null && self.enabled.get(self.sessionId) === true && (self.state === STATE.OFF || self.state === STATE.BLOCKED)) {
          self.arm(pending);
        }
      }, 8000);
      var generation = (this.generation += 1);
      this.setState(STATE.ARMING);
      try {
        // 切换会话时上一把锁的释放是异步的：短暂重试，别立刻判成“被别的窗口占用”。
        var locked = false;
        for (var lockAttempt = 0; lockAttempt < 5; lockAttempt += 1) {
          locked = await this.acquireLock();
          if (generation !== this.generation) return;
          if (locked) break;
          this.logEvent('voice', 'lock retry ' + (lockAttempt + 1) + ': ' + (this.lockError || 'busy'));
          this.releaseLock();
          await delay(120 + lockAttempt * 80);
          if (generation !== this.generation) return;
        }
        if (!locked) {
          // 保留 enabled，切回来或稍后重试还能自动恢复。
          this.block('locked', 'reason.locked', 'locks: ' + (this.lockError || 'held-by-another-window'), { keepEnabled: true });
          return;
        }
        if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
          this.block('audio', 'reason.audio', 'mediaDevices missing; secure=' + (window.isSecureContext === true) + '; origin=' + String(location.origin));
          return;
        }
        var stream = null;
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 }
          });
        } catch (error) {
          this.block('permission', 'reason.permission', 'getUserMedia ' + describeError(error));
          return;
        }
        if (generation !== this.generation) {
          stream.getTracks().forEach(function (track) {
            track.stop();
          });
          return;
        }
        this.stream = stream;
        var AudioCtor = window.AudioContext || window.webkitAudioContext;
        if (!AudioCtor) {
          this.block('audio', 'reason.audio', 'AudioContext missing');
          return;
        }
        this.audioCtx = new AudioCtor();
        if (this.audioCtx.state === 'suspended') await this.audioCtx.resume();
        if (generation !== this.generation) return;
        this.sampleRate = this.audioCtx.sampleRate || 48000;
        this.source = this.audioCtx.createMediaStreamSource(stream);

        var providerId = await this.ensureSpeechReady(generation);
        if (generation !== this.generation) return;
        if (providerId === null) return; // ensureSpeechReady 已 block

        this.startAudioPipeline();
        this.enabled.set(this.sessionId, true);
        this.failures = 0;
        this.lastSubmitAt = 0;
        this.voiceRun = 0;
        this.resetIdle();
        this.setState(STATE.LISTENING);
        this.startMessageWatch(generation);
        this.probeTtsRoute();
        if (options && options.restored) this.showNotice('notice.restored', 'ok');
      } catch (error) {
        if (generation === this.generation) this.block('runtime', 'reason.runtime', 'arm ' + describeError(error));
      } finally {
        this.busy = false;
        if (this.busyWatchdog !== null) {
          clearTimeout(this.busyWatchdog);
          this.busyWatchdog = null;
        }
        var pending = this.pendingArmOptions;
        this.pendingArmOptions = null;
        if (
          pending !== null &&
          this.sessionId !== null &&
          this.enabled.get(this.sessionId) === true &&
          (this.state === STATE.OFF || this.state === STATE.BLOCKED)
        ) {
          var self = this;
          setTimeout(function () {
            self.arm(pending);
          }, 0);
        }
      }
    };

    VoiceEngine.prototype.ensureSpeechReady = async function (generation) {
      var remote = this.ctx.remote;
      if (!remote || !remote.speech) {
        this.block('runtime', 'reason.runtime', 'remote.speech missing');
        return null;
      }
      var catalog = null;
      try {
        catalog = await remote.speech.catalog();
      } catch (error) {
        var message = describeError(error);
        if (/definition-unavailable|withdrawn|typert gateway/i.test(message)) {
          // 典型原因：内置语音输入 bundle 被关掉，Host 的 speech 行没挂载。
          this.block('prepare', 'reason.prepare', '语音输入 bundle 未启用：' + message);
        } else {
          this.block('runtime', 'reason.runtime', 'catalog ' + message);
        }
        return null;
      }
      if (generation !== this.generation) return null;
      if (!catalog || !catalog.ok) {
        var rejected = describeError(catalog && catalog.error);
        if (/definition-unavailable|withdrawn|typert gateway/i.test(rejected)) {
          this.block('prepare', 'reason.prepare', '语音输入 bundle 未启用：' + rejected);
        } else {
          this.block('runtime', 'reason.runtime', 'catalog rejected: ' + rejected);
        }
        return null;
      }
      var value = catalog.value;
      var providers = (value && value.providers) || [];
      var selection = (value && value.selection) || null;
      var provider = null;
      if (selection) {
        provider = providers.filter(function (item) {
          return item.id === selection.providerId;
        })[0] || null;
      }
      if (!provider) provider = providers[0] || null;
      if (!provider) {
        this.block('prepare', 'reason.prepare', 'no speech provider registered');
        return null;
      }
      var phase = provider.preparation && provider.preparation.phase;
      if (phase === 'ready' || phase === 'standby') return provider.id;
      if (phase === 'failed') {
        this.block('prepare', 'reason.prepare', 'prepare failed: ' + String((provider.preparation && provider.preparation.message) || provider.id));
        return null;
      }
      var prepared = null;
      try {
        prepared = await remote.speech.prepare(provider.id);
      } catch (error) {
        this.block('prepare', 'reason.prepare', 'prepare ' + describeError(error));
        return null;
      }
      if (generation !== this.generation) return null;
      if (!prepared || !prepared.ok) {
        this.block('prepare', 'reason.prepare', 'prepare rejected: ' + describeError(prepared && prepared.error));
        return null;
      }
      var ready = await this.waitReady(provider.id, generation);
      if (generation !== this.generation) return null;
      if (!ready) {
        this.block('prepare', 'reason.prepare', 'prepare timeout (' + CONFIG.armTimeoutMs + 'ms) for ' + provider.id);
        return null;
      }
      return provider.id;
    };

    VoiceEngine.prototype.waitReady = async function (providerId, generation) {
      var deadline = now() + CONFIG.armTimeoutMs;
      while (now() < deadline) {
        if (generation !== this.generation) return false;
        var catalog = null;
        try {
          catalog = await this.ctx.remote.speech.catalog();
        } catch (_error) {
          catalog = null;
        }
        if (catalog && catalog.ok && catalog.value) {
          var providers = catalog.value.providers || [];
          var provider = providers.filter(function (item) {
            return item.id === providerId;
          })[0];
          if (provider && provider.preparation) {
            var phase = provider.preparation.phase;
            if (phase === 'ready' || phase === 'standby') return true;
            if (phase === 'failed') return false;
          }
        }
        await new Promise(function (resolve) {
          setTimeout(resolve, 500);
        });
      }
      return false;
    };

    // ── 采集：ScriptProcessorNode 直接取 PCM ──
    VoiceEngine.prototype.startAudioPipeline = function () {
      var self = this;
      var processor = this.audioCtx.createScriptProcessor(CONFIG.frameSize, 1, 1);
      var mute = this.audioCtx.createGain();
      mute.gain.value = 0;
      this.source.connect(processor);
      processor.connect(mute);
      mute.connect(this.audioCtx.destination);
      processor.onaudioprocess = function (event) {
        self.onAudioFrame(event.inputBuffer.getChannelData(0));
      };
      this.processor = processor;
      this.muteGain = mute;
      this.pcmChunks = [];
      this.totalSamples = 0;
      this.lastFrameAt = now();
      this.startWatchdog();
    };

    // 看门狗：AudioContext 被挂起就 resume；音频回调停 >3s 就重建处理链（自愈 + 留痕）。
    VoiceEngine.prototype.startWatchdog = function () {
      var self = this;
      if (this.watchdogTimer !== null) return;
      this.watchdogTimer = setInterval(function () {
        if (self.state === STATE.OFF || self.state === STATE.BLOCKED) return;
        if (self.audioCtx === null) return;
        if (self.audioCtx.state === 'suspended') {
          self.logEvent('watchdog', 'audio context suspended; resuming');
          try {
            self.audioCtx.resume();
          } catch (_error) {}
        }
        if (self.lastFrameAt !== 0 && now() - self.lastFrameAt > 3000) {
          self.logEvent('watchdog', 'no audio frames >3s; restarting pipeline');
          self.restartAudio();
        }
      }, 1500);
    };

    VoiceEngine.prototype.stopWatchdog = function () {
      if (this.watchdogTimer !== null) {
        clearInterval(this.watchdogTimer);
        this.watchdogTimer = null;
      }
    };

    VoiceEngine.prototype.restartAudio = function () {
      if (this.audioCtx === null || this.source === null) return;
      if (this.processor !== null) {
        try {
          this.processor.onaudioprocess = null;
          this.processor.disconnect();
        } catch (_error) {}
        this.processor = null;
      }
      if (this.muteGain !== null) {
        try {
          this.muteGain.disconnect();
        } catch (_error) {}
        this.muteGain = null;
      }
      this.pcmChunks = [];
      this.totalSamples = 0;
      this.startAudioPipeline();
      this.lastFrameAt = now();
    };

    VoiceEngine.prototype.preRollSamples = function () {
      return Math.round((CONFIG.preRollMs * this.sampleRate) / 1000);
    };

    VoiceEngine.prototype.speechSamples = function () {
      return Math.round((CONFIG.minSpeechMs * this.sampleRate) / 1000);
    };

    VoiceEngine.prototype.onAudioFrame = function (input) {
      if (this.state === STATE.OFF || this.state === STATE.BLOCKED) return;
      this.lastFrameAt = now();
      var samples = new Float32Array(input.length);
      samples.set(input);
      var sum = 0;
      for (var index = 0; index < samples.length; index += 1) {
        sum += samples[index] * samples[index];
      }
      var rms = Math.sqrt(sum / samples.length);
      this.level = rms;
      var frameMs = (samples.length / this.sampleRate) * 1000;
      var start = this.totalSamples;
      this.totalSamples += samples.length;
      this.pcmChunks.push({ data: samples, start: start });
      var time = now();
      // 播报期间：默认只听不录（suppress）；开了 barge-in 才允许用说话打断。
      if (this.speaking && CONFIG.ttsBargeIn !== true) {
        this.voiceRun = 0;
        this.prunePcm();
        this.publish();
        return;
      }
      if (this.suppressUntil !== 0 && time < this.suppressUntil) {
        this.voiceRun = 0;
        this.prunePcm();
        this.publish();
        return;
      }
      if (this.state === STATE.LISTENING) {
        var cooling = this.lastSubmitAt !== 0 && time - this.lastSubmitAt < CONFIG.cooldownMs;
        if (!cooling && rms > CONFIG.energyThreshold) {
          this.voiceRun += frameMs;
          if (this.voiceRun >= CONFIG.minSpeechMs) this.beginCapture();
        } else {
          this.voiceRun = 0;
        }
      } else if (this.state === STATE.CAPTURING) {
        if (rms > CONFIG.energyThreshold) {
          this.lastVoiceAt = time;
        } else if (time - this.lastVoiceAt >= CONFIG.silenceMs) {
          this.finishCapture();
          return;
        }
        if (time - this.captureStartAt >= CONFIG.maxSeconds * 1000) {
          this.finishCapture();
          return;
        }
      }
      this.prunePcm();
      if (this.state !== STATE.TRANSCRIBING && this.state !== STATE.SUBMITTING) this.publish();
    };

    VoiceEngine.prototype.prunePcm = function () {
      var keepFrom = this.totalSamples - this.preRollSamples();
      if (this.state === STATE.CAPTURING) keepFrom = this.captureFrom;
      while (this.pcmChunks.length > 0 && this.pcmChunks[0].start + this.pcmChunks[0].data.length < keepFrom) {
        this.pcmChunks.shift();
      }
    };

    VoiceEngine.prototype.beginCapture = function () {
      if (this.state !== STATE.LISTENING) return;
      if (this.speaking) {
        if (CONFIG.ttsBargeIn === true) {
          this.bargeInRemainder = this.speaker.remainingText();
          this.logEvent('tts', 'barge-in: paused with ' + String(this.bargeInRemainder.length) + ' chars left');
        }
        this.stopPlayback(CONFIG.ttsBargeIn === true);
      }
      this.captureFrom = Math.max(0, this.totalSamples - this.preRollSamples() - this.speechSamples());
      this.captureStartAt = now() - CONFIG.minSpeechMs;
      this.lastVoiceAt = now();
      this.voiceRun = 0;
      this.interruptFlag = this.steerArmed;
      this.resetIdle();
      this.logEvent('capture', 'triggered');
      this.setState(STATE.CAPTURING);
    };

    VoiceEngine.prototype.collectSamples = function () {
      var from = this.captureFrom;
      var parts = [];
      var total = 0;
      for (var index = 0; index < this.pcmChunks.length; index += 1) {
        var chunk = this.pcmChunks[index];
        var end = chunk.start + chunk.data.length;
        if (end <= from) continue;
        var skip = Math.max(0, from - chunk.start);
        var slice = skip === 0 ? chunk.data : chunk.data.subarray(skip);
        parts.push(slice);
        total += slice.length;
      }
      var merged = new Float32Array(total);
      var offset = 0;
      for (var part = 0; part < parts.length; part += 1) {
        merged.set(parts[part], offset);
        offset += parts[part].length;
      }
      this.pcmChunks = [];
      return merged;
    };

    VoiceEngine.prototype.finishCapture = async function () {
      if (this.state !== STATE.CAPTURING) return;
      var generation = this.generation;
      this.setState(STATE.TRANSCRIBING);
      var samples = this.collectSamples();
      if (samples.length === 0) {
        if (this.bargeInRemainder !== null) {
          this.ignoredBargeIn('no samples');
          return;
        }
        this.handleFailure('reason.decode', 'no samples');
        return;
      }
      var audioBase64 = null;
      try {
        audioBase64 = await this.encodeWavBase64(samples, this.sampleRate);
      } catch (error) {
        this.handleFailure('reason.decode', 'encode ' + describeError(error));
        return;
      }
      if (generation !== this.generation) return;
      var result = null;
      try {
        result = await this.ctx.remote.speech.transcribe({ audioBase64: audioBase64 }, undefined);
      } catch (error) {
        result = { ok: false, error: error };
      }
      if (generation !== this.generation) return;
      if (!result || !result.ok) {
        if (this.bargeInRemainder !== null) {
          this.ignoredBargeIn('transcribe rejected: ' + describeError(result && result.error));
          return;
        }
        this.handleFailure('reason.runtime', 'transcribe rejected: ' + describeError(result && result.error));
        return;
      }
      var durationMs = Math.round((samples.length / this.sampleRate) * 1000);
      var text = ((result.value && result.value.text) || '').trim();
      if (text === '') {
        if (this.bargeInRemainder !== null) {
          this.ignoredBargeIn('empty transcript');
          return;
        }
        this.ignoreNoise('empty transcript (' + durationMs + 'ms audio)');
        return;
      }
      if (!this.passTextGate(text)) {
        if (this.bargeInRemainder !== null) {
          this.ignoredBargeIn('gate rejected: ' + text);
          return;
        }
        this.ignoreNoise('gate rejected: ' + text);
        return;
      }
      this.logEvent('transcribed', text.length + ' chars, ' + durationMs + 'ms audio');
      this.failures = 0;
      this.bargeInRemainder = null;
      var submitted = await this.submitText(text, generation);
      if (generation !== this.generation) return;
      this.interruptFlag = false;
      if (submitted) this.showNotice('notice.sent', 'ok');
      this.resumeListening();
    };

    // 噪声黑名单（2026-11-07 实测补充）：
    //   · 多语模型会把含糊的环境音凑成英文虚词 —— 实测出现过 Okay / Yeah / Thank / The / Go
    //   · 也会凑成日文假名 —— 实测出现过 よね / きや
    //   · 但用户会说日语短句（ありがとう 等），所以假名只在「整句纯假名且很短」时才丢。
    // 判据：整句去掉标点后，要么命中拉丁虚词表，要么是 ≤4 个假名的纯假名词，要么是 ≤3 个字母的零碎。
    var GATE_LATIN_STOPWORDS = /^(ok|okay|k|kk|oh|ah|eh|uh|um|hmm|hm|mm|mmm|yeah|yea|yep|yes|yup|nah|no|nope|thank|thanks|thx|the|go|wow|well|so|and|but|hi|hey|hello|bye|good|god|my|me|it|is|are|was|am|do|did|not|you|we|us)$/i;
    var GATE_KANA_SHORT = /^[\u3040-\u309F\u30A0-\u30FF]{2,4}$/;

    VoiceEngine.prototype.passTextGate = function (text) {
      if (typeof text !== 'string') return false;
      var trimmed = text.trim();
      // 去掉标点/空白再判断：识别器常把咳嗽识别成 "哎。"，标点会让下面的语气词过滤失效。
      var cleaned = trimmed.replace(/[\s\p{P}\p{S}]/gu, '');
      if (cleaned === '') return false;
      if (cleaned.length < CONFIG.minChars) return false;
      // 假名：只在「整句纯假名且 ≤4 个」时才丢（よね / きや）。ありがとう 这种正常短句放行。
      if (GATE_KANA_SHORT.test(cleaned)) return false;
      // 拉丁虚词 + 零星假名的混合噪声：Yeahう / Okayう / OKです。
      // 识别器在噪声上常吐这种混合串，假名剥掉后只剩一个短虚词，就是噪声。
      var withoutKana = cleaned.replace(/[\u3040-\u309F\u30A0-\u30FF]/g, '');
      if (withoutKana !== cleaned && /^[A-Za-z]+$/.test(withoutKana)) {
        if (withoutKana.length <= 4 || GATE_LATIN_STOPWORDS.test(withoutKana)) return false;
      }
      // 重复虚词：go go / yeah yeah 去空格后是 gogo / yeahyeah，也算噪声。
      var repeatedLatin = cleaned.match(/^([A-Za-z]{2,6})\1+$/i);
      if (repeatedLatin !== null && GATE_LATIN_STOPWORDS.test(repeatedLatin[1])) return false;
      // 单字重复三次以上：对对对 / 哈哈哈 / 嗯嗯嗯
      if (/^(.)\1{2,}$/u.test(cleaned)) return false;
      // 纯拉丁字母：命中虚词表，或短于 4 个字母的零碎，都丢。
      if (/^[A-Za-z]+$/.test(cleaned)) {
        if (GATE_LATIN_STOPWORDS.test(cleaned)) return false;
        if (cleaned.length <= 3) return false;
      }
      if (/^[嗯啊哦呃额唔诶唉哎哈嘿呵好的是吧呀哇噢喔啦咦哟嘛呐呣哼嘻]+$/u.test(cleaned)) return false;
      return true;
    };

    VoiceEngine.prototype.resumeBargeIn = function () {
      if (this.bargeInRemainder === null) return false;
      var remainder = this.bargeInRemainder;
      this.bargeInRemainder = null;
      if (remainder === '') return false;
      this.logEvent('tts', 'barge-in was noise or filler; resuming playback');
      this.showNotice('notice.resumed', 'ok');
      this.speaker.append(remainder);
      return true;
    };

    // 空转写/纯语气词是噪声的常态结果，不能计入失败次数，否则几分钟就把模式锁死。
    VoiceEngine.prototype.ignoreNoise = function (detail) {
      this.logEvent('voice', 'ignored as noise: ' + detail);
      this.resumeListening();
    };

    VoiceEngine.prototype.ignoredBargeIn = function (detail) {
      this.logEvent('voice', 'barge-in ignored: ' + detail);
      this.failures = 0;
      this.resumeBargeIn();
      this.resumeListening();
    };

    VoiceEngine.prototype.handleFailure = function (reasonKey, detail) {
      this.failures += 1;
      var text = detail || reasonKey;
      this.logEvent('failure ' + this.failures + '/' + CONFIG.maxFailures, text);
      this.showNotice(text, 'err');
      if (this.failures >= CONFIG.maxFailures) {
        this.block('failures', 'reason.failures', text);
        return;
      }
      this.resumeListening();
    };

    VoiceEngine.prototype.submitText = async function (text, generation) {
      var reference = null;
      this.setState(STATE.SUBMITTING);
      try {
        reference = this.ctx.sessions.retain(this.sessionId, { source: 'voiceMode' });
        var binding = await reference.ready;
        if (generation !== this.generation) return false;
        var session = binding.session;
        var snapshot = typeof session.getSnapshot === 'function' ? session.getSnapshot() : null;
        var running = !!(snapshot && snapshot.running);
        var mode = running && this.interruptFlag ? 'steer' : 'queue';
        var marked = voiceMarker + text;
        var submission = session.beginSubmission({ mode: mode, text: marked, attachments: [], onRetire: function () {} });
        var result = null;
        try {
          result = await session.prompt([{ type: 'text', text: marked }], mode, undefined, submission.requestId);
        } catch (error) {
          result = { ok: false, error: error };
        }
        if (!result || !result.ok) {
          try {
            submission.abandon();
          } catch (_error) {}
          var message = 'submit rejected: ' + describeError(result && result.error);
          if (typeof console !== 'undefined' && console.warn) console.warn('[voice-mode] ' + message);
          this.showNotice(message, 'err');
          this.failures += 1;
          return false;
        }
        this.lastSubmitAt = now();
        this.steerArmed = false;
        this.logEvent('submit ok', mode + ', ' + marked.length + ' chars');
        this.publish();
        return true;
      } catch (error) {
        var text2 = 'submit ' + describeError(error);
        this.logEvent('submit failed', text2);
        this.showNotice(text2, 'err');
        this.failures += 1;
        return false;
      } finally {
        if (reference !== null) {
          try {
            reference.release();
          } catch (_error) {}
        }
      }
    };

    VoiceEngine.prototype.resumeListening = function () {
      if (this.state === STATE.OFF || this.state === STATE.BLOCKED) return;
      this.voiceRun = 0;
      this.pcmChunks = [];
      this.totalSamples = 0;
      this.setState(STATE.LISTENING);
      if (this.pendingSpeeches.length > 0) {
        var pending = this.pendingSpeeches;
        this.pendingSpeeches = [];
        for (var index = 0; index < pending.length; index += 1) this.queueSpeech(pending[index]);
      }
    };

    VoiceEngine.prototype.encodeWavBase64 = async function (samples, sourceRate) {
      var targetRate = 16000;
      var channel = null;
      if (sourceRate === targetRate) {
        channel = samples;
      } else {
        var buffer = this.audioCtx.createBuffer(1, samples.length, sourceRate);
        buffer.copyToChannel(samples, 0);
        var frames = Math.max(1, Math.ceil((samples.length / sourceRate) * targetRate));
        var offline = new OfflineAudioContext(1, frames, targetRate);
        var source = offline.createBufferSource();
        source.buffer = buffer;
        source.connect(offline.destination);
        source.start(0);
        var rendered = await offline.startRendering();
        channel = rendered.getChannelData(0);
      }
      var bytes = new Uint8Array(44 + channel.length * 2);
      var view = new DataView(bytes.buffer);
      writeAscii(view, 0, 'RIFF');
      view.setUint32(4, 36 + channel.length * 2, true);
      writeAscii(view, 8, 'WAVE');
      writeAscii(view, 12, 'fmt ');
      view.setUint32(16, 16, true);
      view.setUint16(20, 1, true);
      view.setUint16(22, 1, true);
      view.setUint32(24, targetRate, true);
      view.setUint32(28, targetRate * 2, true);
      view.setUint16(32, 2, true);
      view.setUint16(34, 16, true);
      writeAscii(view, 36, 'data');
      view.setUint32(40, channel.length * 2, true);
      var offset = 44;
      for (var index = 0; index < channel.length; index += 1) {
        var sample = Math.max(-1, Math.min(1, channel[index]));
        view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
        offset += 2;
      }
      return bytesToBase64(bytes);
    };

    function writeAscii(view, offset, text) {
      for (var index = 0; index < text.length; index += 1) {
        view.setUint8(offset + index, text.charCodeAt(index));
      }
    }

    function bytesToBase64(bytes) {
      var chunkSize = 0x8000;
      var pieces = [];
      for (var index = 0; index < bytes.length; index += chunkSize) {
        var slice = bytes.subarray(index, Math.min(index + chunkSize, bytes.length));
        pieces.push(String.fromCharCode.apply(null, slice));
      }
      return btoa(pieces.join(''));
    }

    VoiceEngine.prototype.resetIdle = function () {
      var self = this;
      this.clearIdle();
      if (this.state === STATE.OFF || this.state === STATE.BLOCKED) return;
      var minutes = CONFIG.idleExitMs > 0 ? Math.round(CONFIG.idleExitMs / 60000) : 0;
      if (this.lastIdleMinutes !== minutes) {
        this.lastIdleMinutes = minutes;
        this.logEvent('idle', minutes > 0 ? 'auto exit after ' + minutes + ' min of silence' : 'idle exit disabled (0 min)');
      }
      // 0 = 不自动退出，只保留手动关与 hidden/失焦/切会话/刷新。
      if (CONFIG.idleExitMs <= 0) return;
      this.idleTimer = setTimeout(function () {
        self.idleTimer = null;
        self.shutdown('idle');
      }, CONFIG.idleExitMs);
    };

    VoiceEngine.prototype.clearIdle = function () {
      if (this.idleTimer !== null) {
        clearTimeout(this.idleTimer);
        this.idleTimer = null;
      }
    };

    VoiceEngine.prototype.dispose = function () {
      var sessionId = this.sessionId;
      this.generation += 1;
      this.clearIdle();
      this.stopMessageWatch();
      this.teardownAudio();
      this.stopPlayback();
      this.releaseLock();
      if (sessionId !== null) {
        this.enabled.delete(sessionId);
        this.sessionId = null;
      }
      if (this.noticeTimer !== null) {
        clearTimeout(this.noticeTimer);
        this.noticeTimer = null;
      }
      this.state = STATE.OFF;
      this.level = 0;
      this.publish();
    };

    // ── UI：顶栏右侧的开关 + 采集指示 ──
    function useEngineSnapshot(engine) {
      if (typeof React.useSyncExternalStore === 'function') {
        return React.useSyncExternalStore(engine.subscribe, engine.getSnapshot);
      }
      var pair = React.useState(engine.getSnapshot());
      React.useEffect(function () {
        return engine.subscribe(pair[1]);
      }, [engine]);
      return pair[0];
    }

    var COLOR = {
      OFF: '#8b8f96',
      ARMING: '#d4a017',
      LISTENING: '#2f9e44',
      CAPTURING: '#0c8599',
      TRANSCRIBING: '#f08c00',
      SUBMITTING: '#7048e8',
      BLOCKED: '#868e96'
    };

    function VoiceToggle(props) {
      var engine = props.engine;
      var t = props.t;
      var snapshot = useEngineSnapshot(engine);
      var sessionId = props.sessionId;
      var pressTimer = React.useRef(null);
      var longFired = React.useRef(false);

      React.useEffect(function () {
        engine.attach(sessionId);
        return function () {
          engine.detach(sessionId);
        };
      }, [engine, sessionId]);

      function clearPress() {
        if (pressTimer.current !== null) {
          clearTimeout(pressTimer.current);
          pressTimer.current = null;
        }
      }

      function onPointerDown(event) {
        if (event.button !== undefined && event.button !== 0) return;
        longFired.current = false;
        clearPress();
        pressTimer.current = setTimeout(function () {
          pressTimer.current = null;
          longFired.current = true;
          engine.markInterrupt();
        }, CONFIG.longPressMs);
      }

      function onPointerUp() {
        clearPress();
      }

      function onPointerCancel() {
        clearPress();
        longFired.current = false;
      }

      function onClick() {
        if (longFired.current) {
          longFired.current = false;
          return;
        }
        // 播报中：点击只停播，不关模式（Esc 同优先级）。
        if (snapshot.speaking) {
          engine.stopPlayback();
          return;
        }
        engine.toggleOrRetry();
      }

      var state = snapshot.state;
      var active = state !== STATE.OFF && state !== STATE.BLOCKED;
      var label = '';
      if (state === STATE.OFF) label = t('toggle.off');
      else if (state === STATE.ARMING) label = t('toggle.arming');
      else if (state === STATE.LISTENING) label = t('toggle.listening');
      else if (state === STATE.CAPTURING) label = t('toggle.capturing');
      else if (state === STATE.TRANSCRIBING) label = t('toggle.transcribing');
      else if (state === STATE.SUBMITTING) label = t('toggle.submitting');
      else label = t('toggle.blocked') + (snapshot.reason ? ': ' + t(snapshot.reason) : '');
      if (snapshot.steerArmed) label = t('toggle.steerArmed');
      if (state === STATE.BLOCKED && snapshot.detail) label = label + ' — ' + String(snapshot.detail);
      var color = COLOR[state] || COLOR.OFF;
      var level = snapshot.level || 0;
      var levelWidth = Math.max(0, Math.min(1, level * 8)) * 30;
      var chipKey = snapshot.speaking ? 'chip.SPEAKING' : 'chip.' + state;
      var chipText = t(chipKey);
      if (snapshot.speaking) label = t('toggle.speaking');

      var children = [
        React.createElement('span', {
          key: 'dot',
          style: {
            width: 9,
            height: 9,
            borderRadius: '50%',
            background: snapshot.steerArmed ? '#d4a017' : color,
            display: 'inline-block',
            flex: '0 0 auto'
          }
        }),
        React.createElement(
          'span',
          {
            key: 'chip',
            style: {
              display: 'inline-block',
              flex: '0 0 auto',
              fontSize: 12,
              color: active ? 'inherit' : '#8b8f96',
              whiteSpace: 'nowrap'
            }
          },
          chipText && chipText !== chipKey ? chipText : ''
        ),
        React.createElement(
          'span',
          {
            key: 'level',
            style: {
              width: 30,
              height: 4,
              borderRadius: 2,
              background: 'rgba(127,127,127,0.25)',
              display: 'inline-block',
              overflow: 'hidden',
              flex: '0 0 auto'
            }
          },
          active
            ? React.createElement('span', {
                style: {
                  display: 'block',
                  height: '100%',
                  width: levelWidth,
                  background: color,
                  transition: 'width 80ms linear'
                }
              })
            : null
        )
      ];

      if (snapshot.notice) {
        children.push(
          React.createElement(
            'span',
            {
              key: 'notice',
              style: {
                marginLeft: 4,
                fontSize: 10,
                color: snapshot.noticeTone === 'err' ? '#e03131' : '#2f9e44',
                maxWidth: 320,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap'
              }
            },
            t(snapshot.notice)
          )
        );
      }

      if (state === STATE.BLOCKED && snapshot.detail) {
        children.push(
          React.createElement(
            'span',
            {
              key: 'detail',
              style: {
                marginLeft: 4,
                fontSize: 10,
                color: '#e03131',
                maxWidth: 260,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap'
              }
            },
            String(snapshot.detail)
          )
        );
      }

      return React.createElement(
        'button',
        {
          type: 'button',
          className: 'vm-mic',
          title: label,
          'aria-label': label,
          'aria-pressed': active,
          onPointerDown: onPointerDown,
          onPointerUp: onPointerUp,
          onPointerCancel: onPointerCancel,
          onPointerLeave: onPointerUp,
          onClick: onClick,
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: 7,
            padding: '6px 11px',
            minHeight: 28,
            borderRadius: 8,
            border: '1px solid rgba(127,127,127,0.28)',
            background: 'transparent',
            color: 'inherit',
            cursor: 'pointer',
            font: 'inherit',
            lineHeight: 1,
            touchAction: 'none',
            userSelect: 'none'
          }
        },
        children
      );
    }

    // ── 输入框旁的语音主按钮：纯图标 + 状态动效 ──
    var MIC_ANIM_CSS = [
      '@keyframes vm-glow { 0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--vm-color) 40%, transparent) } 70% { box-shadow: 0 0 0 6px color-mix(in srgb, var(--vm-color) 0%, transparent) } 100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--vm-color) 0%, transparent) } }',
      '@keyframes vm-glow-loud { 0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--vm-color) 55%, transparent) } 100% { box-shadow: 0 0 0 calc(4px + var(--vm-level, 0) * 10px) color-mix(in srgb, var(--vm-color) 0%, transparent) } }',
      '@keyframes vm-dot { 0%, 100% { opacity: .35; transform: scale(.85) } 50% { opacity: 1; transform: scale(1.1) } }',
      '@keyframes vm-dots { 0%, 80%, 100% { opacity: .18; transform: translateY(0) } 40% { opacity: 1; transform: translateY(-1.5px) } }',
      '.vm-mic:focus { outline: none }',
      '.vm-mic:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px }',
      '@media (prefers-reduced-motion: reduce) { .vm-mic, .vm-dot { animation: none !important } }'
    ].join('\n');

    var MIC_RING = {
      position: 'absolute',
      left: '50%',
      top: '50%',
      width: 38,
      height: 38,
      borderRadius: '50%',
      boxSizing: 'border-box',
      transform: 'translate(-50%, -50%)',
      border: '1.5px solid',
      pointerEvents: 'none',
      display: 'block'
    };

    function VoiceMicIcon(props) {
      var engine = props.engine;
      var t = props.t;
      var snapshot = useEngineSnapshot(engine);
      var sessionId = props.sessionId;
      var pressTimer = React.useRef(null);
      var longFired = React.useRef(false);

      React.useEffect(function () {
        engine.attach(sessionId);
        return function () {
          engine.detach(sessionId);
        };
      }, [engine, sessionId]);

      function clearPress() {
        if (pressTimer.current !== null) {
          clearTimeout(pressTimer.current);
          pressTimer.current = null;
        }
      }

      function onPointerDown(event) {
        if (event.button !== undefined && event.button !== 0) return;
        longFired.current = false;
        clearPress();
        pressTimer.current = setTimeout(function () {
          pressTimer.current = null;
          longFired.current = true;
          engine.markInterrupt();
        }, CONFIG.longPressMs);
      }

      function onClick() {
        if (longFired.current) {
          longFired.current = false;
          return;
        }
        if (snapshot.speaking) {
          engine.stopPlayback();
          return;
        }
        engine.toggleOrRetry();
      }

      var state = snapshot.state;
      var active = state !== STATE.OFF && state !== STATE.BLOCKED;
      var color = COLOR[state] || COLOR.OFF;
      var capturing = state === STATE.CAPTURING;
      var listening = state === STATE.LISTENING || state === STATE.ARMING;
      var busy = state === STATE.TRANSCRIBING || state === STATE.SUBMITTING;
      var speaking = snapshot.speaking;
      var level = Math.max(0, Math.min(1, snapshot.level || 0));
      var energy = Math.min(1, level * 6);

      var label = speaking ? t('toggle.speaking') : capturing ? t('toggle.capturing') : active ? t('toggle.listening') : t('toggle.off');
      if (state === STATE.BLOCKED) label = t('toggle.blocked') + (snapshot.reason ? ': ' + t(snapshot.reason) : '');

      var rings = [];

      var glyph = null;
      if (busy) {
        var dots = [];
        for (var dotIndex = 0; dotIndex < 3; dotIndex += 1) {
          dots.push(
            React.createElement('span', {
              key: 'dot-' + dotIndex,
              style: {
                width: 3,
                height: 3,
                borderRadius: '50%',
                background: 'currentColor',
                display: 'inline-block',
                animation: 'vm-dots 1.1s ease-in-out infinite',
                animationDelay: dotIndex * 0.16 + 's'
              }
            })
          );
        }
        glyph = React.createElement('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 2.5 } }, dots);
      } else if (speaking) {
        glyph = React.createElement(
          'svg',
          { viewBox: '0 0 24 24', width: 14, height: 14, fill: 'none', stroke: 'currentColor', strokeWidth: 2 },
          React.createElement('rect', { x: 7, y: 7, width: 10, height: 10, rx: 2, fill: 'currentColor', stroke: 'none' })
        );
      } else if (capturing) {
        var bars = [];
        var nowMs = Date.now();
        for (var barIndex = 0; barIndex < 4; barIndex += 1) {
          var wave = Math.max(0, Math.sin(nowMs / 95 + barIndex * 1.6));
          var barHeight = 5 + energy * 11 * (0.4 + 0.6 * wave);
          bars.push(
            React.createElement('span', {
              key: 'bar-' + barIndex,
              style: {
                width: 3,
                height: Math.round(barHeight),
                borderRadius: 1.5,
                background: 'currentColor',
                display: 'inline-block',
                transition: 'height 90ms linear',
                opacity: 0.65 + 0.35 * energy
              }
            })
          );
        }
        glyph = React.createElement(
          'span',
          { style: { display: 'inline-flex', alignItems: 'flex-end', justifyContent: 'center', gap: 2, height: 16 } },
          bars
        );
      } else {
        glyph = React.createElement(
          'svg',
          {
            viewBox: '0 0 24 24',
            width: 16,
            height: 16,
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: 2,
            strokeLinecap: 'round',
            strokeLinejoin: 'round'
          },
          React.createElement('rect', { x: 9, y: 2.5, width: 6, height: 11, rx: 3 }),
          React.createElement('path', { d: 'M5.5 11a6.5 6.5 0 0 0 13 0' }),
          React.createElement('line', { x1: 12, y1: 17.5, x2: 12, y2: 21 })
        );
      }

      return React.createElement(
        'button',
        {
          type: 'button',
          title: label,
          'aria-label': label,
          'aria-pressed': active,
          onPointerDown: onPointerDown,
          onPointerUp: clearPress,
          onPointerCancel: clearPress,
          onPointerLeave: clearPress,
          onClick: onClick,
          style: {
            position: 'relative',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 30,
            height: 30,
            padding: 0,
            borderRadius: 9,
            border: '1px solid ' + (active ? color : 'var(--dsw-alias-border-l2)'),
            background: active ? 'color-mix(in srgb, ' + color + ' 12%, transparent)' : 'transparent',
            color: active ? color : 'var(--dsw-alias-label-secondary)',
            cursor: 'pointer',
            touchAction: 'none',
            userSelect: 'none',
            transform: capturing ? 'scale(1.04)' : 'scale(1)',
            transition: 'transform 140ms ease, border-color 160ms ease, background 160ms ease',
            animation: active && !busy ? (capturing ? 'vm-glow-loud 1.05s' : 'vm-glow 2.6s') + ' ease-out infinite' : undefined,
            '--vm-color': color,
            '--vm-level': String(energy)
          }
        },
        rings,
        glyph
      );
    }

    // ── 侧栏会话行：开了语音模式的会话显示小绿点 ──
    function VoiceSessionDot(props) {
      var engine = props.engine;
      var t = props.t;
      useEngineSnapshot(engine);
      var sessionId = props.sessionId;
      if (sessionId === undefined || sessionId === null) return null;
      if (engine.enabled.get(sessionId) !== true) return null;
      var state = engine.state;
      var mine = engine.sessionId === sessionId;
      var active = mine && state !== STATE.OFF && state !== STATE.BLOCKED;
      var color = active ? (state === STATE.CAPTURING ? '#0c8599' : COLOR[state] || '#2f9e44') : '#2f9e44';
      return React.createElement(
        'span',
        {
          title: active ? t('sessionDot.active') : t('sessionDot.enabled'),
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 16,
            height: 16,
            color: color,
            opacity: active ? 1 : 0.5
          }
        },
        React.createElement(
          'svg',
          {
            viewBox: '0 0 24 24',
            width: 12,
            height: 12,
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: 2.2,
            strokeLinecap: 'round',
            strokeLinejoin: 'round'
          },
          React.createElement('rect', { x: 9, y: 2.5, width: 6, height: 11, rx: 3 }),
          React.createElement('path', { d: 'M5.5 11a6.5 6.5 0 0 0 13 0' }),
          React.createElement('line', { x1: 12, y1: 17.5, x2: 12, y2: 21 })
        )
      );
    }

    // ── 回退提示：Edge 不可用、改用系统语音时在界面里显式告知 ──
    function VoiceFallbackToast(props) {
      var engine = props.engine;
      var t = props.t;
      var snapshot = useEngineSnapshot(engine);
      var at = snapshot.ttsFallbackAt;
      React.useEffect(
        function () {
          if (!at) return undefined;
          var timer = setTimeout(function () {
            engine.clearTtsFallback();
          }, 20000);
          return function () {
            clearTimeout(timer);
          };
        },
        [at, engine]
      );
      if (!at) return null;
      return React.createElement(
        'div',
        {
          style: {
            position: 'fixed',
            left: 18,
            bottom: 90,
            zIndex: 60,
            maxWidth: 340,
            padding: '10px 12px',
            borderRadius: 10,
            border: '1px solid var(--dsw-alias-state-warn-primary)',
            background: 'var(--dsw-alias-bg-overlay)',
            color: 'var(--dsw-alias-label-primary)',
            boxShadow: '0 6px 24px rgba(0,0,0,0.18)',
            fontSize: 12,
            lineHeight: 1.5
          }
        },
        React.createElement(
          'div',
          { style: { fontWeight: 600, marginBottom: 2, color: 'var(--dsw-alias-state-warn-primary)' } },
          t('fallback.title')
        ),
        React.createElement('div', { style: { color: 'var(--dsw-alias-label-secondary)' } }, t('fallback.detail')),
        React.createElement(
          'button',
          {
            type: 'button',
            onClick: function () {
              engine.clearTtsFallback();
            },
            style: {
              marginTop: 6,
              padding: '3px 9px',
              borderRadius: 6,
              border: '1px solid var(--dsw-alias-border-l2)',
              background: 'transparent',
              color: 'var(--dsw-alias-label-primary)',
              cursor: 'pointer',
              font: 'inherit',
              fontSize: 11
            }
          },
          t('fallback.dismiss')
        )
      );
    }

    // ── 顶栏状态显示：只读，开关在输入框旁 ──
    function VoiceStatusChip(props) {
      var engine = props.engine;
      var t = props.t;
      var snapshot = useEngineSnapshot(engine);
      var state = snapshot.state;
      var color = COLOR[state] || COLOR.OFF;
      var chipKey = snapshot.speaking ? 'chip.SPEAKING' : 'chip.' + state;
      var text = t(chipKey);
      function onClick() {
        if (snapshot.speaking) engine.stopPlayback();
      }
      return React.createElement(
        'button',
        {
          type: 'button',
          title: t('toggle.statusHint'),
          'aria-label': t('toggle.statusHint') + ': ' + (text && text !== chipKey ? text : ''),
          onClick: onClick,
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '5px 9px',
            minHeight: 26,
            borderRadius: 999,
            border: '1px solid var(--dsw-alias-border-l1)',
            background: 'var(--dsw-alias-bg-layer-2)',
            color: 'var(--dsw-alias-label-secondary)',
            cursor: snapshot.speaking ? 'pointer' : 'default',
            font: 'inherit',
            lineHeight: 1,
            userSelect: 'none'
          }
        },
        React.createElement('span', {
          className: 'vm-dot',
          style: {
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: color,
            display: 'inline-block',
            flex: '0 0 auto',
            animation: state !== STATE.OFF ? 'vm-dot 1.8s ease-in-out infinite' : undefined
          }
        }),
        React.createElement(
          'span',
          { style: { fontSize: 12, whiteSpace: 'nowrap' } },
          text && text !== chipKey ? text : ''
        )
      );
    }

    // ── 朗读静音键：只控制“助手回复自动朗读”，工具 speak 不受影响 ──
    function VoiceTtsToggle(props) {
      var engine = props.engine;
      var t = props.t;
      var snapshot = useEngineSnapshot(engine);
      var enabled = snapshot.ttsEnabled === true;
      var label = enabled ? t('ttsToggle.on') : t('ttsToggle.off');
      function onClick() {
        var next = readVoiceConfig();
        next.ttsEnabled = CONFIG.ttsEnabled !== true;
        saveVoiceConfig(next);
        engine.refreshTts();
        engine.publish();
      }
      return React.createElement(
        'button',
        {
          type: 'button',
          title: label,
          'aria-label': label,
          'aria-pressed': enabled,
          onClick: onClick,
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5,
            padding: '6px 10px',
            minHeight: 28,
            borderRadius: 8,
            border: '1px solid rgba(127,127,127,0.28)',
            background: 'transparent',
            color: enabled ? 'inherit' : '#8b8f96',
            cursor: 'pointer',
            font: 'inherit',
            lineHeight: 1,
            touchAction: 'none',
            userSelect: 'none'
          }
        },
        React.createElement('span', { style: { fontSize: 12 } }, enabled ? t('ttsToggle.shortOn') : t('ttsToggle.shortOff'))
      );
    }

    // ── 设置页：语音聊天模式参数（settings.section） ──
    var SETTINGS_ROW = {
      display: 'grid',
      gridTemplateColumns: '190px 112px 40px',
      alignItems: 'center',
      gap: 10,
      padding: '7px 0',
      borderBottom: '1px solid var(--dsw-alias-border-l1)'
    };
    var SETTINGS_INPUT = {
      width: '100%',
      boxSizing: 'border-box',
      padding: '5px 8px',
      borderRadius: 8,
      border: '1px solid var(--dsw-alias-border-l1)',
      background: 'var(--dsw-alias-bg-layer-2)',
      color: 'var(--dsw-alias-label-primary)',
      font: 'inherit'
    };
    var CARD_STYLE = {
      background: 'var(--dsw-alias-bg-layer-1)',
      border: '1px solid var(--dsw-alias-border-l1)',
      borderRadius: 12,
      padding: '12px 16px 8px',
      marginBottom: 14
    };
    var CARD_TITLE = { margin: '0 0 2px', fontSize: 13, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' };
    var CARD_HINT = { margin: '0 0 6px', fontSize: 11, color: 'var(--dsw-alias-label-secondary)' };
    var SETTINGS_BUTTON = {
      padding: '5px 11px',
      borderRadius: 8,
      border: '1px solid var(--dsw-alias-border-l2)',
      background: 'var(--dsw-alias-bg-layer-1)',
      color: 'var(--dsw-alias-label-primary)',
      cursor: 'pointer',
      font: 'inherit'
    };

    function VoiceSettings(props) {
      var t = props.t;
      var pair = React.useState(function () {
        return readVoiceConfig();
      });
      var values = pair[0];
      var setValues = pair[1];
      var flashPair = React.useState(null);
      var flash = flashPair[0];
      var setFlash = flashPair[1];
      var forcePair = React.useState(0);
      var force = forcePair[1];

      React.useEffect(function () {
        if (!props.engine || typeof props.engine.subscribe !== 'function') return undefined;
        return props.engine.subscribe(function () {
          force(function (value) {
            return value + 1;
          });
        });
      }, [props.engine]);

      var diagLines = props.engine && typeof props.engine.getDiagnostics === 'function' ? props.engine.getDiagnostics() : [];

      function flashSaved() {
        setFlash(t('settings.saved'));
        setTimeout(function () {
          setFlash(null);
        }, 1200);
      }

      function copyValues() {
        var next = {};
        for (var key in values) {
          if (Object.prototype.hasOwnProperty.call(values, key)) next[key] = values[key];
        }
        return next;
      }

      function applyAndRefresh(next) {
        saveVoiceConfig(next);
        setValues(readVoiceConfig());
        // 让正在运行的引擎按新参数重排空闲计时（0 = 不自动退出时清掉旧计时器）。
        if (props.engine && typeof props.engine.resetIdle === 'function') props.engine.resetIdle();
        // TTS 开关/音色变化即时生效（关掉时停播并停止监听回复）。
        if (props.engine && typeof props.engine.refreshTts === 'function') props.engine.refreshTts();
        if (props.engine && typeof props.engine.publish === 'function') props.engine.publish();
        flashSaved();
      }

      function commitField(field, rawText) {
        if (rawText === '') return;
        var numeric = Number(rawText);
        if (!isFinite(numeric)) return;
        var stored = field.minutes ? Math.round(numeric) * 60000 : numeric;
        var next = copyValues();
        next[field.key] = normalizeStored(field, stored);
        applyAndRefresh(next);
      }

      function commitMarker(rawText) {
        var next = copyValues();
        next.marker = String(rawText).slice(0, 12);
        applyAndRefresh(next);
      }

      function resetAll() {
        applyAndRefresh(defaultsVoiceConfig());
      }

      function commitBoolean(field, checked) {
        var next = copyValues();
        next[field.key] = checked === true;
        applyAndRefresh(next);
      }

      function optionLabel(value) {
        var primary = 'option.' + value;
        var text = t(primary);
        if (text && text !== primary) return text;
        var secondary = 'tts.scope.' + value;
        var fallbackText = t(secondary);
        if (fallbackText && fallbackText !== secondary) return fallbackText;
        return value;
      }

      function engineVoices() {
        try {
          if (props.engine && props.engine.speaker && typeof props.engine.speaker.listVoices === 'function') return props.engine.speaker.listVoices();
          return window.speechSynthesis ? window.speechSynthesis.getVoices() || [] : [];
        } catch (_error) {
          return [];
        }
      }

      function commitOption(field, value) {
        var next = copyValues();
        next[field.key] = value;
        applyAndRefresh(next);
      }

      function commitVoice(name) {
        var next = copyValues();
        next.ttsVoice = String(name || '').slice(0, 120);
        applyAndRefresh(next);
      }

      function fieldByKey(key) {
        for (var index = 0; index < FIELDS.length; index += 1) {
          if (FIELDS[index].key === key) return FIELDS[index];
        }
        return null;
      }

      function inertFieldReason(field) {
        var key = field.key;
        if (key === 'blurExitMs' && values.listenWhileHidden !== true) return 'f.blurExitMs.disabledHint';
        if (key.indexOf('tts') !== 0 || key === 'ttsEnabled') return null;
        if (values.ttsEnabled !== true) return 'f.ttsEnabled.disabledHint';
        if (key !== 'ttsScope' && values.ttsScope === 'off') return 'f.ttsScope.disabledHint';
        var systemOnly = ['ttsRate', 'ttsPitch', 'ttsVolume', 'ttsVoice'];
        var edgeOnly = [
          'ttsEdgeVoice',
          'ttsEdgeRate',
          'ttsEdgePitch',
          'ttsEdgeVolume',
          'ttsEdgePrefetch',
          'ttsFallbackToSystem',
          'ttsEdgeTimeoutMs'
        ];
        if (values.ttsEngine === 'edge' && systemOnly.indexOf(key) >= 0) return 'f.ttsEngine.mismatchHint';
        if (values.ttsEngine === 'system' && edgeOnly.indexOf(key) >= 0) return 'f.ttsEngine.mismatchHint';
        if (key === 'ttsSkipOpener' && values.ttsScope !== 'head3') return 'f.ttsSkipOpener.disabledHint';
        if (key === 'ttsBargeIn' && values.ttsSuppressDuringSpeech !== true) return 'f.ttsBargeIn.disabledHint';
        return null;
      }

      function renderRow(field) {
        var inertReason = inertFieldReason(field);
        var inert = inertReason !== null;
        var dimControl = { opacity: 0.45, cursor: 'not-allowed' };
        var hintText = t('f.' + field.key + '.hint');
        var hintKey = 'f.' + field.key + '.hint';
        var hintNode =
          hintText && hintText !== hintKey
            ? React.createElement('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)', marginTop: 2 } }, hintText)
            : null;
        var labelNode = React.createElement(
          'span',
          { style: { color: inert ? 'var(--dsw-alias-label-secondary)' : 'var(--dsw-alias-label-primary)' } },
          t('f.' + field.key)
        );
        var content = null;
        if (field.boolean) {
          content = React.createElement(
            'label',
            {
              style: Object.assign({}, SETTINGS_ROW, {
                gridTemplateColumns: '190px 120px 1fr',
                cursor: inert ? 'not-allowed' : 'pointer'
              })
            },
            labelNode,
            React.createElement('input', {
              type: 'checkbox',
              checked: values[field.key] === true,
              disabled: inert,
              onChange: function (event) {
                commitBoolean(field, event.target.checked);
              },
              style: inert ? dimControl : undefined
            }),
            React.createElement('span')
          );
        } else if (field.options) {
          var optionNodes = field.options.map(function (value) {
            return React.createElement('option', { key: value, value: value }, optionLabel(value));
          });
          content = React.createElement(
            'div',
            { style: SETTINGS_ROW },
            labelNode,
            React.createElement(
              'select',
              {
                value: values[field.key],
                disabled: inert,
                onChange: function (event) {
                  commitOption(field, event.target.value);
                },
                style: inert ? Object.assign({}, SETTINGS_INPUT, dimControl) : SETTINGS_INPUT
              },
              optionNodes
            ),
            React.createElement('span')
          );
        } else if (field.voice) {
          var voiceList = engineVoices();
          var voiceOptions = [React.createElement('option', { key: 'default', value: '' }, t('tts.voice.default'))];
          for (var voiceIndex = 0; voiceIndex < voiceList.length; voiceIndex += 1) {
            voiceOptions.push(
              React.createElement('option', { key: voiceList[voiceIndex].name, value: voiceList[voiceIndex].name }, voiceList[voiceIndex].name + ' (' + voiceList[voiceIndex].lang + ')')
            );
          }
          content = React.createElement(
            'div',
            { style: Object.assign({}, SETTINGS_ROW, { gridTemplateColumns: '190px 220px 1fr' }) },
            labelNode,
            React.createElement(
              'select',
              {
                value: values[field.key] || '',
                disabled: inert,
                onChange: function (event) {
                  commitVoice(event.target.value);
                },
                style: inert ? Object.assign({}, SETTINGS_INPUT, dimControl) : SETTINGS_INPUT
              },
              voiceOptions
            ),
            React.createElement('span')
          );
        } else {
          var display = field.minutes ? Math.round(values[field.key] / 60000) : values[field.key];
          var unit = field.minutes ? t('unit.minutes') : field.unit || '';
          content = React.createElement(
            'div',
            { style: SETTINGS_ROW },
            labelNode,
            React.createElement('input', {
              type: 'number',
              value: String(display),
              min: field.min,
              max: field.max,
              step: field.step,
              disabled: inert,
              onChange: function (event) {
                commitField(field, event.target.value);
              },
              style: inert ? Object.assign({}, SETTINGS_INPUT, dimControl) : SETTINGS_INPUT
            }),
            React.createElement('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } }, unit)
          );
        }
        if (inertReason !== null) {
          hintNode = React.createElement(
            'div',
            null,
            hintNode,
            React.createElement(
              'div',
              { style: { fontSize: 11, color: 'var(--dsw-alias-state-warn-primary)', marginTop: 2 } },
              t(inertReason)
            )
          );
        }
        return React.createElement('div', { key: field.key, style: { padding: '3px 0' } }, content, hintNode);

      }

      function renderMarkerRow() {
        return React.createElement(
          'div',
          { style: { padding: '3px 0' } },
          React.createElement(
            'div',
            { style: SETTINGS_ROW },
            React.createElement('span', { style: { color: 'var(--dsw-alias-label-primary)' } }, t('settings.marker')),
            React.createElement('input', {
              type: 'text',
              value: String(values.marker || ''),
              maxLength: 12,
              onChange: function (event) {
                commitMarker(event.target.value);
              },
              style: SETTINGS_INPUT
            }),
            React.createElement('span')
          ),
          React.createElement(
            'div',
            { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)', marginTop: 2 } },
            t('settings.markerHint')
          )
        );
      }

      var samplePair = React.useState('你好，我是一段试听。');
      var sampleText = samplePair[0];
      var setSampleText = samplePair[1];

      function cardTint(accent) {
        return Object.assign({}, CARD_STYLE, {
          background: 'color-mix(in srgb, ' + accent + ' 5%, var(--dsw-alias-bg-layer-1))',
          borderLeft: '3px solid color-mix(in srgb, ' + accent + ' 45%, transparent)',
          borderTop: '1px solid var(--dsw-alias-border-l1)'
        });
      }

      function renderCard(group) {
        var cardRows = [];
        for (var index = 0; index < group.main.length; index += 1) {
          var field = fieldByKey(group.main[index]);
          if (field !== null) cardRows.push(renderRow(field));
        }
        if (group.key === 'misc') cardRows.push(renderMarkerRow());
        var advancedNode = null;
        if (group.advanced && group.advanced.length > 0) {
          var advancedRows = [];
          for (var cursor = 0; cursor < group.advanced.length; cursor += 1) {
            var advancedField = fieldByKey(group.advanced[cursor]);
            if (advancedField !== null) advancedRows.push(renderRow(advancedField));
          }
          if (advancedRows.length > 0) {
            advancedNode = React.createElement(
              'details',
              { key: 'advanced', style: { marginTop: 6 } },
              React.createElement(
                'summary',
                { style: { cursor: 'pointer', fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } },
                t('section.advanced')
              ),
              advancedRows
            );
          }
        }
        return React.createElement(
          'section',
          { key: group.key, style: cardTint(group.accent) },
          React.createElement('h4', { style: CARD_TITLE }, t(group.title)),
          group.hint ? React.createElement('p', { style: CARD_HINT }, t(group.hint)) : null,
          cardRows,
          advancedNode
        );
      }

      var snapshot = props.engine && typeof props.engine.getSnapshot === 'function' ? props.engine.getSnapshot() : null;
      var state = snapshot && snapshot.state ? snapshot.state : 'OFF';
      var stateColor =
        state === 'BLOCKED'
          ? 'var(--dsw-alias-state-error-primary)'
          : state === 'ARMING'
            ? 'var(--dsw-alias-state-warn-primary)'
            : state === 'OFF'
              ? 'var(--dsw-alias-state-idle-primary)'
              : 'var(--dsw-alias-state-success-primary)';
      var engineLabel = CONFIG.ttsEngine === 'edge' ? 'Edge' : t('option.system');
      var voiceLabel = CONFIG.ttsEngine === 'edge' ? optionLabel(CONFIG.ttsEdgeVoice) : CONFIG.ttsVoice || t('tts.voice.default');

      function renderDependency() {
        var info = props.engine && props.engine.ttsRouteInfo ? props.engine.ttsRouteInfo : null;
        if (info === null) {
          return React.createElement('div', { style: { color: 'var(--dsw-alias-label-secondary)' } }, t('deps.probing'));
        }
        if (info.ok !== true) {
          return React.createElement('div', { style: { color: 'var(--dsw-alias-state-error-primary)' } }, t('deps.routeError') + ': ' + String(info.error || ''));
        }
        if (info.edgeTts === 'ok') {
          var sourceLabel = info.edgeTtsSource === 'vendor' ? t('deps.sourceVendor') : info.edgeTtsSource === 'system' ? t('deps.sourceSystem') : '';
          return React.createElement(
            'div',
            { style: { color: 'var(--dsw-alias-state-success-primary)' } },
            t('deps.edgeReady') + (info.edgeTtsVersion ? ' · ' + info.edgeTtsVersion : '') + (sourceLabel ? ' · ' + sourceLabel : '')
          );
        }
        if (info.edgeTts === 'missing') {
          return React.createElement(
            'div',
            { style: { color: 'var(--dsw-alias-state-warn-primary)' } },
            t('deps.edgeMissing'),
            React.createElement('div', { style: { marginTop: 2, color: 'var(--dsw-alias-label-secondary)', wordBreak: 'break-all' } }, t('deps.install'))
          );
        }
        return React.createElement('div', { style: { color: 'var(--dsw-alias-label-secondary)' } }, t('deps.edgeUnknown'));
      }

      function renderPreview() {
        var engineField = fieldByKey('ttsEngine');
        var voiceField = fieldByKey('ttsEdgeVoice');
        var rateField = fieldByKey('ttsEdgeRate');
        var pitchField = fieldByKey('ttsEdgePitch');
        var volumeField = fieldByKey('ttsEdgeVolume');
        var engineButtons = ['edge', 'system'].map(function (value) {
          var selected = CONFIG.ttsEngine === value;
          return React.createElement(
            'button',
            {
              key: value,
              type: 'button',
              onClick: function () {
                if (engineField !== null) commitOption(engineField, value);
              },
              style: Object.assign({}, SETTINGS_BUTTON, {
                flex: '1 1 0',
                textAlign: 'center',
                borderColor: selected ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-border-l2)',
                color: selected ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-label-secondary)',
                background: selected ? 'color-mix(in srgb, var(--dsw-alias-brand-primary) 8%, var(--dsw-alias-bg-layer-1))' : 'var(--dsw-alias-bg-layer-1)'
              })
            },
            optionLabel(value)
          );
        });
        var voiceSelect =
          CONFIG.ttsEngine === 'edge'
            ? React.createElement(
                'select',
                {
                  value: CONFIG.ttsEdgeVoice,
                  onChange: function (event) {
                    if (voiceField !== null) commitOption(voiceField, event.target.value);
                  },
                  style: SETTINGS_INPUT
                },
                EDGE_VOICES.map(function (value) {
                  return React.createElement('option', { key: value, value: value }, optionLabel(value));
                })
              )
            : React.createElement('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } }, t('tts.voice.default') + ': ' + (CONFIG.ttsVoice || t('tts.voice.default')));
        function slider(field, label, display) {
          if (field === null) return null;
          return React.createElement(
            'div',
            { key: field.key, style: { marginBottom: 8 } },
            React.createElement(
              'div',
              { style: { display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--dsw-alias-label-secondary)', marginBottom: 2 } },
              React.createElement('span', null, label),
              React.createElement('span', null, display)
            ),
            React.createElement('input', {
              type: 'range',
              min: field.min,
              max: field.max,
              step: field.step,
              value: Number(values[field.key]),
              onChange: function (event) {
                commitField(field, event.target.value);
              },
              style: { width: '100%' }
            })
          );
        }
        return React.createElement(
          'aside',
          {
            style: Object.assign({}, cardTint('var(--dsw-alias-brand-primary)'), {
              flex: '0 0 300px',
              position: 'sticky',
              top: 8,
              marginBottom: 14,
              padding: '12px 14px'
            })
          },
          React.createElement(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, marginBottom: 10 } },
            React.createElement('span', { style: { width: 8, height: 8, borderRadius: '50%', background: stateColor } }),
            React.createElement('span', null, t('chip.' + state) + ' · ' + engineLabel)
          ),
          React.createElement('div', { style: { display: 'flex', gap: 6, marginBottom: 10 } }, engineButtons),
          React.createElement('div', { style: { marginBottom: 8 } }, React.createElement('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)', marginBottom: 2 } }, t('f.ttsEdgeVoice')), voiceSelect),
          slider(rateField, t('f.ttsEdgeRate'), String(CONFIG.ttsEdgeRate) + '%'),
          slider(pitchField, t('f.ttsEdgePitch'), String(CONFIG.ttsEdgePitch) + 'Hz'),
          slider(volumeField, t('f.ttsEdgeVolume'), String(CONFIG.ttsEdgeVolume) + '%'),
          React.createElement('div', { style: { marginBottom: 8 } },
            React.createElement('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)', marginBottom: 2 } }, t('settings.previewText')),
            React.createElement('input', {
              type: 'text',
              value: sampleText,
              maxLength: 120,
              onChange: function (event) {
                setSampleText(event.target.value);
              },
              style: SETTINGS_INPUT
            })
          ),
          React.createElement(
            'div',
            { style: { display: 'flex', gap: 8 } },
            React.createElement(
              'button',
              {
                type: 'button',
                onClick: function () {
                  if (props.engine && typeof props.engine.testTts === 'function') props.engine.testTts(sampleText);
                },
                style: Object.assign({}, SETTINGS_BUTTON, { flex: '1 1 0' })
              },
              t('settings.ttsTest')
            ),
            React.createElement(
              'button',
              {
                type: 'button',
                onClick: function () {
                  if (props.engine && typeof props.engine.stopPlayback === 'function') props.engine.stopPlayback();
                },
                style: Object.assign({}, SETTINGS_BUTTON, { flex: '0 0 auto' })
              },
              t('settings.stopTest')
            )
          ),
          React.createElement(
            'div',
            { style: { marginTop: 10, paddingTop: 8, borderTop: '1px solid var(--dsw-alias-border-l1)', fontSize: 11, lineHeight: 1.6 } },
            React.createElement('div', { style: { color: 'var(--dsw-alias-label-secondary)', marginBottom: 2 } }, t('deps.title')),
            renderDependency()
          ),
          React.createElement('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)', marginTop: 8, lineHeight: 1.5 } }, t('settings.previewHint'))
        );
      }

      var groups = [
        {
          key: 'input',
          title: 'section.input',
          hint: 'section.input.hint',
          accent: 'var(--dsw-alias-brand-primary)',
          main: ['energyThreshold', 'silenceMs', 'preRollMs'],
          advanced: ['minSpeechMs', 'cooldownMs', 'maxSeconds', 'minChars', 'maxFailures', 'longPressMs']
        },
        {
          key: 'exit',
          title: 'section.exit',
          hint: 'section.exit.hint',
          accent: 'var(--dsw-alias-state-warn-primary)',
          main: ['listenWhileHidden', 'idleExitMs', 'blurExitMs'],
          advanced: []
        },
        {
          key: 'tts',
          title: 'section.tts',
          hint: 'section.tts.hint',
          accent: 'var(--dsw-alias-state-success-primary)',
          main: [
            'ttsEnabled',
            'ttsEngine',
            'ttsEdgeVoice',
            'ttsEdgeRate',
            'ttsEdgePitch',
            'ttsEdgeVolume',
            'ttsScope',
            'ttsMaxChars',
            'ttsSkipOpener',
            'ttsSentenceChars',
            'ttsPauseMs',
            'ttsEdgePrefetch',
            'ttsFallbackToSystem',
            'ttsEdgeTimeoutMs',
            'ttsKeepPlayingOnUnfocused',
            'ttsSpeakWhenIdle',
            'ttsSuppressDuringSpeech',
            'ttsBargeIn'
          ],
          advanced: ['ttsRate', 'ttsPitch', 'ttsVolume', 'ttsVoice']
        },
        { key: 'misc', title: 'section.misc', hint: 'section.misc.hint', accent: 'var(--dsw-alias-state-idle-primary)', main: [], advanced: [] }
      ];

      return React.createElement(
        'div',
        { style: { maxWidth: 1040, padding: '4px 2px 24px', fontSize: 13, color: 'var(--dsw-alias-label-primary)' } },
        React.createElement(
          'div',
          { style: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginBottom: 14 } },
          React.createElement(
            'div',
            null,
            React.createElement('h3', { style: { margin: '0 0 4px' } }, t('settings.title')),
            React.createElement('p', { style: { margin: 0, fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } }, t('settings.intro'))
          ),
          React.createElement(
            'div',
            {
              style: {
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                padding: '5px 10px',
                borderRadius: 999,
                border: '1px solid var(--dsw-alias-border-l1)',
                background: 'var(--dsw-alias-bg-layer-2)',
                fontSize: 12,
                whiteSpace: 'nowrap'
              }
            },
            React.createElement('span', { style: { width: 8, height: 8, borderRadius: '50%', background: stateColor } }),
            React.createElement('span', null, t('chip.' + state) + ' · ' + engineLabel + ' · ' + voiceLabel)
          )
        ),
        React.createElement(
          'div',
          { style: { display: 'flex', gap: 18, alignItems: 'flex-start', flexWrap: 'wrap' } },
          React.createElement(
            'div',
            { style: { flex: '1 1 480px', minWidth: 0 } },
            groups.map(renderCard),
            React.createElement(
              'div',
              { style: { display: 'flex', alignItems: 'center', gap: 10, margin: '2px 0 12px' } },
              React.createElement(
                'button',
                {
                  type: 'button',
                  onClick: function () {
                    if (props.engine && typeof props.engine.testTts === 'function') props.engine.testTts();
                  },
                  style: SETTINGS_BUTTON
                },
                t('settings.ttsTest')
              ),
              React.createElement('button', { type: 'button', onClick: resetAll, style: SETTINGS_BUTTON }, t('settings.reset')),
              flash ? React.createElement('span', { style: { fontSize: 12, color: 'var(--dsw-alias-state-success-primary)' } }, flash) : null
            ),
            React.createElement(
              'details',
              { style: { marginTop: 6 } },
              React.createElement('summary', { style: { cursor: 'pointer', fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } }, t('settings.diag')),
              React.createElement(
                'pre',
                {
                  style: {
                    fontSize: 11,
                    maxHeight: 240,
                    overflow: 'auto',
                    background: 'var(--dsw-alias-bg-layer-2)',
                    color: 'var(--dsw-alias-label-secondary)',
                    padding: 8,
                    borderRadius: 8,
                    whiteSpace: 'pre-wrap'
                  }
                },
                diagLines.length > 0 ? diagLines.join('\n') : t('settings.diagEmpty')
              )
            )
          ),
          renderPreview()
        )
      );
    }

    // ── Host 工具控制通道：轮询命令队列 + 回报状态 ──
    var CONTROL_URL = '/api/voice-mode.control';

    function startControlPoll(engine) {
      var busy = false;
      function report() {
        return fetch(CONTROL_URL, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            state: engine.state,
            speaking: engine.isSpeaking(),
            sessionId: engine.sessionId,
            detail: engine.detail,
            at: Date.now()
          })
        }).catch(function () {});
      }
      async function tick() {
        if (busy) return;
        busy = true;
        try {
          var response = await fetch(CONTROL_URL, { credentials: 'same-origin' });
          if (response.ok) {
            var body = await response.json();
            var commands = Array.isArray(body && body.commands) ? body.commands : [];
            for (var index = 0; index < commands.length; index += 1) {
              var command = commands[index];
              try {
                if (command.action === 'enable') {
                  if (engine.sessionId === null) {
                    engine.logEvent('control', 'enable ignored: no open session');
                  } else {
                    engine.logEvent('control', 'enable requested by tool');
                    engine.arm({ restored: false });
                  }
                } else if (command.action === 'disable') {
                  engine.logEvent('control', 'disable requested by tool');
                  engine.shutdown('tool');
                } else if (command.action === 'speak') {
                  engine.logEvent('control', 'speak requested by tool');
                  engine.speakFromTool(command.text);
                }
              } catch (error) {
                engine.logEvent('control', 'command failed: ' + String((error && error.message) || error));
              }
            }
          }
        } catch (_error) {
        } finally {
          busy = false;
        }
        report();
      }
      var timer = setInterval(tick, 1500);
      tick();
      return function () {
        clearInterval(timer);
      };
    }

    // ── 挂载 ──
    async function apply(ctx) {
      var disposeRemote = await ctx.remote.$mount(TYPERT_REMOTE);
      // 引擎必须拿「注入后的」上下文：remote.speech / sessions 都是 inject 才能取的键，
      // 用外层 ctx 取会抛 cannot get property "remote.speech" without inject。
      var engine = null;
      var ui = null;
      var stopControlPoll = null;
      try {
        ui = ctx.inject(['remote.speech', 'slots', 'locale', 'sessions'], function (c) {
          engine = new VoiceEngine(c);
          c.effect(function () {
            return c.locale.register(NS, { zh: ZH, en: EN });
          });
          c.effect(function () {
            var style = document.createElement('style');
            style.setAttribute('data-voice-mode', 'mic-anim');
            style.textContent = MIC_ANIM_CSS;
            document.head.appendChild(style);
            return function () {
              style.remove();
            };
          });
          c.slots.inject('conversation.session.header.utilities', function () {
            return c.slots.register(
              {
                name: 'conversation.session.header.utilities',
                id: 'voice-mode-status',
                order: -2,
                locale: NS,
                inject: function () {
                  return { engine: engine };
                }
              },
              VoiceStatusChip
            );
          });
          c.slots.inject('conversation.session.header.utilities', function () {
            return c.slots.register(
              {
                name: 'conversation.session.header.utilities',
                id: 'voice-mode-tts',
                order: -1,
                locale: NS,
                inject: function () {
                  return { engine: engine };
                }
              },
              VoiceTtsToggle
            );
          });
          c.slots.inject('sidebar.session.row.leading', function () {
            return c.slots.register(
              {
                name: 'sidebar.session.row.leading',
                id: 'voice-mode-session-dot',
                order: 20,
                locale: NS,
                inject: function () {
                  return { engine: engine };
                }
              },
              VoiceSessionDot
            );
          });
          c.slots.inject('shell.overlay', function () {
            return c.slots.register(
              {
                name: 'shell.overlay',
                id: 'voice-mode-fallback',
                order: 50,
                locale: NS,
                inject: function () {
                  return { engine: engine };
                }
              },
              VoiceFallbackToast
            );
          });
          c.slots.inject('conversation.input.right', function () {
            return c.slots.register(
              {
                name: 'conversation.input.right',
                id: 'voice-mode-mic',
                order: 20,
                locale: NS,
                inject: function () {
                  return { engine: engine };
                }
              },
              VoiceMicIcon
            );
          });
          c.slots.inject('settings.section', function () {
            var label = 'Voice chat mode';
            try {
              var translate = c.locale.bind(NS);
              var text = translate('settings.title');
              if (typeof text === 'string' && text !== '') label = text;
            } catch (_error) {}
            return c.slots.register(
              {
                name: 'settings.section',
                id: 'voice-mode',
                order: 25,
                locale: NS,
                label: label,
                inject: function () {
                  return { engine: engine };
                }
              },
              VoiceSettings
            );
          });
          c.effect(function () {
            var channel = null;
            try {
              if (typeof BroadcastChannel === 'function') channel = new BroadcastChannel('voice-mode:window-focus');
            } catch (_error) {
              channel = null;
            }
            if (channel === null) return undefined;
            var windowId = Math.random().toString(36).slice(2);
            var peers = {};
            var yieldTimer = null;
            function announce(type) {
              try {
                channel.postMessage({ type: type, id: windowId, focused: document.hasFocus(), at: Date.now() });
              } catch (_error) {}
            }
            function anotherWindowFocused() {
              var now = Date.now();
              for (var id in peers) {
                if (Object.prototype.hasOwnProperty.call(peers, id) && peers[id].focused === true && now - peers[id].at < 4000) return true;
              }
              return false;
            }
            function yieldIfNeeded() {
              yieldTimer = null;
              if (document.hasFocus() === true) return;
              if (engine.isActive() !== true) return;
              if (anotherWindowFocused() !== true) return;
              engine.suspendForOtherWindow();
            }
            function onMessage(event) {
              var data = event.data;
              if (!data || typeof data !== 'object' || data.id === windowId) return;
              if (data.type !== 'focus' && data.type !== 'blur') return;
              peers[data.id] = { focused: data.type === 'focus', at: Date.now() };
              if (data.type === 'focus' && document.hasFocus() !== true) yieldIfNeeded();
            }
            function onFocus() {
              announce('focus');
              if (yieldTimer !== null) {
                clearTimeout(yieldTimer);
                yieldTimer = null;
              }
              engine.resumeAfterOtherWindow();
            }
            function onBlur() {
              announce('blur');
              if (yieldTimer !== null) clearTimeout(yieldTimer);
              yieldTimer = setTimeout(yieldIfNeeded, 400);
            }
            window.addEventListener('focus', onFocus);
            window.addEventListener('blur', onBlur);
            channel.addEventListener('message', onMessage);
            announce('focus');
            return function () {
              window.removeEventListener('focus', onFocus);
              window.removeEventListener('blur', onBlur);
              channel.removeEventListener('message', onMessage);
              if (yieldTimer !== null) clearTimeout(yieldTimer);
              try {
                channel.close();
              } catch (_error) {}
            };
          });
          c.effect(function () {
            var blurTimer = null;
            function onVisibility() {
              // 默认：hidden 立即停麦。开启 listenWhileHidden 后，后台/最小化也继续监听。
              if (document.hidden && CONFIG.listenWhileHidden !== true) {
                engine.logEvent('window', 'hidden → shutdown requested');
                engine.requestDeferredShutdown('hidden');
              }
            }
            function onKeyDown(event) {
              if (event.key !== 'Escape') return;
              // Esc 优先级：先停播；再按一次才关模式。
              if (engine.isSpeaking()) {
                engine.stopPlayback();
                return;
              }
              engine.shutdown('escape');
            }
            function onBlur() {
              if (blurTimer !== null) clearTimeout(blurTimer);
              // 0 = 不因失焦退出（切到别的窗口看东西时继续听）。
              if (CONFIG.blurExitMs <= 0) return;
              blurTimer = setTimeout(function () {
                blurTimer = null;
                engine.logEvent('window', 'blur timeout → shutdown requested');
                engine.requestDeferredShutdown('blur');
              }, CONFIG.blurExitMs);
            }
            function onFocus() {
              if (blurTimer !== null) {
                clearTimeout(blurTimer);
                blurTimer = null;
              }
            }
            function onPageHide() {
              engine.dispose();
            }
            document.addEventListener('visibilitychange', onVisibility);
            window.addEventListener('keydown', onKeyDown, true);
            window.addEventListener('blur', onBlur);
            window.addEventListener('focus', onFocus);
            window.addEventListener('pagehide', onPageHide);
            return function () {
              document.removeEventListener('visibilitychange', onVisibility);
              window.removeEventListener('keydown', onKeyDown, true);
              window.removeEventListener('blur', onBlur);
              window.removeEventListener('focus', onFocus);
              window.removeEventListener('pagehide', onPageHide);
              if (blurTimer !== null) clearTimeout(blurTimer);
            };
          });
        });
        await ui;
        stopControlPoll = startControlPoll(engine);
      } catch (error) {
        if (stopControlPoll !== null) stopControlPoll();
        if (engine !== null) engine.dispose();
        await disposeRemote();
        throw error;
      }
      return async function () {
        if (stopControlPoll !== null) stopControlPoll();
        if (engine !== null) engine.dispose();
        if (ui !== null) await ui.dispose();
        await disposeRemote();
      };
    }

    return { inject: ['remote', 'slots', 'locale'], apply: apply };
