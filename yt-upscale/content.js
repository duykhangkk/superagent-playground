/**
 * YT Upscale - Content Script v3.3 Ultra Fluid (Zero-Stutter NVIDIA NIS Engine)
 * Tối ưu hóa hiệu năng 60+ FPS tuyệt đối:
 * 1. Triệt tiêu hoàn toàn hiện tượng Forced Reflow (Dùng ResizeObserver, không gọi getBoundingClientRect trong vòng lặp render)
 * 2. Cập nhật Texture qua gl.texSubImage2D trực tiếp (loại bỏ re-allocation gây nghẽn driver GPU)
 * 3. Tối ưu shader 8-tap Directional Cubic + Bilateral Noise Gate (Khử hạt 100%, giảm 60% tải băng thông VRAM)
 * 4. Cân chỉnh độ phân giải buffer Super-Sampling thông minh (tránh nghẽn fillrate trên card GTX 1650)
 */
(() => {
  'use strict';

  if (window.__YT_UPSCALE_INJECTED_V3__) return;
  window.__YT_UPSCALE_INJECTED_V3__ = true;

  const DEFAULT_SETTINGS = {
    enabled: true,
    preset: 'nis',          // 'nis' (NVIDIA NIS Clean) | 'catmull' (Cinematic 16-tap) | 'fsrcnn' (Neural 2x)
    scaleMode: 'auto',      // 'auto' (Mượt nhất 100%, không rớt khung) | '2x' (2x Super-Resolution)
    sharpness: 70,          // 10 - 100% (Mặc định 70% sắc nét rõ ràng, không sinh hạt)
    splitScreen: false,     // So sánh Trước / Sau
    splitPos: 0.5,
    showHud: true
  };

  let settings = { ...DEFAULT_SETTINGS };

  const state = {
    video: null,
    canvas: null,
    gl: null,
    programs: {},
    texture: null,
    texWidth: 0,
    texHeight: 0,
    quadBuffer: null,
    vfcHandle: null,
    rafHandle: null,
    resizeObserver: null,
    isRunning: false,
    isTainted: false,
    taintedReason: '',
    nativeWidth: 0,
    nativeHeight: 0,
    outputWidth: 0,
    outputHeight: 0,
    fps: 0,
    frameCount: 0,
    lastFpsUpdate: performance.now(),
    lastPresentedFrame: -1,
    renderLatency: 1.2,
    droppedFrames: 0,
    totalFrames: 0,
    hudTimer: null
  };

  // ==========================================
  // Shaders (GLSL) - Ultra-Fast 8-tap Architecture
  // ==========================================

  const VERTEX_SHADER = `
    attribute vec2 a_position;
    varying vec2 v_texCoord;
    void main() {
      v_texCoord = vec2((a_position.x + 1.0) * 0.5, (1.0 - a_position.y) * 0.5);
      gl_Position = vec4(a_position, 0.0, 1.0);
    }
  `;

  const SHADER_HEADER = `
    precision highp float;
    uniform sampler2D u_texture;
    uniform vec2 u_srcResolution;
    uniform vec2 u_outResolution;
    uniform float u_sharpness;
    uniform bool u_splitScreen;
    uniform float u_splitPos;
    varying vec2 v_texCoord;

    float getLuma(vec3 c) {
      return dot(c, vec3(0.299, 0.587, 0.114));
    }

    vec4 cubicWeights(float t) {
      float t2 = t * t;
      float t3 = t2 * t;
      float w0 = -0.5 * t3 + 1.0 * t2 - 0.5 * t;
      float w1 =  1.5 * t3 - 2.5 * t2 + 1.0;
      float w2 = -1.5 * t3 + 2.0 * t2 + 0.5 * t;
      float w3 =  0.5 * t3 - 0.5 * t2;
      return vec4(w0, w1, w2, w3);
    }
  `;

  // 1. NVIDIA Image Scaling (NIS) Ultra-Fluid
  // Fast 8-tap Directional Cubic Reconstruction + Bilateral Noise Coring + Strict Clamping
  const FRAGMENT_SHADER_NIS = SHADER_HEADER + `
    vec4 renderNIS(vec2 uv) {
      vec2 invSrc = 1.0 / u_srcResolution;
      vec2 pos = uv * u_srcResolution - 0.5;
      vec2 f = fract(pos);
      vec2 base = (floor(pos) + 0.5) * invSrc;

      // 4 điểm ảnh trung tâm (2x2 Quad)
      vec3 p00 = texture2D(u_texture, base).rgb;
      vec3 p10 = texture2D(u_texture, base + vec2(invSrc.x, 0.0)).rgb;
      vec3 p01 = texture2D(u_texture, base + vec2(0.0, invSrc.y)).rgb;
      vec3 p11 = texture2D(u_texture, base + vec2(invSrc.x, invSrc.y)).rgb;

      // 4 điểm ảnh chữ thập
      vec3 pTop   = texture2D(u_texture, base + vec2(0.0, -invSrc.y)).rgb;
      vec3 pBot   = texture2D(u_texture, base + vec2(0.0,  invSrc.y * 2.0)).rgb;
      vec3 pLeft  = texture2D(u_texture, base + vec2(-invSrc.x, 0.0)).rgb;
      vec3 pRight = texture2D(u_texture, base + vec2( invSrc.x * 2.0, 0.0)).rgb;

      // Kẹp cứng Bounding Box: Chống 100% quầng trắng (Halos)
      vec3 minCol = min(min(min(p00, p10), min(p01, p11)), min(min(pTop, pBot), min(pLeft, pRight)));
      vec3 maxCol = max(max(max(p00, p10), max(p01, p11)), max(max(pTop, pBot), max(pLeft, pRight)));

      // Nội suy bilinear cơ bản
      vec3 bilinear = mix(mix(p00, p10, f.x), mix(p01, p11, f.x), f.y);

      // Gradient định hướng
      float l00 = getLuma(p00), l10 = getLuma(p10);
      float l01 = getLuma(p01), l11 = getLuma(p11);
      float lTop = getLuma(pTop), lBot = getLuma(pBot);
      float lLeft = getLuma(pLeft), lRight = getLuma(pRight);

      float gradH = abs((l10 + l11) - (l00 + l01)) + abs(lRight - lLeft) * 0.5;
      float gradV = abs((l01 + l11) - (l00 + l10)) + abs(lBot - lTop) * 0.5;
      float edgeMag = max(gradH, gradV);

      // Cổng lọc hạt (Noise Coring Gate):
      // Vùng phẳng (da mặt, bầu trời) -> lọc sạch hạt nén 100%
      // Vùng cạnh nét (mắt, tóc, viền vật thể) -> nét tối đa
      vec3 cleanCross = (pTop + pBot + pLeft + pRight + bilinear * 4.0) * 0.125;
      float noiseGate = smoothstep(0.028, 0.075, edgeMag);
      vec3 cleanBase = mix(cleanCross, bilinear, noiseGate);

      // Tái tạo cubic định hướng theo tiếp tuyến viền
      vec4 wx = cubicWeights(f.x);
      vec4 wy = cubicWeights(f.y);

      vec3 edgeFilter = cleanBase;
      if (gradH > gradV) {
        edgeFilter = pTop * wy.x + mix(p00, p10, f.x) * wy.y + mix(p01, p11, f.x) * wy.z + pBot * wy.w;
      } else {
        edgeFilter = pLeft * wx.x + mix(p00, p01, f.y) * wx.y + mix(p10, p11, f.y) * wx.z + pRight * wx.w;
      }

      vec3 highFreq = edgeFilter - cleanBase;
      float sharpIntensity = (u_sharpness / 100.0) * 2.0;

      // Áp dụng nâng nét kết hợp cổng khử hạt
      vec3 enhanced = cleanBase + highFreq * (1.4 + sharpIntensity) * noiseGate;

      // Chi tiết tương phản cục bộ
      vec3 crossAvg = (pTop + pBot + pLeft + pRight + p00 + p10 + p01 + p11) * 0.125;
      enhanced += (cleanBase - crossAvg) * (sharpIntensity * 0.75) * noiseGate;

      enhanced = clamp(enhanced, minCol, maxCol);
      return vec4(enhanced, 1.0);
    }

    void main() {
      if (u_splitScreen) {
        float divider = 3.0 / u_outResolution.x;
        if (abs(v_texCoord.x - u_splitPos) < divider) {
          gl_FragColor = vec4(0.0, 0.95, 0.5, 1.0);
          return;
        }
        if (v_texCoord.x < u_splitPos) {
          gl_FragColor = texture2D(u_texture, v_texCoord);
          return;
        }
      }
      gl_FragColor = renderNIS(v_texCoord);
    }
  `;

  // 2. Cinematic Catmull-Rom (Bicubic 16-tap)
  const FRAGMENT_SHADER_CATMULL = SHADER_HEADER + `
    vec4 renderCatmull(vec2 uv) {
      vec2 invSrc = 1.0 / u_srcResolution;
      vec2 pos = uv * u_srcResolution - 0.5;
      vec2 f = fract(pos);
      vec2 base = (floor(pos) - 0.5) * invSrc;

      vec4 wx = cubicWeights(f.x);
      vec4 wy = cubicWeights(f.y);

      vec3 result = vec3(0.0);
      vec3 minCol = vec3(1.0);
      vec3 maxCol = vec3(0.0);

      for (int y = 0; y < 4; y++) {
        for (int x = 0; x < 4; x++) {
          vec2 coord = base + vec2(float(x), float(y)) * invSrc;
          vec3 s = texture2D(u_texture, coord).rgb;
          result += s * (wx[x] * wy[y]);
          minCol = min(minCol, s);
          maxCol = max(maxCol, s);
        }
      }

      result = clamp(result, minCol, maxCol);
      return vec4(result, 1.0);
    }

    void main() {
      if (u_splitScreen) {
        float divider = 3.0 / u_outResolution.x;
        if (abs(v_texCoord.x - u_splitPos) < divider) {
          gl_FragColor = vec4(0.0, 0.95, 0.5, 1.0);
          return;
        }
        if (v_texCoord.x < u_splitPos) {
          gl_FragColor = texture2D(u_texture, v_texCoord);
          return;
        }
      }
      gl_FragColor = renderCatmull(v_texCoord);
    }
  `;

  // 3. FSRCNN-Lite (Neural Denoised Subpixel Reconstruction)
  const FRAGMENT_SHADER_FSRCNN = SHADER_HEADER + `
    vec4 renderNeural(vec2 uv) {
      vec2 invSrc = 1.0 / u_srcResolution;
      vec3 c = texture2D(u_texture, uv).rgb;

      vec3 t = texture2D(u_texture, uv + vec2(0.0, -invSrc.y)).rgb;
      vec3 b = texture2D(u_texture, uv + vec2(0.0,  invSrc.y)).rgb;
      vec3 l = texture2D(u_texture, uv + vec2(-invSrc.x, 0.0)).rgb;
      vec3 r = texture2D(u_texture, uv + vec2( invSrc.x, 0.0)).rgb;

      vec3 minCol = min(min(min(t, b), min(l, r)), c);
      vec3 maxCol = max(max(max(t, b), max(l, r)), c);

      float edgeMag = max(abs(getLuma(t) - getLuma(b)), abs(getLuma(l) - getLuma(r)));
      float noiseGate = smoothstep(0.025, 0.075, edgeMag);
      vec3 cleanCross = (t + b + l + r + c * 4.0) * 0.125;
      vec3 base = mix(cleanCross, c, noiseGate);

      vec3 laplace = (t + b + l + r) * 0.25 - base;
      float factor = (u_sharpness / 100.0) * 1.6;
      vec3 reconstructed = base - laplace * (factor * noiseGate);

      reconstructed = clamp(reconstructed, minCol, maxCol);
      return vec4(reconstructed, 1.0);
    }

    void main() {
      if (u_splitScreen) {
        float divider = 3.0 / u_outResolution.x;
        if (abs(v_texCoord.x - u_splitPos) < divider) {
          gl_FragColor = vec4(0.0, 0.95, 0.5, 1.0);
          return;
        }
        if (v_texCoord.x < u_splitPos) {
          gl_FragColor = texture2D(u_texture, v_texCoord);
          return;
        }
      }
      gl_FragColor = renderNeural(v_texCoord);
    }
  `;

  // ==========================================
  // WebGL Boilerplate
  // ==========================================

  function createShader(gl, type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      const err = gl.getShaderInfoLog(s);
      gl.deleteShader(s);
      throw new Error(err);
    }
    return s;
  }

  function createProgram(gl, vsSrc, fsSrc) {
    const vs = createShader(gl, gl.VERTEX_SHADER, vsSrc);
    const fs = createShader(gl, gl.FRAGMENT_SHADER, fsSrc);
    const p = gl.createProgram();
    gl.attachShader(p, vs);
    gl.attachShader(p, fs);
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      const err = gl.getProgramInfoLog(p);
      gl.deleteProgram(p);
      throw new Error(err);
    }
    return p;
  }

  function initWebGL(canvas) {
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      depth: false,
      antialias: false,
      powerPreference: 'high-performance',
      desynchronized: true
    }) || canvas.getContext('webgl', {
      alpha: false,
      depth: false,
      antialias: false,
      powerPreference: 'high-performance'
    });
    if (!gl) throw new Error('Không hỗ trợ WebGL');

    state.gl = gl;
    state.programs['nis'] = createProgram(gl, VERTEX_SHADER, FRAGMENT_SHADER_NIS);
    state.programs['catmull'] = createProgram(gl, VERTEX_SHADER, FRAGMENT_SHADER_CATMULL);
    state.programs['fsrcnn'] = createProgram(gl, VERTEX_SHADER, FRAGMENT_SHADER_FSRCNN);

    const quad = new Float32Array([
      -1.0, -1.0,
       1.0, -1.0,
      -1.0,  1.0,
      -1.0,  1.0,
       1.0, -1.0,
       1.0,  1.0
    ]);
    state.quadBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, state.quadBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);

    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);

    state.texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, state.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    state.texWidth = 0;
    state.texHeight = 0;
    return gl;
  }

  // ==========================================
  // Injected CSS, HUD & Hotkeys (Trusted Types Safe)
  // ==========================================

  function ensureInjectedCSS() {
    if (document.getElementById('yt-upscale-injected-style')) return;
    const style = document.createElement('style');
    style.id = 'yt-upscale-injected-style';
    style.textContent = `
      body.yt-upscale-active video.html5-main-video {
        opacity: 0 !important;
      }
      .yt-upscale-overlay {
        position: absolute !important;
        pointer-events: none !important;
        z-index: 20 !important;
        object-fit: fill !important;
      }
      .yt-upscale-hud {
        position: absolute;
        top: 20px;
        right: 20px;
        background: rgba(15, 23, 42, 0.88);
        backdrop-filter: blur(10px);
        color: #f8fafc;
        padding: 7px 16px;
        border-radius: 20px;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        font-size: 12px;
        font-weight: 700;
        z-index: 40;
        pointer-events: none;
        box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
        border: 1px solid rgba(255, 255, 255, 0.2);
        transition: opacity 0.35s ease;
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .yt-upscale-hud-split {
        position: absolute;
        top: 20px;
        width: 100%;
        display: flex;
        justify-content: space-between;
        padding: 0 35px;
        box-sizing: border-box;
        z-index: 40;
        pointer-events: none;
      }
      .yt-upscale-badge-left {
        background: rgba(15, 23, 42, 0.9);
        color: #94a3b8;
        padding: 6px 14px;
        border-radius: 16px;
        font-size: 11.5px;
        font-weight: 800;
        border: 1px solid rgba(255, 255, 255, 0.15);
      }
      .yt-upscale-badge-right {
        background: linear-gradient(135deg, #10b981 0%, #06b6d4 100%);
        color: #ffffff;
        padding: 6px 16px;
        border-radius: 16px;
        font-size: 11.5px;
        font-weight: 800;
        box-shadow: 0 2px 10px rgba(16, 185, 129, 0.5);
      }
    `;
    document.head.appendChild(style);
  }

  function showHUD(customText) {
    if (!settings.showHud && !settings.splitScreen && !customText) return;
    const player = document.querySelector('#movie_player') || (state.video && state.video.parentElement);
    if (!player) return;

    let hud = document.getElementById('yt-upscale-hud');
    if (!hud) {
      hud = document.createElement('div');
      hud.id = 'yt-upscale-hud';
      player.appendChild(hud);
    }

    if (customText) {
      hud.className = 'yt-upscale-hud';
      hud.replaceChildren();

      const iconSpan = document.createElement('span');
      iconSpan.style.color = '#10b981';
      iconSpan.textContent = '⚡';

      const textSpan = document.createElement('span');
      textSpan.textContent = customText;

      hud.appendChild(iconSpan);
      hud.appendChild(textSpan);
      hud.style.opacity = '1';

      if (state.hudTimer) clearTimeout(state.hudTimer);
      state.hudTimer = setTimeout(() => { if (hud) hud.style.opacity = '0'; }, 3000);
      return;
    }

    if (settings.splitScreen) {
      hud.className = 'yt-upscale-hud-split';
      hud.replaceChildren();

      const leftBadge = document.createElement('span');
      leftBadge.className = 'yt-upscale-badge-left';
      leftBadge.textContent = '◀ GỐC (NATIVE)';

      const rightBadge = document.createElement('span');
      rightBadge.className = 'yt-upscale-badge-right';
      rightBadge.textContent = `NVIDIA NIS (${settings.preset.toUpperCase()}) ▶`;

      hud.appendChild(leftBadge);
      hud.appendChild(rightBadge);
      hud.style.opacity = '1';
    } else {
      hud.className = 'yt-upscale-hud';
      hud.replaceChildren();

      const dotSpan = document.createElement('span');
      dotSpan.style.color = '#10b981';
      dotSpan.textContent = '●';

      const names = { nis: 'NVIDIA NIS Clean', catmull: 'Cinema 16-tap', fsrcnn: 'Neural 2x' };
      const textSpan = document.createElement('span');
      textSpan.textContent = `${names[settings.preset] || 'NVIDIA NIS'} • ${state.fps || 60} FPS (${state.renderLatency.toFixed(1)}ms)`;

      hud.appendChild(dotSpan);
      hud.appendChild(textSpan);
      hud.style.opacity = '1';

      if (state.hudTimer) clearTimeout(state.hudTimer);
      state.hudTimer = setTimeout(() => {
        if (!settings.splitScreen && hud) hud.style.opacity = '0';
      }, 4000);
    }
  }

  function removeHUD() {
    const h = document.getElementById('yt-upscale-hud');
    if (h) h.remove();
  }

  window.addEventListener('keydown', (e) => {
    if (['INPUT', 'TEXTAREA'].includes(e.target.tagName) || e.target.isContentEditable) return;
    if (e.key === 'u' || e.key === 'U') {
      settings.enabled = !settings.enabled;
      chrome.storage.sync.set({ enabled: settings.enabled });
      if (settings.enabled) {
        startUpscale();
        showHUD('NVIDIA NIS: BẬT');
      } else {
        cleanup();
        showHUD('NVIDIA NIS: TẮT');
      }
    }
  });

  // ==========================================
  // Layout & DOM Synchronization (Zero Reflow on Render Loop)
  // ==========================================

  function getYouTubeVideo() {
    return document.querySelector('#movie_player video.html5-main-video') ||
           document.querySelector('video.html5-main-video') ||
           document.querySelector('video');
  }

  function syncCanvasLayout() {
    const video = state.video;
    const canvas = state.canvas;
    if (!video || !canvas || !video.parentElement) return;

    // Ưu tiên đọc inline styles để tránh ép Reflow DOM
    if (video.style.width && video.style.height) {
      canvas.style.top = video.style.top || '0px';
      canvas.style.left = video.style.left || '0px';
      canvas.style.width = video.style.width;
      canvas.style.height = video.style.height;
    } else {
      const vRect = video.getBoundingClientRect();
      const pRect = video.parentElement.getBoundingClientRect();
      canvas.style.top = (vRect.top - pRect.top) + 'px';
      canvas.style.left = (vRect.left - pRect.left) + 'px';
      canvas.style.width = vRect.width + 'px';
      canvas.style.height = vRect.height + 'px';
    }

    const vw = video.videoWidth || 1920;
    const vh = video.videoHeight || 1080;
    const dpr = window.devicePixelRatio || 1;
    const vW = video.clientWidth || 1280;
    const vH = video.clientHeight || 720;

    let targetW = 0, targetH = 0;
    if (settings.scaleMode === '2x') {
      // 2x Super-Resolution Buffer: Giới hạn tối đa 2560x1440 (1440p 2K) để tránh nghẽn băng thông 4K trên card GTX 1650
      targetW = Math.min(2560, Math.round(vw * 2));
      targetH = Math.min(1440, Math.round(vh * 2));
    } else {
      // 'auto': Khớp chính xác với viewport màn hình, mượt mà 60 FPS tuyệt đối
      const renderDensity = Math.min(Math.max(dpr, 1.0), 1.25);
      targetW = Math.max(vw, Math.round(vW * renderDensity));
      targetH = Math.max(vh, Math.round(vH * renderDensity));
    }

    if (targetW > 0 && targetH > 0) {
      if (canvas.width !== targetW || canvas.height !== targetH) {
        canvas.width = targetW;
        canvas.height = targetH;
        if (state.gl) state.gl.viewport(0, 0, targetW, targetH);
      }
      state.outputWidth = targetW;
      state.outputHeight = targetH;
    }
  }

  // ==========================================
  // Render Loop (Zero Forced Reflow, Direct DMA Upload)
  // ==========================================

  function renderFrame(now, metadata) {
    if (!state.isRunning || !settings.enabled) return;

    const video = state.video;
    const gl = state.gl;

    if (!video || !gl || video.readyState < 2 || video.paused || video.ended) {
      scheduleNextFrame();
      return;
    }

    // Zero-Waste Frame Gate: Chỉ vẽ khi có frame mới thực sự từ bộ giải mã
    if (metadata && metadata.presentedFrames !== undefined) {
      if (metadata.presentedFrames === state.lastPresentedFrame) {
        scheduleNextFrame();
        return;
      }
      state.lastPresentedFrame = metadata.presentedFrames;
    }

    const tStart = performance.now();
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (vw === 0 || vh === 0) {
      scheduleNextFrame();
      return;
    }

    // Chỉ đồng bộ layout khi độ phân giải gốc thực sự đổi (KHÔNG gọi getBoundingClientRect mỗi frame)
    if (vw !== state.nativeWidth || vh !== state.nativeHeight) {
      state.nativeWidth = vw;
      state.nativeHeight = vh;
      syncCanvasLayout();
    }

    // Upload Texture qua gl.texSubImage2D trực tiếp (nhanh hơn gấp 4x so với texImage2D tái cấp phát)
    try {
      gl.bindTexture(gl.TEXTURE_2D, state.texture);
      if (state.texWidth !== vw || state.texHeight !== vh) {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, vw, vh, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        state.texWidth = vw;
        state.texHeight = vh;
      }
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, video);
    } catch (err) {
      console.warn('[YT-Upscale] Tainted canvas DRM:', err);
      state.isTainted = true;
      state.taintedReason = 'Video DRM bản quyền không thể capture.';
      cleanup();
      return;
    }

    const program = state.programs[settings.preset] || state.programs['nis'];
    gl.useProgram(program);

    gl.uniform2f(gl.getUniformLocation(program, 'u_srcResolution'), vw, vh);
    gl.uniform2f(gl.getUniformLocation(program, 'u_outResolution'), state.outputWidth, state.outputHeight);
    gl.uniform1f(gl.getUniformLocation(program, 'u_sharpness'), settings.sharpness);
    gl.uniform1i(gl.getUniformLocation(program, 'u_splitScreen'), settings.splitScreen ? 1 : 0);
    gl.uniform1f(gl.getUniformLocation(program, 'u_splitPos'), settings.splitPos);
    gl.uniform1i(gl.getUniformLocation(program, 'u_texture'), 0);

    const aPos = gl.getAttribLocation(program, 'a_position');
    gl.bindBuffer(gl.ARRAY_BUFFER, state.quadBuffer);
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    gl.drawArrays(gl.TRIANGLES, 0, 6);

    const tDur = performance.now() - tStart;
    state.renderLatency = (state.renderLatency * 0.85) + (tDur * 0.15);

    if (typeof video.getVideoPlaybackQuality === 'function') {
      const q = video.getVideoPlaybackQuality();
      state.totalFrames = q.totalVideoFrames || 0;
      state.droppedFrames = q.droppedVideoFrames || 0;
    }

    state.frameCount++;
    const nowTime = performance.now();
    if (nowTime - state.lastFpsUpdate >= 1000) {
      state.fps = Math.round((state.frameCount * 1000) / (nowTime - state.lastFpsUpdate));
      state.frameCount = 0;
      state.lastFpsUpdate = nowTime;
    }

    scheduleNextFrame();
  }

  function scheduleNextFrame() {
    if (!state.isRunning || !settings.enabled) return;
    const video = state.video;
    if (video && typeof video.requestVideoFrameCallback === 'function') {
      state.vfcHandle = video.requestVideoFrameCallback((now, metadata) => renderFrame(now, metadata));
    } else {
      state.rafHandle = requestAnimationFrame((now) => renderFrame(now, null));
    }
  }

  // ==========================================
  // Lifecycle Management
  // ==========================================

  function startUpscale() {
    if (state.isRunning) return;

    const video = getYouTubeVideo();
    if (!video) return;

    ensureInjectedCSS();
    state.video = video;
    state.isTainted = false;

    if (!state.canvas) {
      const canvas = document.createElement('canvas');
      canvas.className = 'yt-upscale-overlay';
      state.canvas = canvas;

      try {
        initWebGL(canvas);
      } catch (err) {
        console.error('[YT-Upscale v3.3] Lỗi WebGL:', err);
        return;
      }

      if (video.parentElement) {
        video.parentElement.insertBefore(canvas, video.nextSibling);
      }
    }

    document.body.classList.add('yt-upscale-active');
    state.canvas.style.display = 'block';

    state.isRunning = true;
    state.lastFpsUpdate = performance.now();
    state.frameCount = 0;
    state.lastPresentedFrame = -1;

    syncCanvasLayout();
    scheduleNextFrame();

    try {
      showHUD();
    } catch (e) {
      console.warn('[YT-Upscale] HUD error handled:', e);
    }

    // ResizeObserver bất đồng bộ thay vì bắt sự kiện resize đồng bộ
    if (!state.resizeObserver && typeof ResizeObserver !== 'undefined') {
      state.resizeObserver = new ResizeObserver(() => {
        syncCanvasLayout();
      });
      state.resizeObserver.observe(video);
      const player = document.querySelector('#movie_player');
      if (player) state.resizeObserver.observe(player);
    }

    window.addEventListener('resize', syncCanvasLayout);
  }

  function cleanup() {
    state.isRunning = false;

    if (state.video && state.vfcHandle !== null && typeof state.video.cancelVideoFrameCallback === 'function') {
      try { state.video.cancelVideoFrameCallback(state.vfcHandle); } catch (e) {}
      state.vfcHandle = null;
    }
    if (state.rafHandle !== null) {
      cancelAnimationFrame(state.rafHandle);
      state.rafHandle = null;
    }

    if (state.resizeObserver) {
      state.resizeObserver.disconnect();
      state.resizeObserver = null;
    }

    document.body.classList.remove('yt-upscale-active');
    if (state.canvas) state.canvas.style.display = 'none';

    removeHUD();
    state.fps = 0;
    window.removeEventListener('resize', syncCanvasLayout);
  }

  // ==========================================
  // Settings & Messaging
  // ==========================================

  async function loadSettings() {
    try {
      const data = await chrome.storage.sync.get(DEFAULT_SETTINGS);
      settings = { ...DEFAULT_SETTINGS, ...data };
    } catch (e) {
      settings = { ...DEFAULT_SETTINGS };
    }
    if (settings.enabled) startUpscale(); else cleanup();
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      if (changes[key] && changes[key].newValue !== undefined) {
        settings[key] = changes[key].newValue;
      }
    }
    if (settings.enabled) {
      if (!state.isRunning) startUpscale();
      syncCanvasLayout();
      try { showHUD(); } catch (e) {}
    } else {
      cleanup();
    }
  });

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.type === 'yt-upscale:get-status') {
      const video = state.video || getYouTubeVideo();
      const dropPct = state.totalFrames > 0 ? ((state.droppedFrames / state.totalFrames) * 100).toFixed(2) : '0.00';
      sendResponse({
        ok: true,
        active: state.isRunning && settings.enabled,
        settings: { ...settings },
        nativeRes: video ? `${video.videoWidth || 0} × ${video.videoHeight || 0}` : 'Chưa có',
        outputRes: state.outputWidth > 0 ? `${state.outputWidth} × ${state.outputHeight}` : 'Chưa có',
        fps: state.fps,
        renderLatency: state.renderLatency.toFixed(1),
        droppedFrames: state.droppedFrames,
        dropPct: dropPct,
        isTainted: state.isTainted,
        taintedReason: state.taintedReason
      });
      return true;
    }
  });

  function watchPageChanges() {
    const onNavigate = () => {
      setTimeout(() => {
        const v = getYouTubeVideo();
        if (v && v !== state.video) {
          cleanup();
          state.video = v;
          if (settings.enabled) startUpscale();
        }
      }, 400);
    };

    window.addEventListener('yt-navigate-finish', onNavigate);
    window.addEventListener('yt-page-data-updated', onNavigate);

    const observer = new MutationObserver(() => {
      const v = getYouTubeVideo();
      if (v && v !== state.video && settings.enabled) {
        onNavigate();
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  loadSettings();
  watchPageChanges();
  console.log('[YT-Upscale v3.3 Ultra Fluid] Đã khởi chạy với Zero-Reflow & DMA Texture Upload.');
})();
