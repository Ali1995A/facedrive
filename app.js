(() => {
  "use strict";

  // ---- Config (quality + modes) ----
  const QUALITY_PRESETS = {
    high: {
      particleCount: 14000,
      maxPixelRatio: 2,
      antialias: true,
      fog: true,
      depthTest: true,
      renderIntervalMs: 0,
      particleUpdateIntervalMs: 0,
      faceFrameIntervalMs: 0,
      video: { width: 640, height: 480 },
      refineLandmarks: false,
    },
    medium: {
      particleCount: 9000,
      maxPixelRatio: 1.5,
      antialias: false,
      fog: true,
      depthTest: false,
      renderIntervalMs: 16,
      particleUpdateIntervalMs: 16,
      faceFrameIntervalMs: 66,
      video: { width: 480, height: 360 },
      refineLandmarks: false,
    },
    low: {
      particleCount: 5200,
      maxPixelRatio: 1,
      antialias: false,
      fog: false,
      depthTest: false,
      renderIntervalMs: 33,
      particleUpdateIntervalMs: 33,
      faceFrameIntervalMs: 100,
      video: { width: 320, height: 240 },
      refineLandmarks: false,
    },
  };

  const MODE_PRESETS = {
    resonance: { drift: 0.18, wind: 0.45, cohesion: 0.22, sparkle: 0.7 },
    burst: { drift: 0.12, wind: 0.55, cohesion: 0.14, sparkle: 0.9 },
    drift: { drift: 0.25, wind: 0.25, cohesion: 0.28, sparkle: 0.55 },
  };

  // ---- Env detection (wechat / iOS / iPad Pro 1) ----
  const UA = navigator.userAgent || "";
  const IS_WECHAT = /MicroMessenger/i.test(UA);
  const IS_IOS =
    /iPad|iPhone|iPod/i.test(UA) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const IS_IPAD = /iPad/i.test(UA) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const IS_IPAD_PRO_1 =
    IS_IPAD &&
    Math.max(screen.width, screen.height) <= 1366 &&
    (navigator.deviceMemory ? navigator.deviceMemory <= 4 : true);
  const PREFERS_REDUCED_MOTION =
    window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const LITE_DEVICE = IS_WECHAT || IS_IPAD_PRO_1;
  if (LITE_DEVICE) document.documentElement.classList.add("lite");
  const MIRROR_MODE = true;

  const qs = new URLSearchParams(location.search);
  const forcedQuality = (qs.get("quality") || "").toLowerCase();
  const earsMode = (qs.get("ears") || "mickey").toLowerCase(); // ?ears=mickey|off
  const MICKEY_EARS_ENABLED = !(earsMode === "0" || earsMode === "off" || earsMode === "false" || earsMode === "none");

  // ---- DOM ----
  const canvas = document.getElementById("canvas");
  const video = document.getElementById("video");
  const overlay = document.getElementById("overlay");

  const envPill = document.getElementById("envPill");
  const envText = document.getElementById("envText");
  const startBtn = document.getElementById("startBtn");
  const demoBtn = document.getElementById("demoBtn");
  const helpBtn = document.getElementById("helpBtn");
  const helpText = document.getElementById("helpText");

  const calibration = document.getElementById("calibration");
  const calibDot = document.getElementById("calibDot");
  const calibText = document.getElementById("calibText");
  const calibHint = document.getElementById("calibHint");
  const calibBar = document.getElementById("calibBar");

  const panel = document.getElementById("panel");
  const modeSelect = document.getElementById("modeSelect");
  const qualitySelect = document.getElementById("qualitySelect");
  const sensitivityRange = document.getElementById("sensitivityRange");
  const particleRange = document.getElementById("particleRange");
  const colorPicker = document.getElementById("colorPicker");
  const colorGlowBtn = document.getElementById("colorGlowBtn");
  const colorSolidBtn = document.getElementById("colorSolidBtn");
  const swatchButtons = panel ? Array.from(panel.querySelectorAll(".swatch[data-color]")) : [];
  const fullscreenBtn = document.getElementById("fullscreenBtn");
  const togglePreviewBtn = document.getElementById("togglePreviewBtn");

  const trackDot = document.getElementById("trackDot");
  const trackText = document.getElementById("trackText");
  const toast = document.getElementById("toast");

  // Voice UI (Happi / 海皮) — kid mode: single mic button
  const voiceDock = document.getElementById("voiceDock");
  const voiceMicBtn = document.getElementById("voiceMicBtn");

  // Remove any injected "links.json" floating button/link (common in some hosts / preview toolbars).
  function stripLinksJsonUi(root = document) {
    const els = root.querySelectorAll("a, button");
    els.forEach((el) => {
      const text = (el.textContent || "").trim().toLowerCase();
      const aria = (el.getAttribute("aria-label") || "").trim().toLowerCase();
      const href = (el.getAttribute("href") || "").trim().toLowerCase();
      if (
        text === "links.json" ||
        aria === "links.json" ||
        href === "links.json" ||
        href.endsWith("/links.json") ||
        href.endsWith("links.json") ||
        href.includes("links.json")
      ) {
        el.remove();
      }
    });
  }

  stripLinksJsonUi();
  (() => {
    let pending = false;
    const schedule = () => {
      if (pending) return;
      pending = true;
      requestAnimationFrame(() => {
        pending = false;
        stripLinksJsonUi();
      });
    };
    new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
  })();

  // ---- Utils ----
  const clamp01 = (v) => Math.min(1, Math.max(0, v));
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const lerp = (a, b, t) => a + (b - a) * t;

  let toastTimer = null;
  function showToast(msg) {
    toast.textContent = msg;
    toast.classList.add("show");
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("show"), 1800);
  }

  function setDot(dotEl, state) {
    if (!dotEl) return;
    dotEl.classList.remove("good", "bad");
    if (state === "good") dotEl.classList.add("good");
    if (state === "bad") dotEl.classList.add("bad");
  }

  // ---- Voice (GLM-Realtime) helpers ----
  const uuid = () => (globalThis.crypto?.randomUUID ? crypto.randomUUID() : `evt_${Math.random().toString(16).slice(2)}`);

  function bytesToBase64(bytes) {
    let binary = "";
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      const chunk = bytes.subarray(i, i + chunkSize);
      binary += String.fromCharCode.apply(null, chunk);
    }
    return btoa(binary);
  }

  function base64ToBytes(b64) {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  function int16ToFloat32(int16) {
    const out = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) out[i] = Math.max(-1, Math.min(1, int16[i] / 32768));
    return out;
  }

  function float32ToInt16Bytes(float32) {
    const out = new Uint8Array(float32.length * 2);
    const view = new DataView(out.buffer);
    for (let i = 0; i < float32.length; i++) {
      const s = Math.max(-1, Math.min(1, float32[i]));
      view.setInt16(i * 2, (s < 0 ? s * 0x8000 : s * 0x7fff) | 0, true);
    }
    return out;
  }

  function resampleFloat32Linear(input, inRate, outRate) {
    if (inRate === outRate) return input;
    const ratio = inRate / outRate;
    const outLength = Math.max(1, Math.floor(input.length / ratio));
    const out = new Float32Array(outLength);
    for (let i = 0; i < outLength; i++) {
      const pos = i * ratio;
      const idx = Math.floor(pos);
      const frac = pos - idx;
      const s0 = input[idx] ?? 0;
      const s1 = input[idx + 1] ?? s0;
      out[i] = s0 + (s1 - s0) * frac;
    }
    return out;
  }

  function appendVoiceLine(role, text) {
    // Kid mode: no transcript UI. Keep toast minimal for debug.
    if (role === "系统：" && text) showToast(text);
  }

  class HappiRealtimeVoice {
    constructor() {
      this.ws = null;
      this.wsReady = false;
      this.audioCtx = null;
      this.micStream = null;
      this.micSource = null;
      this.micProcessor = null;
      this.isCapturing = false;
      this.closed = false;

      this.inRate = 0;
      this.outRate = 16000;
      this.playInRate = 24000;
      this.playQueueTime = 0;

      this.pendingInBytes = [];
      this.pendingInBytesLen = 0;
      this.targetChunkBytes = 6400; // 100ms @ 16kHz mono 16-bit

      this.partialAssistantText = "";
      this.lastError = "";
      this.connecting = false;
    }

    setStatus(text, dotState) {
      // Kid mode: keep the single button always available.
      // We gate behavior in event handlers instead of disabling the button.
    }

    setError(message) {
      this.lastError = message || "";
      this.setStatus(`连接失败`, "bad");
      if (message) appendVoiceLine("系统：", message);
    }

    async ensureAudioContext() {
      if (this.audioCtx) return;
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) throw new Error("当前浏览器不支持 AudioContext");
      this.audioCtx = new Ctx();
      if (this.audioCtx.state === "suspended") await this.audioCtx.resume();
      this.playQueueTime = this.audioCtx.currentTime;
    }

    async requestMic() {
      if (this.micStream) return;
      this.micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      await this.ensureAudioContext();

      this.micSource = this.audioCtx.createMediaStreamSource(this.micStream);
      const bufferSize = LITE_DEVICE ? 4096 : 2048;
      const processor = this.audioCtx.createScriptProcessor(bufferSize, 1, 1);
      this.inRate = this.audioCtx.sampleRate;
      processor.onaudioprocess = (e) => {
        if (!this.wsReady || !this.isCapturing) return;
        const input = e.inputBuffer.getChannelData(0);
        const down = resampleFloat32Linear(input, this.inRate, this.outRate);
        const bytes = float32ToInt16Bytes(down);
        this.pendingInBytes.push(bytes);
        this.pendingInBytesLen += bytes.length;
        while (this.pendingInBytesLen >= this.targetChunkBytes) {
          this.flushInputChunk(this.targetChunkBytes);
        }
      };
      this.micSource.connect(processor);
      processor.connect(this.audioCtx.destination); // keep processor alive on iOS
      this.micProcessor = processor;
    }

    flushInputChunk(targetBytes) {
      const out = new Uint8Array(targetBytes);
      let offset = 0;
      while (offset < targetBytes && this.pendingInBytes.length) {
        const head = this.pendingInBytes[0];
        const need = targetBytes - offset;
        if (head.length <= need) {
          out.set(head, offset);
          offset += head.length;
          this.pendingInBytes.shift();
        } else {
          out.set(head.subarray(0, need), offset);
          this.pendingInBytes[0] = head.subarray(need);
          offset += need;
        }
      }
      this.pendingInBytesLen -= targetBytes;
      this.sendEvent({ type: "input_audio_buffer.append", audio: bytesToBase64(out) });
    }

    async getWsConfig() {
      try {
        const res = await fetch("/api/zhipu-token", { cache: "no-store" });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) {
          const msg = json?.error ? String(json.error) : `token api status ${res.status}`;
          throw new Error(msg);
        }
        if (!json?.token) throw new Error("token api missing token");
        return json;
      } catch (err) {
        const msg = err?.message || String(err);
        throw new Error(`语音服务未配置：${msg}`);
      }
    }

    // Note: no browser-side API key input in kid mode.

    async connect() {
      if (this.connecting) return;
      this.closed = false;
      this.connecting = true;
      this.setStatus("连接中…", "");
      await this.ensureAudioContext();
      await this.requestMic();

      const cfg = await this.getWsConfig();
      const token = cfg.token;

      const base = "wss://open.bigmodel.cn/api/paas/v4/realtime";
      const candidatesRaw = [
        ...(Array.isArray(cfg.wsUrls) ? cfg.wsUrls : []),
        cfg.wsUrl,
        `${base}?token=${encodeURIComponent(token)}`,
        `${base}?access_token=${encodeURIComponent(token)}`,
        `${base}?Authorization=${encodeURIComponent(token)}`,
        `${base}?token=${encodeURIComponent(`Bearer ${token}`)}`,
        `${base}?access_token=${encodeURIComponent(`Bearer ${token}`)}`,
      ].filter(Boolean);

      const seen = new Set();
      const candidates = candidatesRaw.filter((u) => (seen.has(u) ? false : (seen.add(u), true)));

      const tryConnectOnce = (wsUrl) =>
        new Promise((resolve, reject) => {
          let opened = false;
          let gotErrorEvent = "";
          const ws = new WebSocket(wsUrl);
          this.ws = ws;

          const timer = setTimeout(() => {
            try {
              ws.close();
            } catch {}
            reject(new Error("WebSocket 连接超时"));
          }, 6500);

          ws.onopen = () => {
            opened = true;
            clearTimeout(timer);
            this.wsReady = true;
            this.setStatus("已连接（按住说话）", "good");
            this.sendSessionUpdate();
            resolve();
          };
          ws.onmessage = (ev) => {
            // if server replies with an error event before we even start talking, surface it
            try {
              const msg = JSON.parse(ev.data);
              if (msg?.type === "error") {
                gotErrorEvent = msg?.error?.message || msg?.message || "unknown error";
              }
            } catch {}
            this.onServerMessage(ev.data);
          };
          ws.onerror = () => {
            // onerror provides no details; rely on close code/reason
          };
          ws.onclose = (ev) => {
            clearTimeout(timer);
            const wasReady = this.wsReady;
            this.wsReady = false;
            if (this.closed) return;
            if (wasReady) {
              this.setStatus(`已断开 (code=${ev?.code || 0})`, "bad");
              return;
            }
            const reason = ev?.reason ? ` reason=${ev.reason}` : "";
            const hint = gotErrorEvent ? ` server=${gotErrorEvent}` : "";
            reject(new Error(`WebSocket 已关闭 (code=${ev?.code || 0})${reason}${hint}`));
          };
        });

      const errors = [];
      for (const url of candidates) {
        try {
          await tryConnectOnce(url);
          this.connecting = false;
          return;
        } catch (e) {
          errors.push(`[${errors.length + 1}] ${e?.message || String(e)}`);
          try {
            this.ws?.close();
          } catch {}
          this.ws = null;
        }
      }
      this.connecting = false;
      throw new Error(errors.join("；"));
    }

    sendEvent(evt) {
      if (!this.wsReady || !this.ws) return;
      const msg = {
        event_id: uuid(),
        client_timestamp: Date.now(),
        ...evt,
      };
      this.ws.send(JSON.stringify(msg));
    }

    sendSessionUpdate() {
      const instructions =
        "你是一个善于与5岁幼儿园小朋友对话的陪伴型老师，名字叫“海皮”。你认识一个小朋友叫 CC（5岁多，不到6岁），很聪明很可爱；你在和 CC 聊天。用非常友好、耐心、鼓励的语气。句子短一点，多提开放式问题，引导孩子表达感受与想法。避免恐怖、暴力、成人、危险行为内容。孩子说错也不要纠正得太硬，先肯定再轻轻引导。";
      this.sendEvent({
        type: "session.update",
        session: {
          model: "glm-realtime",
          modalities: ["audio", "text"],
          instructions,
          voice: "tongtong",
          input_audio_format: "pcm16",
          output_audio_format: "pcm",
          input_audio_noise_reduction: { type: "far_field" },
          temperature: 0.6,
          max_response_output_tokens: "inf",
          beta_fields: {
            chat_mode: "audio",
            tts_source: "e2e",
            greeting_config: { enable: true, content: "你好CC，我是海皮" },
          },
        },
      });
    }

    onServerMessage(raw) {
      let msg = null;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      const type = msg?.type || "";
      if (type === "error") {
        this.setError(msg?.error?.message || msg?.message || "unknown");
        return;
      }
      if (type === "response.audio_transcript.delta") {
        this.partialAssistantText += msg.delta || "";
        return;
      }
      if (type === "response.audio_transcript.done") {
        const text = (this.partialAssistantText || "").trim();
        this.partialAssistantText = "";
        if (text) appendVoiceLine("海皮：", text);
        return;
      }
      if (type === "conversation.item.input_audio_transcription.completed") {
        const text = msg?.transcript || msg?.text || "";
        if (text) appendVoiceLine("你：", text);
        return;
      }
      if (type === "response.audio.delta") {
        const b64 = msg?.delta || msg?.audio || "";
        if (b64) this.playPcmChunk(b64);
      }
    }

    playPcmChunk(b64) {
      if (!this.audioCtx) return;
      const bytes = base64ToBytes(b64);
      const int16 = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
      const float = int16ToFloat32(int16);
      const out = resampleFloat32Linear(float, this.playInRate, this.audioCtx.sampleRate);
      const buf = this.audioCtx.createBuffer(1, out.length, this.audioCtx.sampleRate);
      buf.copyToChannel(out, 0, 0);
      const src = this.audioCtx.createBufferSource();
      src.buffer = buf;
      src.connect(this.audioCtx.destination);
      const now = this.audioCtx.currentTime;
      const t = Math.max(now + 0.02, this.playQueueTime);
      src.start(t);
      this.playQueueTime = t + buf.duration;
    }

    startCapture() {
      if (!this.wsReady) return;
      this.isCapturing = true;
      this.pendingInBytes = [];
      this.pendingInBytesLen = 0;
      this.sendEvent({ type: "input_audio_buffer.clear" });
    }

    stopCaptureAndRespond() {
      if (!this.wsReady) return;
      this.isCapturing = false;
      while (this.pendingInBytesLen >= this.targetChunkBytes) {
        this.flushInputChunk(this.targetChunkBytes);
      }
      if (this.pendingInBytesLen > 0) {
        this.flushInputChunk(this.pendingInBytesLen);
      }
      this.pendingInBytes = [];
      this.pendingInBytesLen = 0;
      this.sendEvent({ type: "input_audio_buffer.commit" });
      this.sendEvent({ type: "response.create" });
    }

    async shutdown() {
      this.closed = true;
      this.wsReady = false;
      this.isCapturing = false;
      this.connecting = false;
      try {
        this.ws?.close();
      } catch {}
      this.ws = null;

      try {
        this.micProcessor?.disconnect();
      } catch {}
      try {
        this.micSource?.disconnect();
      } catch {}
      this.micProcessor = null;
      this.micSource = null;

      try {
        this.micStream?.getTracks()?.forEach((t) => t.stop());
      } catch {}
      this.micStream = null;
      this.setStatus("已断开", "bad");
    }
  }

  function resolveInitialTier() {
    if (forcedQuality === "high" || forcedQuality === "medium" || forcedQuality === "low") return forcedQuality;
    if (PREFERS_REDUCED_MOTION) return "low";
    if (LITE_DEVICE) return "low";
    if (IS_IOS) return "medium";
    return "high";
  }

  let qualityTier = resolveInitialTier();
  let quality = QUALITY_PRESETS[qualityTier];

  qualitySelect.value = forcedQuality ? forcedQuality : "auto";
  modeSelect.value = "resonance";

  envText.textContent = `${IS_WECHAT ? "微信内置浏览器" : "系统浏览器"} · ${qualityTier.toUpperCase()}`;
  setDot(envPill.querySelector(".dot"), qualityTier === "high" ? "good" : qualityTier === "low" ? "bad" : "");

  function getSelectedTier() {
    const v = (qualitySelect.value || "auto").toLowerCase();
    if (v === "high" || v === "medium" || v === "low") return v;
    return resolveInitialTier();
  }

  // ---- App state ----
  const appStartAt = performance.now();
  let sensitivity = Number(sensitivityRange.value) || 1.0;
  let particleStrength = Number(particleRange.value) || 1.0;
  let mode = MODE_PRESETS[modeSelect.value] || MODE_PRESETS.resonance;
  let baseColorHex = (colorPicker && colorPicker.value) || "#9bb7ff";
  let hueCycleEnabled = false;
  let hueOffset = 0;
  const baseColor = new THREE.Color(baseColorHex);
  const baseHsl = { h: 0, s: 0, l: 0 };
  const tmpColor = new THREE.Color();
  let wantsColors = true;

  function refreshBaseColor() {
    baseColor.set(baseColorHex || "#9bb7ff");
    baseColor.getHSL(baseHsl);
  }
  refreshBaseColor();

  let colorMode = "glow"; // "glow" | "solid"

  function applyColorMode(nextMode) {
    colorMode = nextMode === "solid" ? "solid" : "glow";
    wantsColors = colorMode === "glow";
    if (colorPicker) colorPicker.disabled = colorMode !== "solid";
    if (colorGlowBtn) colorGlowBtn.classList.toggle("active", colorMode === "glow");
    if (colorSolidBtn) colorSolidBtn.classList.toggle("active", colorMode === "solid");
    if (swatchButtons.length) {
      swatchButtons.forEach((btn) => btn.classList.toggle("active", (btn.dataset.color || "").toLowerCase() === (baseColorHex || "").toLowerCase()));
    }
    if (!material) return;
    material.vertexColors = wantsColors;
    material.color = wantsColors ? new THREE.Color(0xffffff) : new THREE.Color(baseColorHex || "#9bb7ff");
    material.needsUpdate = true;
  }

  // Camera + FaceMesh
  let stream = null;
  let faceMesh = null;
  let faceBusy = false;
  let faceLastSentAt = 0;
  let faceTrackingEnabled = false;
  let lastFaceResultAt = 0;

  const faceState = {
    ok: false,
    hasFace: false,
    faceX: 0,
    faceY: 0,
    faceScale: 1,
    yaw: 0,
    pitch: 0,
    smile: 0,
    mouthOpen: 0,
    blink: 0,
    frown: 0,
  };
  const faceTarget = { ...faceState };
  const faceSmooth = { ...faceState };

  const calibrationState = {
    active: false,
    startedAt: 0,
    durationMs: 1200,
    samples: 0,
    base: {
      eyeDist: 0,
      mouthWidth: 0,
      faceScale: 0,
      eyeOpen: 0,
      browEye: 0,
    },
  };

  function resetCalibration() {
    calibrationState.active = true;
    calibrationState.startedAt = performance.now();
    calibrationState.samples = 0;
    calibrationState.base.eyeDist = 0;
    calibrationState.base.mouthWidth = 0;
    calibrationState.base.faceScale = 0;
    calibrationState.base.eyeOpen = 0;
    calibrationState.base.browEye = 0;

    calibration.classList.remove("hidden");
    calibText.textContent = "准备摄像头…";
    calibHint.textContent = "请将脸对准中央，保持 1 秒钟稳定。";
    calibBar.style.width = "0%";
    setDot(calibDot, "");
  }

  async function waitForVideoReady(videoEl, timeoutMs = 8000) {
    const start = performance.now();
    const ready = () =>
      videoEl.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && videoEl.videoWidth > 0 && videoEl.videoHeight > 0;
    if (ready()) return;

    await new Promise((resolve, reject) => {
      const done = () => {
        cleanup();
        resolve();
      };
      const fail = () => {
        cleanup();
        reject(new Error("Video timeout"));
      };
      const onAny = () => {
        if (ready()) done();
        if (performance.now() - start > timeoutMs) fail();
      };
      const t = setInterval(onAny, 120);
      const cleanup = () => {
        clearInterval(t);
        videoEl.removeEventListener("loadedmetadata", onAny);
        videoEl.removeEventListener("loadeddata", onAny);
        videoEl.removeEventListener("canplay", onAny);
        videoEl.removeEventListener("playing", onAny);
      };
      videoEl.addEventListener("loadedmetadata", onAny, { once: false });
      videoEl.addEventListener("loadeddata", onAny, { once: false });
      videoEl.addEventListener("canplay", onAny, { once: false });
      videoEl.addEventListener("playing", onAny, { once: false });
    });
  }

  async function initCamera() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error("Camera not supported");

    const tier = getSelectedTier();
    const videoConstraints = {
      facingMode: "user",
      width: { ideal: QUALITY_PRESETS[tier].video.width },
      height: { ideal: QUALITY_PRESETS[tier].video.height },
      frameRate: LITE_DEVICE ? { ideal: 20, max: 24 } : { ideal: 30, max: 30 },
    };

    stream = await navigator.mediaDevices.getUserMedia({ video: videoConstraints, audio: false });
    video.srcObject = stream;
    // iOS/WeChat can be picky; ensure inline playback stays active.
    video.muted = true;
    video.playsInline = true;
    video.setAttribute("playsinline", "");
    video.setAttribute("webkit-playsinline", "");
    await video.play().catch(() => {});
    await waitForVideoReady(video, 9000);
  }

  function stopCamera() {
    if (stream) {
      try {
        stream.getTracks().forEach((t) => t.stop());
      } catch {}
    }
    stream = null;
    try {
      video.srcObject = null;
    } catch {}
  }

  function initFaceMesh() {
    faceMesh = new FaceMesh({
      locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}`,
    });
    faceMesh.setOptions({
      maxNumFaces: 1,
      refineLandmarks: !!quality.refineLandmarks,
      minDetectionConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });
    faceMesh.onResults(onFaceResults);
  }

  function ensureFaceMeshReady() {
    if (!faceMesh) {
      initFaceMesh();
      return;
    }
    faceMesh.setOptions({
      maxNumFaces: 1,
      refineLandmarks: !!quality.refineLandmarks,
      minDetectionConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });
  }

  const dist2 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const safeDiv = (a, b, fallback = 0) => (!b || !Number.isFinite(b) ? fallback : a / b);

  function onFaceResults(results) {
    faceState.ok = true;
    lastFaceResultAt = performance.now();
    const lm = results.multiFaceLandmarks && results.multiFaceLandmarks[0];
    faceState.hasFace = !!lm;
    if (!lm) return;

    const nose = lm[1];
    const leftEyeOuter = lm[33];
    const rightEyeOuter = lm[263];
    const leftMouth = lm[61];
    const rightMouth = lm[291];
    const upperLip = lm[13];
    const lowerLip = lm[14];

    const eyeDist = dist2(leftEyeOuter, rightEyeOuter);
    const mouthWidth = dist2(leftMouth, rightMouth);
    const mouthOpen = dist2(upperLip, lowerLip);

    const midEye = {
      x: (leftEyeOuter.x + rightEyeOuter.x) * 0.5,
      y: (leftEyeOuter.y + rightEyeOuter.y) * 0.5,
      z: (leftEyeOuter.z + rightEyeOuter.z) * 0.5,
    };

    // position: -1..1 around screen center
    const faceX = (nose.x - 0.5) * 2;
    const faceY = (nose.y - 0.5) * 2;

    // scale: normalized by calibration (bigger => closer)
    const faceScale = clamp(safeDiv(eyeDist, calibrationState.base.eyeDist || eyeDist, 1), 0.6, 1.8);

    // yaw/pitch: nose offset relative to eye center, normalized by eye distance
    const nx = safeDiv(nose.x - midEye.x, eyeDist, 0);
    const ny = safeDiv(nose.y - midEye.y, eyeDist, 0);
    const yaw = clamp(nx * 2.4, -1, 1);
    const pitch = clamp(ny * 2.4, -1, 1);

    // mouth open
    const mouthOpenRatio = clamp(safeDiv(mouthOpen, calibrationState.base.faceScale || eyeDist, 0), 0, 0.9);

    // smile: mouth width + corner lift
    const cornerLift = clamp(((midEye.y - (leftMouth.y + rightMouth.y) * 0.5) - 0.08) * 4.0, -1, 1);
    const smileRatio = safeDiv(mouthWidth, calibrationState.base.mouthWidth || mouthWidth, 1);
    const smile = clamp01((smileRatio - 0.98) * 1.8 + (cornerLift + 0.2) * 0.25);

    // blink: compare to baseline eye openness
    const leftEyeOpen = dist2(lm[159], lm[145]);
    const rightEyeOpen = dist2(lm[386], lm[374]);
    const eyeOpen = (leftEyeOpen + rightEyeOpen) * 0.5;
    const eyeOpenBase = calibrationState.base.eyeOpen || eyeOpen;
    const blink = clamp01(1 - clamp(safeDiv(eyeOpen, eyeOpenBase, 1), 0.35, 1.4));

    // frown (brow gets closer to upper eyelid)
    const leftBrowEye = dist2(lm[105], lm[159]);
    const rightBrowEye = dist2(lm[334], lm[386]);
    const browEye = (leftBrowEye + rightBrowEye) * 0.5;
    const browEyeBase = calibrationState.base.browEye || browEye;
    const frown = clamp01((1 - clamp(safeDiv(browEye, browEyeBase, 1), 0.65, 1.3)) * 1.2);

    faceTarget.faceX = clamp(faceX, -1, 1);
    faceTarget.faceY = clamp(faceY, -1, 1);
    faceTarget.faceScale = faceScale;
    faceTarget.yaw = yaw;
    faceTarget.pitch = pitch;
    faceTarget.smile = smile;
    faceTarget.mouthOpen = clamp01(mouthOpenRatio * 1.7);
    faceTarget.blink = blink;
    faceTarget.frown = frown;

    if (calibrationState.active) {
      const t = clamp01((performance.now() - calibrationState.startedAt) / calibrationState.durationMs);
      calibBar.style.width = `${Math.round(t * 100)}%`;
      calibText.textContent = "检测人脸中…";
      setDot(calibDot, "good");

      calibrationState.samples += 1;
      calibrationState.base.eyeDist += eyeDist;
      calibrationState.base.mouthWidth += mouthWidth;
      calibrationState.base.faceScale += eyeDist;
      calibrationState.base.eyeOpen += eyeOpen;
      calibrationState.base.browEye += browEye;

      if (t >= 1) {
        const n = Math.max(1, calibrationState.samples);
        calibrationState.base.eyeDist /= n;
        calibrationState.base.mouthWidth /= n;
        calibrationState.base.faceScale /= n;
        calibrationState.base.eyeOpen /= n;
        calibrationState.base.browEye /= n;
        calibrationState.active = false;

        calibText.textContent = "校准完成";
        calibHint.textContent = "现在试试转头、微笑、张嘴。";
        setTimeout(() => calibration.classList.add("hidden"), 400);
        setTimeout(() => overlay.classList.add("hidden"), 650);
      }
    }
  }

  function faceLoop(now) {
    if (!faceTrackingEnabled || !faceMesh || !video) return;
    const interval = quality.faceFrameIntervalMs || 0;
    if (interval && now - faceLastSentAt < interval) {
      requestAnimationFrame(faceLoop);
      return;
    }
    if (faceBusy) {
      requestAnimationFrame(faceLoop);
      return;
    }
    faceBusy = true;
    faceLastSentAt = now;
    faceMesh
      .send({ image: video })
      .catch(() => {})
      .finally(() => {
        faceBusy = false;
        requestAnimationFrame(faceLoop);
      });
  }

  // ---- Three.js particles ----
  let renderer = null;
  let scene = null;
  let camera = null;
  let points = null;
  let headGroup = null;
  let geometry = null;
  let material = null;
  let fog = null;

  const MAX_PARTICLES = 16000;
  let activeParticleCount = 0;
  const basePositions = new Float32Array(MAX_PARTICLES * 3);
  const velocities = new Float32Array(MAX_PARTICLES * 3);
  const colors = new Float32Array(MAX_PARTICLES * 3);
  const ROLE = { FACE: 0, LEFT_EYE: 1, RIGHT_EYE: 2, MOUTH: 3 };
  const roles = new Uint8Array(MAX_PARTICLES); // ROLE.*
  const roleParamA = new Float32Array(MAX_PARTICLES); // role-specific 0..1
  const roleParamB = new Float32Array(MAX_PARTICLES); // role-specific jitter
  const roleParamC = new Float32Array(MAX_PARTICLES); // role-specific 0..1 (extra)
  const PARTICLE_BASE_SIZE = LITE_DEVICE ? 0.16 : 0.18;
  // Per-particle colors define the "Sphere glow" look; keep enabled and throttle on lite devices.
  let colorUpdateFlip = 0;

  let lastRenderAt = 0;
  let lastUpdateAt = 0;
  let lastBurstAt = 0;
  const burstCooldownMs = 620;

  // Shake-to-cycle detection
  let lastYawForShake = 0;
  let lastYawVelSign = 0;
  let shakeWindowStartAt = 0;
  let shakeSignChanges = 0;
  let shakeActiveUntil = 0;
  let shakeIntensity = 0;

  function setFogEnabled(enabled) {
    if (!scene) return;
    if (enabled) {
      if (!fog) fog = new THREE.FogExp2(0x04050a, 0.045);
      scene.fog = fog;
    } else {
      scene.fog = null;
    }
  }

  function ensureParticleCount(count) {
    activeParticleCount = Math.max(1200, Math.min(MAX_PARTICLES, count | 0));
    if (!geometry) return;
    geometry.setDrawRange(0, activeParticleCount);
  }

  function randBetween(a, b) {
    return a + (b - a) * Math.random();
  }

  function sampleInCircle(radius) {
    // uniform disk
    const t = Math.random() * Math.PI * 2;
    const r = Math.sqrt(Math.random()) * radius;
    return { x: Math.cos(t) * r, y: Math.sin(t) * r };
  }

  function sampleOnRing(radius, thickness) {
    const t = Math.random() * Math.PI * 2;
    const r = radius + randBetween(-thickness, thickness);
    return { x: Math.cos(t) * r, y: Math.sin(t) * r };
  }

  function sampleArc(radius, startAngle, endAngle, thickness) {
    const t = randBetween(startAngle, endAngle);
    const r = radius + randBetween(-thickness, thickness);
    return { x: Math.cos(t) * r, y: Math.sin(t) * r };
  }

  const SMILEY = {
    FACE_R: 12.0,
    // Tuned to resemble the Las Vegas Sphere emoji proportions:
    // eyes sit higher & wider; mouth sits lower.
    EYE_R: 1.9,
    // Move features down ~70% (relative to previous anchors)
    EYE_Y: -0.1,
    EYE_X: 4.1,
    MOUTH_R: 6.4,
    MOUTH_Y: -6.15,
    MOUTH_START: Math.PI * 1.18,
    MOUTH_END: Math.PI * 1.82,
    // Mickey-style ears (two spheres blended with the main head).
    EAR_R: 5.9,
    EAR_X: 8.7,
    EAR_Y: 9.4,
    EAR_SHARE: 0.28, // fraction of FACE particles that go to ears (0..1)
  };

  function clampIntoFaceXY(x, y) {
    const r = SMILEY.FACE_R * 0.96;
    const d = Math.hypot(x, y);
    if (d <= r || d === 0) return { x, y };
    const s = r / d;
    return { x: x * s, y: y * s };
  }

  function faceZFromXY(x, y) {
    const r2 = SMILEY.FACE_R * SMILEY.FACE_R;
    const d2 = x * x + y * y;
    const z2 = Math.max(0, r2 - d2);
    return Math.sqrt(z2); // front hemisphere (+z)
  }

  function generateSmiley() {
    // Smiley in XY plane with slight Z thickness.
    // Coordinate system: face centered at (0,0), radius ~ 12.
    const { FACE_R, EYE_R, EYE_Y, EYE_X, MOUTH_R, MOUTH_Y, MOUTH_START, MOUTH_END, EAR_R, EAR_X, EAR_Y, EAR_SHARE } =
      SMILEY;

    for (let i = 0; i < MAX_PARTICLES; i++) {
      const o = i * 3;

      // role distribution
      const p = Math.random();
      let role = ROLE.FACE;
      if (p < 0.08) role = ROLE.LEFT_EYE;
      else if (p < 0.16) role = ROLE.RIGHT_EYE;
      else if (p < 0.36) role = ROLE.MOUTH;
      else role = ROLE.FACE;
      roles[i] = role;

      let x = 0;
      let y = 0;
      let z = 0;

      if (role === ROLE.FACE) {
        // 3D head volume (sphere): mostly surface shell + some interior fill.
        // Slightly bias points to the front so the face reads clearly, while still looking like a ball.
        // Optionally blend in "Mickey ears" (two smaller spheres above the head).
        let cx = 0;
        let cy = 0;
        let r0 = FACE_R;
        if (MICKEY_EARS_ENABLED && Math.random() < EAR_SHARE) {
          const side = Math.random() < 0.5 ? -1 : 1;
          cx = side * EAR_X;
          cy = EAR_Y;
          r0 = EAR_R;
        }

        const theta = Math.random() * Math.PI * 2;
        const zDir0 = Math.random() * 2 - 1; // -1..1
        const rxy = Math.sqrt(Math.max(0, 1 - zDir0 * zDir0));
        let dirX = rxy * Math.cos(theta);
        let dirY = rxy * Math.sin(theta);
        let dirZ = zDir0;
        if (Math.random() < 0.58) dirZ = Math.abs(dirZ);

        const surface = Math.random() < 0.55;
        const baseR = surface ? r0 + randBetween(-0.2, 0.2) : r0 * Math.cbrt(Math.random()) * 0.98;
        x = cx + dirX * baseR;
        y = cy + dirY * baseR;
        z = dirZ * baseR;
        roleParamA[i] = Math.random();
        roleParamB[i] = Math.random();
      } else if (role === ROLE.LEFT_EYE || role === ROLE.RIGHT_EYE) {
        // Eye particles: filled circle (cute "dot" eye). roleParamA=angleU, roleParamB=radiusU.
        const isLeft = role === ROLE.LEFT_EYE;
        const angleU = Math.random();
        const radiusU = Math.random();
        const angle = angleU * Math.PI * 2;
        const r = Math.sqrt(radiusU) * EYE_R * 0.95;
        x = Math.cos(angle) * r + (isLeft ? -EYE_X : EYE_X);
        y = Math.sin(angle) * r + EYE_Y;
        ({ x, y } = clampIntoFaceXY(x, y));
        z = faceZFromXY(x, y) - randBetween(0.55, 0.9);
        roleParamA[i] = angleU;
        roleParamB[i] = radiusU;
      } else if (role === ROLE.MOUTH) {
        // Mouth particles: thick smile band. Stored as u along arc + thickness seed.
        // roleParamA: x/u (0..1), roleParamB: fill (0..1), roleParamC: seed (0..1)
        const u = Math.random();
        const v = Math.random();
        const seed = Math.random();
        // seed a reasonable initial "smile band" placement (final shape computed in update loop)
        const theta = lerp(MOUTH_START, MOUTH_END, u);
        const thickness = (seed - 0.5) * 0.65;
        const r = MOUTH_R + thickness;
        x = Math.cos(theta) * r;
        y = Math.sin(theta) * r + MOUTH_Y + thickness * 0.12;
        ({ x, y } = clampIntoFaceXY(x, y));
        z = faceZFromXY(x, y) - randBetween(0.65, 1.05);
        roleParamA[i] = u;
        roleParamB[i] = v;
        roleParamC[i] = seed;
      }

      basePositions[o] = x;
      basePositions[o + 1] = y;
      basePositions[o + 2] = z;

      velocities[o] = (Math.random() - 0.5) * 0.02;
      velocities[o + 1] = (Math.random() - 0.5) * 0.02;
      velocities[o + 2] = (Math.random() - 0.5) * 0.02;

      // init colors (will be overwritten in update loop)
      colors[o] = 0.75;
      colors[o + 1] = 0.8;
      colors[o + 2] = 1.0;
    }
  }

  function applyQuality(tier) {
    qualityTier = tier;
    quality = QUALITY_PRESETS[qualityTier];
    if (LITE_DEVICE) {
      quality = {
        ...quality,
        particleCount: Math.min(quality.particleCount, 3000),
        maxPixelRatio: 1,
        antialias: false,
        fog: false,
        depthTest: false,
        renderIntervalMs: Math.max(quality.renderIntervalMs || 0, 40),
        particleUpdateIntervalMs: Math.max(quality.particleUpdateIntervalMs || 0, 40),
        // WeChat/iPad Pro 1 can "stall" FaceMesh; keep requests reasonably frequent.
        faceFrameIntervalMs: Math.max(quality.faceFrameIntervalMs || 0, 80),
      };
    }
    envText.textContent = `${IS_WECHAT ? "微信内置浏览器" : "系统浏览器"} · ${qualityTier.toUpperCase()}`;
    setDot(envPill.querySelector(".dot"), qualityTier === "high" ? "good" : qualityTier === "low" ? "bad" : "");
    if (renderer) {
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, quality.maxPixelRatio));
      renderer.setSize(window.innerWidth, window.innerHeight, false);
    }
    setFogEnabled(quality.fog);
    if (material) {
      material.depthTest = !!quality.depthTest;
      material.needsUpdate = true;
    }
    const targetCount = Math.floor(quality.particleCount * particleStrength);
    ensureParticleCount(targetCount);
  }

  function initThree() {
    renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: quality.antialias,
      alpha: true,
      powerPreference: "high-performance",
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, quality.maxPixelRatio));
    renderer.setSize(window.innerWidth, window.innerHeight, false);

    scene = new THREE.Scene();
    setFogEnabled(quality.fog);

    camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 2000);
    camera.position.set(0, 1.2, 32);

    generateSmiley();

    geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(MAX_PARTICLES * 3), 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    geometry.setDrawRange(0, 1);

    material = new THREE.PointsMaterial({
      size: PARTICLE_BASE_SIZE,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
      depthTest: !!quality.depthTest,
      blending: THREE.AdditiveBlending,
      vertexColors: wantsColors,
      sizeAttenuation: true,
      color: wantsColors ? 0xffffff : baseColorHex,
    });
    applyColorMode(colorMode);

    points = new THREE.Points(geometry, material);
    headGroup = new THREE.Group();
    headGroup.rotation.order = "YXZ";
    headGroup.add(points);
    // Rotate around the "neck" so it behaves like a mirror head swing.
    points.position.set(0, SMILEY.FACE_R * 0.65, 0);
    headGroup.position.set(0, -points.position.y, 0);
    scene.add(headGroup);

    applyQuality(getSelectedTier());
    onResize();
  }

  function onResize() {
    if (!renderer || !camera) return;
    const w = window.innerWidth;
    const h = window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  window.addEventListener("resize", onResize, { passive: true });

  function updateTrackingSmooth(dt) {
    const s = clamp01(dt * 7.5);
    const relax = faceState.hasFace ? 0.18 : 0.08;
    const rotS = faceState.hasFace ? 0.22 : 0.12;
    faceSmooth.faceX = lerp(faceSmooth.faceX, faceTarget.faceX, s * relax);
    faceSmooth.faceY = lerp(faceSmooth.faceY, faceTarget.faceY, s * relax);
    faceSmooth.faceScale = lerp(faceSmooth.faceScale, faceTarget.faceScale, s * 0.12);
    faceSmooth.yaw = lerp(faceSmooth.yaw, faceTarget.yaw, s * rotS);
    faceSmooth.pitch = lerp(faceSmooth.pitch, faceTarget.pitch, s * rotS);
    faceSmooth.smile = lerp(faceSmooth.smile, faceTarget.smile, s * 0.16);
    faceSmooth.mouthOpen = lerp(faceSmooth.mouthOpen, faceTarget.mouthOpen, s * 0.22);
    faceSmooth.blink = lerp(faceSmooth.blink, faceTarget.blink, s * 0.25);
    faceSmooth.frown = lerp(faceSmooth.frown, faceTarget.frown, s * 0.18);
  }

  function triggerBurst(intensity) {
    const now = performance.now();
    if (now - lastBurstAt < burstCooldownMs) return;
    lastBurstAt = now;
    const strength = clamp01(intensity);
    for (let i = 0; i < activeParticleCount; i++) {
      const o = i * 3;
      const bx = basePositions[o];
      const by = basePositions[o + 1];
      const bz = basePositions[o + 2];
      const len = Math.hypot(bx, by, bz) || 1;
      const nx = bx / len;
      const ny = by / len;
      const nz = bz / len;
      velocities[o] += nx * (0.28 + strength * 0.55) * (0.4 + Math.random() * 0.6);
      velocities[o + 1] += ny * (0.22 + strength * 0.5) * (0.4 + Math.random() * 0.6);
      velocities[o + 2] += nz * (0.28 + strength * 0.55) * (0.4 + Math.random() * 0.6);
    }
  }

  function updateParticles(dt, now) {
    if (!geometry) return;
    const pos = geometry.attributes.position.array;

    const m = mode;
    const sens = sensitivity;
    const hasFace = faceState.hasFace && faceTrackingEnabled;

    // Mirror-mode mapping: left-right on screen matches the user's "mirror" intuition.
    const mirrorSign = MIRROR_MODE ? -1 : 1;
    const yaw = (hasFace ? faceSmooth.yaw : 0) * mirrorSign;
    const pitch = hasFace ? faceSmooth.pitch : 0;
    const fx = (hasFace ? faceSmooth.faceX : 0) * mirrorSign;
    const fy = hasFace ? faceSmooth.faceY : 0;
    const scale = hasFace ? faceSmooth.faceScale : 1.0;
    const smile = hasFace ? faceSmooth.smile : 0.2;
    const mouthOpen = hasFace ? faceSmooth.mouthOpen : 0.0;
    const blink = hasFace ? faceSmooth.blink : 0.0;
    const frown = hasFace ? faceSmooth.frown : 0.0;

    const smileEffective = clamp01(smile - frown * 0.75);
    const warm = clamp01(smileEffective * 1.05);
    const energy = clamp01(mouthOpen * 1.2 + blink * 0.6);
    const openBlend = clamp01((mouthOpen - 0.12) / 0.55);
    // More sensitive eye reaction for kids: blink drives eye change sooner/stronger.
    const blinkBlend = clamp01((blink - 0.05) / 0.32);

    // Continuous head shake -> hue cycle
    if (hasFace) {
      const safeDt = Math.max(0.006, dt);
      const yawVel = (yaw - lastYawForShake) / safeDt;
      lastYawForShake = yaw;

      const absYawVel = Math.abs(yawVel);
      const velSign = Math.sign(yawVel);
      if (absYawVel > 0.85 && velSign !== 0) {
        if (!shakeWindowStartAt || now - shakeWindowStartAt > 1200) {
          shakeWindowStartAt = now;
          shakeSignChanges = 0;
        }
        if (lastYawVelSign !== 0 && velSign !== lastYawVelSign) {
          shakeSignChanges += 1;
          shakeActiveUntil = now + 1400;
        }
        lastYawVelSign = velSign;
      }

      const velIntensity = clamp01((absYawVel - 0.85) / 2.2);
      shakeIntensity = lerp(shakeIntensity, velIntensity, clamp01(dt * 6));
    } else {
      shakeIntensity = lerp(shakeIntensity, 0, clamp01(dt * 2.5));
    }

    hueCycleEnabled = now < shakeActiveUntil && shakeSignChanges >= 2;
    if (hueCycleEnabled) {
      const speed = 0.14 + 0.34 * shakeIntensity + 0.08 * Math.min(6, shakeSignChanges);
      hueOffset = (hueOffset + dt * speed) % 1;
    }

    if (modeSelect.value === "burst" && mouthOpen > 0.58) triggerBurst(mouthOpen);

    const pull = lerp(0.18, 0.42, clamp01((scale - 0.9) * 1.4)) * sens;
    const scatter = lerp(0.08, 0.26, clamp01((1.1 - scale) * 1.2)) * sens;

    const windX = 0;
    const windY = 0;

    const drift = m.drift + energy * 0.2;
    const cohesion = m.cohesion + pull * 0.25 + frown * 0.18;

    // Throttle expensive color updates on iPad Pro 1 / WeChat.
    const doColors = wantsColors && (!LITE_DEVICE || (colorUpdateFlip = colorUpdateFlip ^ 1) === 1);

    // Sphere-style glow palette (gold <-> cyan) with faux lighting.
    const GOLD_H = 0.12; // ~yellow
    const CYAN_H = 0.53; // ~cyan
    const lightDir = { x: 0.58, y: 0.32, z: 1.0 };
    const lightLen = Math.hypot(lightDir.x, lightDir.y, lightDir.z) || 1;
    lightDir.x /= lightLen;
    lightDir.y /= lightLen;
    lightDir.z /= lightLen;

    for (let i = 0; i < activeParticleCount; i++) {
      const o = i * 3;
      const role = roles[i];
      const u = roleParamA[i];
      const jitter = roleParamB[i] || 1;
      let bx0 = basePositions[o];
      let by0 = basePositions[o + 1];
      let bz0 = basePositions[o + 2];

      // Shape morphing: mouth / eyes react to expression
      if (role === ROLE.MOUTH) {
        // Mouth is ALWAYS a closed shape:
        // - default/smile/frown: a closed "crescent band" (lens-like) that meets at the corners
        // - open mouth: a closed filled oval ("O/ah")
        const uX = u; // 0..1
        const vFill = roleParamB[i] ?? 0.5; // 0..1
        const seed = roleParamC[i] ?? 0.5; // 0..1

        const xN = (uX - 0.5) * 2; // -1..1
        const curve = Math.pow(Math.max(0, 1 - xN * xN), 0.72);
        const mood = clamp(smileEffective - frown * 1.1, -1, 1); // >0 smile, <0 sad

        const rxSmile = SMILEY.MOUTH_R * (0.78 + Math.max(0, mood) * 0.06 - Math.max(0, -mood) * 0.08);
        const amp = (0.95 + Math.abs(mood) * 0.55) * (mood >= 0 ? 1 : -1);
        const bottom = curve * amp;
        const thickness = (0.35 + seed * 0.35) * curve * (1 - openBlend * 0.45);
        const top = bottom - thickness;

        const centerY = SMILEY.MOUTH_Y - openBlend * 1.05 - frown * 0.3;
        const smileX = xN * rxSmile;
        const smileY = lerp(top, bottom, vFill) + centerY;

        // Open mouth (filled oval), closed shape
        const ang = uX * Math.PI * 2;
        const rr = Math.sqrt(clamp01(vFill));
        const rxO = SMILEY.MOUTH_R * (0.52 + Math.max(0, mood) * 0.06);
        const ryO = SMILEY.MOUTH_R * (0.2 + openBlend * 0.62);
        const openX = Math.cos(ang) * rxO * rr;
        const openY = Math.sin(ang) * ryO * rr + (SMILEY.MOUTH_Y - openBlend * 1.2 - frown * 0.25);

        bx0 = lerp(smileX, openX, openBlend);
        by0 = lerp(smileY, openY, openBlend);
        const clamped = clampIntoFaceXY(bx0, by0);
        bx0 = clamped.x;
        by0 = clamped.y;
        bz0 = faceZFromXY(bx0, by0) - lerp(1.05, 0.42, openBlend);
      } else if (role === ROLE.LEFT_EYE || role === ROLE.RIGHT_EYE) {
        // Sphere-style eye: open = closed ring (with some fill); blink = very flat closed oval (not an open curve).
        const cx = role === ROLE.LEFT_EYE ? -SMILEY.EYE_X : SMILEY.EYE_X;
        const cy = SMILEY.EYE_Y;

        const angleU = u;
        const radiusU = roleParamB[i] ?? 0.6;
        const angle = angleU * Math.PI * 2;
        const ringOuter = SMILEY.EYE_R * (0.98 + (1 - openBlend) * 0.08);
        const ringInner = SMILEY.EYE_R * (0.55 + openBlend * 0.1);
        const ringR = lerp(ringInner, ringOuter, Math.sqrt(clamp01(radiusU)));
        const openX = Math.cos(angle) * ringR;
        const openY = Math.sin(angle) * ringR;

        const blinkRx = SMILEY.EYE_R * 1.55;
        const blinkRy = SMILEY.EYE_R * 0.18;
        const blinkX = Math.cos(angle) * blinkRx;
        const blinkY = Math.sin(angle) * blinkRy - 0.12;

        const ex = lerp(openX, blinkX, blinkBlend);
        const ey = lerp(openY, blinkY, blinkBlend);

        bx0 = cx + ex;
        by0 = cy + ey;
        const clamped = clampIntoFaceXY(bx0, by0);
        bx0 = clamped.x;
        by0 = clamped.y;
        // blink => become a shallow arc close to the surface
        bz0 = faceZFromXY(bx0, by0) - lerp(0.9, 0.38, blinkBlend);
      } else {
        const facePulse = 1 + smileEffective * 0.03 + mouthOpen * 0.05 - frown * 0.02;
        bx0 *= facePulse;
        by0 *= facePulse;
      }

      // local-space targets (head rotation is applied at group level)
      let bx = bx0;
      let by = by0;
      let bz = bz0;

      // target radius modulation (closer => slightly tighter)
      const targetScale = lerp(1.06, 0.88, clamp01((scale - 1) * 0.9)) + energy * 0.06;
      bx *= targetScale;
      by *= targetScale;
      bz *= targetScale;

      const vx = velocities[o];
      const vy = velocities[o + 1];
      const vz = velocities[o + 2];

      // attraction to target + wind
      const tx = bx + fx * 2.2 + windX * 1.3;
      const ty = by - fy * 1.8 + windY * 1.1;
      const tz = bz;

      const px = pos[o];
      const py = pos[o + 1];
      const pz = pos[o + 2];

      const ax = (tx - px) * (0.014 + cohesion * 0.012) - px * scatter * 0.002;
      const ay = (ty - py) * (0.014 + cohesion * 0.012) - py * scatter * 0.002;
      const az = (tz - pz) * (0.014 + cohesion * 0.012) - pz * scatter * 0.002;

      velocities[o] = (vx + ax + (Math.random() - 0.5) * 0.002 * drift) * 0.985;
      velocities[o + 1] = (vy + ay + (Math.random() - 0.5) * 0.002 * drift) * 0.985;
      velocities[o + 2] = (vz + az + (Math.random() - 0.5) * 0.002 * drift) * 0.985;

      pos[o] = px + velocities[o];
      pos[o + 1] = py + velocities[o + 1];
      pos[o + 2] = pz + velocities[o + 2];

      if (doColors) {
        const c = i * 3;
        const sparkle = (0.78 + m.sparkle * 0.22) * (0.72 + energy * 0.55) * (0.9 + (u - 0.5) * 0.14);
        const mouthBoost = 1 + openBlend * 0.22 + warm * 0.16 + energy * 0.18;
        const eyeDim = 1 - blinkBlend * 0.35;
        const nx = bx || 0;
        const ny = by || 0;
        const nz = bz || 0;
        const nlen = Math.hypot(nx, ny, nz) || 1;
        const nX = nx / nlen;
        const nY = ny / nlen;
        const nZ = nz / nlen;

        const ndl = clamp01(nX * lightDir.x + nY * lightDir.y + nZ * lightDir.z);
        const rim = Math.pow(1 - clamp01(nZ), 2.2);
        const glow = clamp01(0.22 + ndl * 1.02 + rim * 0.85);

        // bias hue by side: right side tends to cyan in the reference image
        const side = clamp01(0.5 + nX * 0.65);
        const hue = (GOLD_H + (CYAN_H - GOLD_H) * side + hueOffset) % 1;
        const sat = clamp01(0.86 + 0.1 * ndl);
        const lit = clamp01(0.44 + 0.28 * glow);
        tmpColor.setHSL((hue + 1) % 1, sat, lit);
        let r = tmpColor.r;
        let g = tmpColor.g;
        let b = tmpColor.b;

        if (role === ROLE.MOUTH) {
          const mouthDarken = 1 - openBlend * 0.28;
          const mouthGlow = 1.45 + smileEffective * 0.55;
          r *= mouthBoost * mouthDarken * mouthGlow;
          g *= mouthBoost * mouthDarken * mouthGlow;
          b *= mouthBoost * mouthDarken * mouthGlow;
        } else if (role === ROLE.LEFT_EYE || role === ROLE.RIGHT_EYE) {
          const eyeGlow = 1.35 + (1 - blinkBlend) * 0.25;
          r *= eyeDim * eyeGlow;
          g *= eyeDim * eyeGlow;
          b *= eyeDim * eyeGlow;
        }

        r = clamp01(r * sparkle * glow);
        g = clamp01(g * sparkle * glow);
        b = clamp01(b * sparkle * glow);

        colors[c] = lerp(colors[c], r, 0.04);
        colors[c + 1] = lerp(colors[c + 1], g, 0.04);
        colors[c + 2] = lerp(colors[c + 2], b, 0.04);
      }
    }

    geometry.attributes.position.needsUpdate = true;
    if (doColors) geometry.attributes.color.needsUpdate = true;
  }

  function animate(now) {
    requestAnimationFrame(animate);
    if (!renderer || !scene || !camera) return;

    const renderInterval = quality.renderIntervalMs || 0;
    if (renderInterval && now - lastRenderAt < renderInterval) return;

    const dt = Math.min(0.05, (now - lastRenderAt) / 1000 || 0.016);
    lastRenderAt = now;

    updateTrackingSmooth(dt);

    const updateInterval = quality.particleUpdateIntervalMs || 0;
    if (!updateInterval || now - lastUpdateAt >= updateInterval) {
      lastUpdateAt = now;
      updateParticles(dt, now);
    }

    // Head pose: shake/nod/swing around the "neck" pivot.
    if (headGroup) {
      const hasFace = faceState.hasFace && faceTrackingEnabled;
      const mirrorSign = MIRROR_MODE ? -1 : 1;
      const yaw = (hasFace ? faceSmooth.yaw : 0) * mirrorSign;
      const pitch = hasFace ? faceSmooth.pitch : 0;

      // Convert normalized yaw/pitch (-1..1) into radians.
      const targetYaw = clamp(yaw, -1, 1) * 0.85; // ~49°
      const targetPitch = clamp(pitch, -1, 1) * -0.65; // ~37° (negative feels like nod-down)
      headGroup.rotation.y = lerp(headGroup.rotation.y, targetYaw, clamp01(dt * 6));
      headGroup.rotation.x = lerp(headGroup.rotation.x, targetPitch, clamp01(dt * 6));

      // Distance interaction: closer to camera => larger head/particles; farther => smaller.
      const faceScale = hasFace ? faceSmooth.faceScale : 1.0; // calibrated eye distance ratio
      // Amplify response so small distance changes are visible (kids move subtly).
      const t0 = clamp01((faceScale - 0.78) / 0.55);
      const t = Math.pow(t0, 0.65); // ease-out: more sensitive near the middle
      const minS = LITE_DEVICE ? 0.82 : 0.72;
      const maxS = LITE_DEVICE ? 1.48 : 1.82;
      const targetS = lerp(minS, maxS, t);
      const sNow = headGroup.scale.x || 1;
      const nextS = lerp(sNow, targetS, clamp01(dt * 5.5));
      headGroup.scale.set(nextS, nextS, nextS);

      // Subtle depth shift so it feels like moving in/out (kept small to avoid clipping).
      const targetZ = lerp(1.4, -1.2, t);
      headGroup.position.z = lerp(headGroup.position.z, targetZ, clamp01(dt * 4));

      if (material) {
        const baseSize = PARTICLE_BASE_SIZE;
        const sizeMin = LITE_DEVICE ? 0.86 : 0.78;
        const sizeMax = LITE_DEVICE ? 1.55 : 1.75;
        const targetSize = baseSize * lerp(sizeMin, sizeMax, t);
        material.size = lerp(material.size || baseSize, targetSize, clamp01(dt * 5));
      }
    }

    renderer.render(scene, camera);
  }

  // ---- UI / wiring ----
  const happiVoice = voiceDock ? new HappiRealtimeVoice() : null;
  if (happiVoice) {
    try {
      happiVoice.setStatus("未连接", "");
    } catch {}
    if (voiceMicBtn) voiceMicBtn.disabled = false;

    const showVoiceDock = () => voiceDock && voiceDock.classList.remove("hidden");

    const connectIfNeeded = async () => {
      if (!happiVoice || happiVoice.wsReady) return;
      try {
        await happiVoice.connect();
      } catch (err) {
        const msg = err?.message || String(err);
        happiVoice.setError(msg);
        showToast(msg);
      }
    };

    let isHoldingMic = false;

    const startHold = (e) => {
      e.preventDefault();
      e.stopPropagation();
      isHoldingMic = true;
      if (!happiVoice.wsReady) {
        if (happiVoice.connecting) return;
        // First interaction: connect on demand (also a valid user gesture for mic permission on iOS).
        showToast("连接中…");
        connectIfNeeded().then(() => {
          if (!isHoldingMic) return;
          if (!happiVoice.wsReady) return;
          if (voiceMicBtn) voiceMicBtn.classList.add("talking");
          happiVoice.startCapture();
        });
        return;
      }
      if (voiceMicBtn) voiceMicBtn.classList.add("talking");
      happiVoice.startCapture();
    };
    const endHold = (e) => {
      e.preventDefault();
      e.stopPropagation();
      isHoldingMic = false;
      if (!happiVoice.wsReady) return;
      if (voiceMicBtn) voiceMicBtn.classList.remove("talking");
      happiVoice.stopCaptureAndRespond();
    };

    if (voiceMicBtn) {
      if ("PointerEvent" in window) {
        voiceMicBtn.addEventListener("pointerdown", startHold);
        voiceMicBtn.addEventListener("pointerup", endHold);
        voiceMicBtn.addEventListener("pointercancel", endHold);
      } else {
        voiceMicBtn.addEventListener("touchstart", startHold, { passive: false });
        voiceMicBtn.addEventListener("touchend", endHold, { passive: false });
        voiceMicBtn.addEventListener("touchcancel", endHold, { passive: false });
        voiceMicBtn.addEventListener("mousedown", startHold);
        voiceMicBtn.addEventListener("mouseup", endHold);
      }
    }

    if (voiceDock) voiceDock.addEventListener("pointerdown", (e) => e.stopPropagation());

    // Expose for internal calls (auto-start after "开始玩")
    happiVoice._showDock = showVoiceDock;
    happiVoice._connectIfNeeded = connectIfNeeded;
  }

  function setTrackingStatus() {
    if (!trackDot || !trackText) return;
    if (!faceTrackingEnabled) {
      setDot(trackDot, "bad");
      trackText.textContent = "演示模式（无追踪）";
      return;
    }
    if (!faceState.ok) {
      setDot(trackDot, "bad");
      trackText.textContent = "追踪未就绪";
      return;
    }
    if (!faceState.hasFace) {
      setDot(trackDot, "");
      trackText.textContent = "未检测到人脸";
      return;
    }
    setDot(trackDot, "good");
    trackText.textContent = "追踪中";
  }

  let panelVisible = false;
  let lastToggleAt = 0;
  function togglePanel(show) {
    panelVisible = typeof show === "boolean" ? show : !panelVisible;
    panel.classList.toggle("hidden", !panelVisible);
  }

  function updateMode() {
    mode = MODE_PRESETS[modeSelect.value] || MODE_PRESETS.resonance;
  }

  function requestFullscreen() {
    if (IS_WECHAT) {
      showToast("微信内置浏览器通常不支持全屏，建议在浏览器打开");
      return;
    }
    const el = document.documentElement;
    const fn = el.requestFullscreen || el.webkitRequestFullscreen || el.msRequestFullscreen;
    if (fn) fn.call(el).catch(() => {});
  }

  function togglePreview() {
    // Preview window is intentionally disabled for the kid-friendly UI.
    video.style.opacity = "0";
  }

  modeSelect.addEventListener("change", updateMode);
  sensitivityRange.addEventListener("input", () => (sensitivity = Number(sensitivityRange.value) || 1));
  particleRange.addEventListener("input", () => {
    particleStrength = Number(particleRange.value) || 1;
    ensureParticleCount(Math.floor(quality.particleCount * particleStrength));
  });
  if (colorPicker) {
    colorPicker.addEventListener("input", () => {
      baseColorHex = colorPicker.value || "#9bb7ff";
      refreshBaseColor();
      if (material && !wantsColors) {
        material.color = new THREE.Color(baseColorHex);
        material.needsUpdate = true;
      }
      applyColorMode("solid");
    });
  }
  if (colorGlowBtn) {
    colorGlowBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      applyColorMode("glow");
      showToast("颜色");
    });
  }
  if (colorSolidBtn) {
    colorSolidBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      applyColorMode("solid");
      showToast("颜色");
    });
  }
  if (swatchButtons.length) {
    swatchButtons.forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const c = (btn.dataset.color || "").trim();
        if (!c) return;
        baseColorHex = c;
        if (colorPicker) colorPicker.value = c;
        refreshBaseColor();
        applyColorMode("solid");
        showToast("颜色");
      });
    });
  }

  qualitySelect.addEventListener("change", async () => {
    const tier = getSelectedTier();
    applyQuality(tier);
    showToast(`已切换性能档位：${tier.toUpperCase()}`);
    envText.textContent = `${IS_WECHAT ? "微信内置浏览器" : "系统浏览器"} · ${qualityTier.toUpperCase()}`;
    setDot(envPill.querySelector(".dot"), qualityTier === "high" ? "good" : qualityTier === "low" ? "bad" : "");
    if (faceMesh) {
      try {
        faceMesh.setOptions({
          maxNumFaces: 1,
          refineLandmarks: !!quality.refineLandmarks,
          minDetectionConfidence: 0.5,
          minTrackingConfidence: 0.5,
        });
      } catch {}
    }
    if (faceTrackingEnabled) {
      try {
        stopCamera();
        await initCamera();
      } catch {}
    }
  });

  fullscreenBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    requestFullscreen();
  });
  if (togglePreviewBtn) {
    togglePreviewBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      togglePreview();
    });
  }

  panel.addEventListener("pointerdown", (e) => e.stopPropagation());

  function onCanvasToggle() {
    const now = performance.now();
    if (now - lastToggleAt < 250) return;
    lastToggleAt = now;
    togglePanel();
  }

  const supportsPointer = "PointerEvent" in window;
  if (supportsPointer) {
    canvas.addEventListener("pointerdown", onCanvasToggle, { passive: true });
  } else {
    canvas.addEventListener("touchstart", onCanvasToggle, { passive: true });
    canvas.addEventListener("click", onCanvasToggle);
  }

  if (helpBtn) {
    helpBtn.addEventListener("click", () => {
      helpText.style.display = helpText.style.display === "none" ? "block" : "none";
    });
  }

  async function startExperience({ demoOnly }) {
    startBtn.disabled = true;
    if (demoBtn) demoBtn.disabled = true;
    if (helpBtn) helpBtn.disabled = true;

    applyQuality(getSelectedTier());
    initThree();
    requestAnimationFrame(animate);

    if (demoOnly) {
      faceTrackingEnabled = false;
      overlay.classList.add("hidden");
      setTrackingStatus();
      showToast("已进入演示模式");
      if (happiVoice) {
        happiVoice._showDock?.();
        happiVoice._connectIfNeeded?.();
      }
      return;
    }

    resetCalibration();
    calibText.textContent = "请求摄像头权限…";

    try {
      await initCamera();
      ensureFaceMeshReady();
      faceTrackingEnabled = true;
      // Always keep the camera preview hidden (no top-right mini window).
      video.style.opacity = "0";
      setTrackingStatus();
      requestAnimationFrame(faceLoop);
      if (happiVoice) {
        happiVoice._showDock?.();
        happiVoice._connectIfNeeded?.();
      }
      if (LITE_DEVICE) {
        const startedAt = performance.now();
        const t = setInterval(() => {
          if (!calibrationState.active) {
            clearInterval(t);
            return;
          }
          const waited = performance.now() - startedAt;
          if (waited > 1800 && lastFaceResultAt === 0) {
            calibText.textContent = "加载中…（微信/iPad 可能较慢）";
            calibHint.textContent = "请保持页面不切换，稍等片刻。";
            clearInterval(t);
          }
        }, 300);
      }
    } catch (err) {
      faceTrackingEnabled = false;
      setTrackingStatus();
      showToast("摄像头不可用，已切换到演示模式");
      console.warn(err);
      stopCamera();
      overlay.classList.add("hidden");
    }
  }

  startBtn.addEventListener("click", () => startExperience({ demoOnly: false }));
  if (demoBtn) demoBtn.addEventListener("click", () => startExperience({ demoOnly: true }));

  // polling status (only if the HUD tracking pill exists)
  if (trackDot && trackText) setInterval(setTrackingStatus, 250);

  // initial state
  updateMode();
  video.style.opacity = "0";
  setTrackingStatus();
  applyColorMode(colorMode);

  // Prewarm FaceMesh assets on slow environments to avoid long "calibration" stalls.
  if (LITE_DEVICE) {
    try {
      ensureFaceMeshReady();
    } catch {}
  }
})();
