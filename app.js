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
      depthTest: true,
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
      depthTest: true,
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
  const fullscreenBtn = document.getElementById("fullscreenBtn");
  const togglePreviewBtn = document.getElementById("togglePreviewBtn");

  const trackDot = document.getElementById("trackDot");
  const trackText = document.getElementById("trackText");
  const toast = document.getElementById("toast");

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

  function refreshBaseColor() {
    baseColor.set(baseColorHex || "#9bb7ff");
    baseColor.getHSL(baseHsl);
  }
  refreshBaseColor();

  // Camera + FaceMesh
  let stream = null;
  let faceMesh = null;
  let faceBusy = false;
  let faceLastSentAt = 0;
  let faceTrackingEnabled = false;

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

  const dist2 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const safeDiv = (a, b, fallback = 0) => (!b || !Number.isFinite(b) ? fallback : a / b);

  function onFaceResults(results) {
    faceState.ok = true;
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
  const ROLE = {
    FACE: 0,
    LEFT_EYE: 1,
    RIGHT_EYE: 2,
    MOUTH: 3,
    LEFT_CHEEK: 4,
    RIGHT_CHEEK: 5,
  };
  const roles = new Uint8Array(MAX_PARTICLES); // ROLE.*
  const roleParamA = new Float32Array(MAX_PARTICLES); // role-specific 0..1
  const roleParamB = new Float32Array(MAX_PARTICLES); // role-specific jitter
  // Per-particle colors are expensive on older iPads / WeChat browser.
  let wantsColors = !LITE_DEVICE;

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
    EYE_R: 1.7,
    EYE_Y: 3.0,
    EYE_X: 4.2,
    MOUTH_R: 6.2,
    MOUTH_Y: -2.4,
    MOUTH_START: Math.PI * 1.18,
    MOUTH_END: Math.PI * 1.82,
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
    const { FACE_R, EYE_R, EYE_Y, EYE_X, MOUTH_R, MOUTH_Y, MOUTH_START, MOUTH_END } = SMILEY;

    for (let i = 0; i < MAX_PARTICLES; i++) {
      const o = i * 3;

      // role distribution
      const p = Math.random();
      let role = ROLE.FACE;
      if (p < 0.08) role = ROLE.LEFT_EYE;
      else if (p < 0.16) role = ROLE.RIGHT_EYE;
      else if (p < 0.36) role = ROLE.MOUTH;
      else if (p < 0.45) role = ROLE.LEFT_CHEEK;
      else if (p < 0.54) role = ROLE.RIGHT_CHEEK;
      else role = ROLE.FACE;
      roles[i] = role;

      let x = 0;
      let y = 0;
      let z = 0;

      if (role === ROLE.FACE) {
        // 3D head volume (sphere): mostly surface shell + some interior fill.
        // Slightly bias points to the front so the face reads clearly, while still looking like a ball.
        const theta = Math.random() * Math.PI * 2;
        const zDir0 = Math.random() * 2 - 1; // -1..1
        const rxy = Math.sqrt(Math.max(0, 1 - zDir0 * zDir0));
        let dirX = rxy * Math.cos(theta);
        let dirY = rxy * Math.sin(theta);
        let dirZ = zDir0;
        if (Math.random() < 0.58) dirZ = Math.abs(dirZ);

        const surface = Math.random() < 0.8;
        const baseR = surface ? FACE_R + randBetween(-0.25, 0.25) : FACE_R * Math.cbrt(Math.random()) * 0.95;
        x = dirX * baseR;
        y = dirY * baseR;
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
        // Mouth particles: closed "bean/oval" on the front surface. roleParamA=angleU, roleParamB=fillU (outline vs fill).
        const angleU = Math.random();
        const fillU = Math.random();
        const angle = angleU * Math.PI * 2;
        const outline = fillU < 0.55;
        const rr = outline ? 1 : Math.sqrt((fillU - 0.55) / 0.45);
        const rx = MOUTH_R * rr;
        const ry = (MOUTH_R * 0.62) * rr;
        x = Math.cos(angle) * rx;
        y = Math.sin(angle) * ry + MOUTH_Y;
        ({ x, y } = clampIntoFaceXY(x, y));
        z = faceZFromXY(x, y) - randBetween(0.65, 1.05);
        roleParamA[i] = angleU;
        roleParamB[i] = fillU;
      } else if (role === ROLE.LEFT_CHEEK || role === ROLE.RIGHT_CHEEK) {
        // Cheek blush: two small soft clusters that pop out when smiling.
        const isLeft = role === ROLE.LEFT_CHEEK;
        const pt = sampleInCircle(1.25);
        x = pt.x + (isLeft ? -6.4 : 6.4);
        y = pt.y - 0.8;
        ({ x, y } = clampIntoFaceXY(x, y));
        z = faceZFromXY(x, y) - randBetween(0.8, 1.4);
        roleParamA[i] = Math.random();
        roleParamB[i] = Math.random();
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
        particleCount: Math.min(quality.particleCount, 3600),
        maxPixelRatio: 1,
        antialias: false,
        fog: false,
        renderIntervalMs: Math.max(quality.renderIntervalMs || 0, 33),
        particleUpdateIntervalMs: Math.max(quality.particleUpdateIntervalMs || 0, 33),
        faceFrameIntervalMs: Math.max(quality.faceFrameIntervalMs || 0, 120),
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
      size: 0.14,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
      depthTest: !!quality.depthTest,
      blending: THREE.AdditiveBlending,
      vertexColors: wantsColors,
      sizeAttenuation: true,
      color: wantsColors ? 0xffffff : baseColorHex,
    });

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
    const blinkBlend = clamp01((blink - 0.12) / 0.55);

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

    // Base color from picker + optional hueOffset (used by shake-cycle)
    let hue = (baseHsl.h + hueOffset) % 1;
    hue = lerp(hue, 0.07, smileEffective * 0.55);
    hue = lerp(hue, 0.62, frown * 0.65);
    const sat = clamp01(baseHsl.s * (1 + smileEffective * 0.35 + energy * 0.2));
    const lit = clamp01(baseHsl.l * (1 + energy * 0.25) + smileEffective * 0.05 - frown * 0.05);
    tmpColor.setHSL((hue + 1) % 1, sat, lit);
    const baseR = tmpColor.r;
    const baseG = tmpColor.g;
    const baseB = tmpColor.b;

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
        // Closed "bean" mouth: outline+fill oval, with a smile warp; open => taller "ah".
        const angle = u * Math.PI * 2;
        const fillU = roleParamB[i] ?? 0.5;
        const outline = fillU < 0.55;
        const rr = outline ? 1 : Math.sqrt((fillU - 0.55) / 0.45);

        const rx = (SMILEY.MOUTH_R * 0.95) * rr * (1 + smileEffective * 0.22);
        const ry = (SMILEY.MOUTH_R * 0.52) * rr * (0.92 + openBlend * 0.95);
        const centerY = SMILEY.MOUTH_Y - openBlend * 1.35 - frown * 0.25;

        let mx = Math.cos(angle) * rx;
        let my = Math.sin(angle) * ry + centerY;
        // smile warp (lift the center a bit)
        const xn = rx > 0 ? clamp(mx / rx, -1, 1) : 0;
        my += smileEffective * (1 - xn * xn) * 0.95;

        bx0 = mx;
        by0 = my;
        const clamped = clampIntoFaceXY(bx0, by0);
        bx0 = clamped.x;
        by0 = clamped.y;
        bz0 = faceZFromXY(bx0, by0) - lerp(1.15, 0.5, openBlend) * (outline ? 1.05 : 0.95);
      } else if (role === ROLE.LEFT_EYE || role === ROLE.RIGHT_EYE) {
        // Cute eye: open = filled circle; blink = curved "smile" arc (not a flat line).
        const cx = role === ROLE.LEFT_EYE ? -SMILEY.EYE_X : SMILEY.EYE_X;
        const cy = SMILEY.EYE_Y;

        const angleU = u;
        const radiusU = roleParamB[i] ?? 0.6;
        const angle = angleU * Math.PI * 2;
        const r = Math.sqrt(radiusU) * (SMILEY.EYE_R * 0.98);
        const openX = Math.cos(angle) * r;
        const openY = Math.sin(angle) * r;

        const t = (angleU - 0.5) * 2; // -1..1
        const arcX = t * (SMILEY.EYE_R * 2.9);
        const arcY = (1 - t * t) * (SMILEY.EYE_R * 0.42) - 0.18;

        const ex = lerp(openX, arcX, blinkBlend);
        const ey = lerp(openY, arcY, blinkBlend) - blinkBlend * 0.08;

        bx0 = cx + ex;
        by0 = cy + ey;
        const clamped = clampIntoFaceXY(bx0, by0);
        bx0 = clamped.x;
        by0 = clamped.y;
        // blink => become a shallow arc close to the surface
        bz0 = faceZFromXY(bx0, by0) - lerp(0.9, 0.38, blinkBlend);
      } else if (role === ROLE.LEFT_CHEEK || role === ROLE.RIGHT_CHEEK) {
        // Cheek blush: pop out and slightly swell with smile.
        const isLeft = role === ROLE.LEFT_CHEEK;
        const seedA = u;
        const seedB = roleParamB[i] ?? 0.5;
        const ang = seedA * Math.PI * 2;
        const rr = Math.sqrt(seedB) * (1.05 + smileEffective * 0.25);
        bx0 = Math.cos(ang) * rr + (isLeft ? -6.4 : 6.4);
        by0 = Math.sin(ang) * rr - 0.8;
        const clamped = clampIntoFaceXY(bx0, by0);
        bx0 = clamped.x;
        by0 = clamped.y;
        // hide when not smiling by pushing it deeper into the head
        const cheekInset = lerp(1.45, 0.32, smileEffective);
        bz0 = faceZFromXY(bx0, by0) - cheekInset;
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

      if (wantsColors) {
        const c = i * 3;
        const sparkle = (0.78 + m.sparkle * 0.22) * (0.72 + energy * 0.55) * (0.92 + (u - 0.5) * 0.12);
        const mouthBoost = 1 + openBlend * 0.22 + warm * 0.16 + energy * 0.18;
        const eyeDim = 1 - blinkBlend * 0.35;
        let r = baseR;
        let g = baseG;
        let b = baseB;

        if (role === ROLE.MOUTH) {
          const mouthDarken = 1 - openBlend * 0.25;
          r *= mouthBoost * mouthDarken;
          g *= mouthBoost * mouthDarken;
          b *= mouthBoost * mouthDarken;
        } else if (role === ROLE.LEFT_EYE || role === ROLE.RIGHT_EYE) {
          r *= eyeDim;
          g *= eyeDim;
          b *= eyeDim;
        } else if (role === ROLE.LEFT_CHEEK || role === ROLE.RIGHT_CHEEK) {
          // pink-ish blush; stronger when smiling
          const blush = 0.55 + smileEffective * 0.65;
          r *= 1.25 * blush;
          g *= 0.62 * blush;
          b *= 0.78 * blush;
        }

        r = clamp01(r * sparkle);
        g = clamp01(g * sparkle);
        b = clamp01(b * sparkle);

        colors[c] = lerp(colors[c], r, 0.04);
        colors[c + 1] = lerp(colors[c + 1], g, 0.04);
        colors[c + 2] = lerp(colors[c + 2], b, 0.04);
      }
    }

    geometry.attributes.position.needsUpdate = true;
    if (wantsColors) geometry.attributes.color.needsUpdate = true;
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
    }

    renderer.render(scene, camera);
  }

  // ---- UI / wiring ----
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
      return;
    }

    resetCalibration();
    calibText.textContent = "请求摄像头权限…";

    try {
      await initCamera();
      initFaceMesh();
      faceTrackingEnabled = true;
      // Always keep the camera preview hidden (no top-right mini window).
      video.style.opacity = "0";
      setTrackingStatus();
      requestAnimationFrame(faceLoop);
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
})();
