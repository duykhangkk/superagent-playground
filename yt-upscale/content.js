/**
 * YT Upscale - Content Script v1.1.0
 * Real-time WebGL Video Upscaling for YouTube
 * Dual-Pass AMD FSR 1.0 (EASU + RCAS Sharpening) & Lanczos-3 Sinc Resampling
 * Hỗ trợ Split-Screen Trước/Sau & OSD HUD thời gian thực
 */
(() => {
  'use strict';

  if (window.__YT_UPSCALE_INJECTED__) return;
  window.__YT_UPSCALE_INJECTED__ = true;

  // Cấu hình mặc định
  const DEFAULT_SETTINGS = {
    enabled: true,
    algorithm: 'easu',      // 'easu' (FSR) | 'lanczos'
    scaleMode: '2x',        // '2x' (gấp đôi native 4K) | '1.5x' | 'fit'
    sharpness: 75,          // 0 - 100% (RCAS adaptive sharpening)
    splitScreen: false,     // Chế độ so sánh chia đôi màn hình (Trái Gốc / Phải Upscale)
    showHud: true           // Hiển thị badge trạng thái trên video
  };

  let settings = { ...DEFAULT_SETTINGS };

  // Runtime State
  const state = {
    video: null,
    canvas: null,
    gl: null,
    programEASU: null,
    programLanczos: null,
    texture: null,
    quadBuffer: null,
    vfcHandle: null,
    rafHandle: null,
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
    hudTimer: null
  };

  // ==========================================
  // Shaders (GLSL)
  // ==========================================

  const VERTEX_SHADER = `
    attribute vec2 a_position;
    varying vec2 v_texCoord;
    void main() {
      // Chuyển [-1, 1] sang UV [0, 1], lật trục Y cho video texture
      v_texCoord = vec2((a_position.x + 1.0) * 0.5, (1.0 - a_position.y) * 0.5);
      gl_Position = vec4(a_position, 0.0, 1.0);
    }
  `;

  // AMD FSR 1.0 EASU + RCAS Fragment Shader (Tái tạo biên + Làm nét thích ứng tương phản)
  const FRAGMENT_SHADER_EASU = `
    precision highp float;
    uniform sampler2D u_texture;
    uniform vec2 u_srcResolution;
    uniform vec2 u_outResolution;
    uniform float u_sharpness;
    uniform bool u_splitScreen;
    varying vec2 v_texCoord;

    float getLuma(vec3 c) {
      return dot(c, vec3(0.2126, 0.7152, 0.0722));
    }

    vec4 renderFSR(vec2 uv) {
      vec2 invSrc = 1.0 / u_srcResolution;
      vec2 pos = uv * u_srcResolution - 0.5;
      vec2 f = fract(pos);
      vec2 base = (floor(pos) + 0.5) * invSrc;

      // 9 taps phân tích hướng biên và cấu trúc điểm ảnh
      vec3 b = texture2D(u_texture, base + vec2(-1.0, -1.0) * invSrc).rgb;
      vec3 c = texture2D(u_texture, base + vec2( 0.0, -1.0) * invSrc).rgb;
      vec3 d = texture2D(u_texture, base + vec2( 1.0, -1.0) * invSrc).rgb;
      vec3 e = texture2D(u_texture, base + vec2(-1.0,  0.0) * invSrc).rgb;
      vec3 f0 = texture2D(u_texture, base).rgb;
      vec3 g = texture2D(u_texture, base + vec2( 1.0,  0.0) * invSrc).rgb;
      vec3 h = texture2D(u_texture, base + vec2(-1.0,  1.0) * invSrc).rgb;
      vec3 i = texture2D(u_texture, base + vec2( 0.0,  1.0) * invSrc).rgb;
      vec3 j = texture2D(u_texture, base + vec2( 1.0,  1.0) * invSrc).rgb;

      float lb = getLuma(b), lc = getLuma(c), ld = getLuma(d);
      float le = getLuma(e), lf = getLuma(f0), lg = getLuma(g);
      float lh = getLuma(h), li = getLuma(i), lj = getLuma(j);

      // Gradient ngang & dọc
      float gradH = abs(le - lg) + abs(lb - ld) * 0.5 + abs(lh - lj) * 0.5;
      float gradV = abs(lc - li) + abs(lb - lh) * 0.5 + abs(ld - lj) * 0.5;

      vec2 dir = vec2(gradH, gradV);
      float len = length(dir);
      if (len > 0.0001) dir /= len; else dir = vec2(1.0, 0.0);

      // Nội suy bilinear có định hướng (Directional bilinear interpolation)
      vec3 top = mix(c, d, f.x);
      vec3 mid = mix(e, g, f.x);
      vec3 bot = mix(h, j, f.x);
      vec3 reconstructed = mix(mix(top, bot, f.y), f0, 0.4);

      // RCAS (Robust Contrast-Adaptive Sharpening)
      vec3 mn = min(min(min(c, e), min(g, i)), f0);
      vec3 mx = max(max(max(c, e), max(g, i)), f0);
      vec3 contrast = mx - mn;

      // Trọng số làm nét tỷ lệ nghịch với rung viền (Anti-ringing)
      vec3 rcasWeight = clamp((2.0 - mx) / (mx + 0.001), 0.0, 1.0);
      float strength = (u_sharpness / 100.0) * 1.25;

      vec3 highpass = reconstructed - (c + e + g + i) * 0.25;
      vec3 sharpened = reconstructed + highpass * (rcasWeight * strength);

      // Kẹp trong khoảng min-max để chống chói
      vec3 result = clamp(sharpened, mn * 0.96, mx * 1.04);
      return vec4(result, 1.0);
    }

    void main() {
      if (u_splitScreen) {
        float divider = 2.0 / u_outResolution.x;
        if (abs(v_texCoord.x - 0.5) < divider) {
          gl_FragColor = vec4(1.0, 1.0, 1.0, 1.0); // Vạch phân cách trắng
          return;
        }
        if (v_texCoord.x < 0.5) {
          // Nửa trái: Video gốc (Bilinear chuẩn)
          gl_FragColor = texture2D(u_texture, v_texCoord);
          return;
        }
      }

      // Nửa phải (hoặc toàn màn hình): FSR EASU + RCAS
      gl_FragColor = renderFSR(v_texCoord);
    }
  `;

  // Lanczos-3 Sinc Resampling Fragment Shader
  const FRAGMENT_SHADER_LANCZOS = `
    precision highp float;
    uniform sampler2D u_texture;
    uniform vec2 u_srcResolution;
    uniform vec2 u_outResolution;
    uniform float u_sharpness;
    uniform bool u_splitScreen;
    varying vec2 v_texCoord;

    const float PI = 3.14159265358979323846;

    float sinc(float x) {
      if (abs(x) < 0.0001) return 1.0;
      float px = PI * x;
      return sin(px) / px;
    }

    float lanczos3(float x) {
      float ax = abs(x);
      if (ax >= 3.0) return 0.0;
      return sinc(ax) * sinc(ax / 3.0);
    }

    vec4 renderLanczos(vec2 uv) {
      vec2 pos = uv * u_srcResolution - 0.5;
      vec2 f = fract(pos);
      vec2 base = floor(pos);

      vec4 sum = vec4(0.0);
      float totalWeight = 0.0;

      for (int y = -2; y <= 3; y++) {
        float dy = float(y) - f.y;
        float wy = lanczos3(dy);
        if (wy == 0.0) continue;

        for (int x = -2; x <= 3; x++) {
          float dx = float(x) - f.x;
          float wx = lanczos3(dx);
          float w = wx * wy;

          vec2 coord = (base + vec2(float(x) + 0.5, float(y) + 0.5)) / u_srcResolution;
          coord = clamp(coord, vec2(0.001), vec2(0.999));

          vec4 col = texture2D(u_texture, coord);
          sum += col * w;
          totalWeight += w;
        }
      }

      vec4 color = (totalWeight > 0.0) ? (sum / totalWeight) : texture2D(u_texture, uv);

      // Thêm lớp RCAS sharpening nhẹ cho Lanczos
      float strength = (u_sharpness / 100.0) * 0.4;
      vec2 invSrc = 1.0 / u_srcResolution;
      vec4 center = texture2D(u_texture, uv);
      vec4 blur = (texture2D(u_texture, uv + vec2(-1.0, 0.0) * invSrc) +
                   texture2D(u_texture, uv + vec2( 1.0, 0.0) * invSrc) +
                   texture2D(u_texture, uv + vec2(0.0, -1.0) * invSrc) +
                   texture2D(u_texture, uv + vec2(0.0,  1.0) * invSrc)) * 0.25;
      color += (center - blur) * strength;

      return color;
    }

    void main() {
      if (u_splitScreen) {
        float divider = 2.0 / u_outResolution.x;
        if (abs(v_texCoord.x - 0.5) < divider) {
          gl_FragColor = vec4(1.0, 1.0, 1.0, 1.0);
          return;
        }
        if (v_texCoord.x < 0.5) {
          gl_FragColor = texture2D(u_texture, v_texCoord);
          return;
        }
      }

      gl_FragColor = renderLanczos(v_texCoord);
    }
  `;

  // ==========================================
  // WebGL Boilerplate
  // ==========================================

  function createShader(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const err = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      throw new Error(err);
    }
    return shader;
  }

  function createProgram(gl, vsSource, fsSource) {
    const vs = createShader(gl, gl.VERTEX_SHADER, vsSource);
    const fs = createShader(gl, gl.FRAGMENT_SHADER, fsSource);
    const program = gl.createProgram();
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const err = gl.getProgramInfoLog(program);
      gl.deleteProgram(program);
      throw new Error(err);
    }
    return program;
  }

  function initWebGL(canvas) {
    const gl = canvas.getContext('webgl2', { alpha: false, depth: false, antialias: false, preserveDrawingBuffer: false }) ||
               canvas.getContext('webgl', { alpha: false, depth: false, antialias: false, preserveDrawingBuffer: false });
    if (!gl) throw new Error('Trình duyệt không hỗ trợ WebGL.');

    state.gl = gl;
    state.programEASU = createProgram(gl, VERTEX_SHADER, FRAGMENT_SHADER_EASU);
    state.programLanczos = createProgram(gl, VERTEX_SHADER, FRAGMENT_SHADER_LANCZOS);

    const quadVertices = new Float32Array([
      -1.0, -1.0,
       1.0, -1.0,
      -1.0,  1.0,
      -1.0,  1.0,
       1.0, -1.0,
       1.0,  1.0
    ]);
    state.quadBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, state.quadBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, quadVertices, gl.STATIC_DRAW);

    state.texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, state.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    return gl;
  }

  // ==========================================
  // Injected CSS & OSD HUD
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
        object-fit: contain !important;
      }
      .yt-upscale-hud {
        position: absolute;
        top: 20px;
        right: 20px;
        background: rgba(15, 23, 42, 0.82);
        backdrop-filter: blur(8px);
        color: #f8fafc;
        padding: 6px 14px;
        border-radius: 20px;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        font-size: 12px;
        font-weight: 600;
        letter-spacing: 0.3px;
        z-index: 40;
        pointer-events: none;
        box-shadow: 0 4px 14px rgba(0, 0, 0, 0.25);
        border: 1px solid rgba(255, 255, 255, 0.15);
        transition: opacity 0.4s ease;
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
        padding: 0 30px;
        box-sizing: border-box;
        z-index: 40;
        pointer-events: none;
      }
      .yt-upscale-hud-tag {
        background: rgba(15, 23, 42, 0.85);
        color: #ffffff;
        padding: 5px 12px;
        border-radius: 16px;
        font-size: 11px;
        font-weight: 700;
        border: 1px solid rgba(255, 255, 255, 0.2);
      }
      .yt-upscale-hud-tag.right {
        background: rgba(79, 70, 229, 0.9);
      }
    `;
    document.head.appendChild(style);
  }

  function showHUD() {
    if (!settings.showHud && !settings.splitScreen) return;
    const player = document.querySelector('#movie_player') || (state.video && state.video.parentElement);
    if (!player) return;

    let hud = document.getElementById('yt-upscale-hud');
    if (!hud) {
      hud = document.createElement('div');
      hud.id = 'yt-upscale-hud';
      player.appendChild(hud);
    }

    if (settings.splitScreen) {
      hud.className = 'yt-upscale-hud-split';
      hud.innerHTML = `
        <span class="yt-upscale-hud-tag">◀ GỐC (NATIVE)</span>
        <span class="yt-upscale-hud-tag right">UPSCALE (FSR ${settings.scaleMode.toUpperCase()}) ▶</span>
      `;
      hud.style.opacity = '1';
    } else {
      hud.className = 'yt-upscale-hud';
      const algoName = settings.algorithm === 'easu' ? 'FSR EASU' : 'Lanczos-3';
      hud.innerHTML = `
        <span style="color: #10b981;">●</span>
        <span>${algoName} ${settings.scaleMode.toUpperCase()} (${settings.sharpness}% Sharp)</span>
      `;
      hud.style.opacity = '1';
      if (state.hudTimer) clearTimeout(state.hudTimer);
      state.hudTimer = setTimeout(() => {
        if (!settings.splitScreen && hud) hud.style.opacity = '0';
      }, 3500);
    }
  }

  function removeHUD() {
    const hud = document.getElementById('yt-upscale-hud');
    if (hud) hud.remove();
  }

  // ==========================================
  // Layout & DOM Synchronization
  // ==========================================

  function getYouTubeVideo() {
    return document.querySelector('#movie_player video.html5-main-video') ||
           document.querySelector('video.html5-main-video') ||
           document.querySelector('video');
  }

  function syncCanvasLayout() {
    const video = state.video;
    const canvas = state.canvas;
    if (!video || !canvas) return;

    // Vị trí và kích thước hiển thị
    canvas.style.top = video.offsetTop + 'px';
    canvas.style.left = video.offsetLeft + 'px';
    canvas.style.width = video.clientWidth + 'px';
    canvas.style.height = video.clientHeight + 'px';

    const vw = video.videoWidth || 1920;
    const vh = video.videoHeight || 1080;
    const dpr = window.devicePixelRatio || 1;

    let targetWidth = 0;
    let targetHeight = 0;

    if (settings.scaleMode === '2x') {
      targetWidth = vw * 2;
      targetHeight = vh * 2;
    } else if (settings.scaleMode === '1.5x') {
      targetWidth = Math.round(vw * 1.5);
      targetHeight = Math.round(vh * 1.5);
    } else {
      // 'fit': tối thiểu bằng native, tối đa theo màn hình Retina/4K
      targetWidth = Math.max(vw, Math.round(video.clientWidth * dpr * 1.5));
      targetHeight = Math.max(vh, Math.round(video.clientHeight * dpr * 1.5));
    }

    if (targetWidth > 0 && targetHeight > 0) {
      if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
        canvas.width = targetWidth;
        canvas.height = targetHeight;
        if (state.gl) state.gl.viewport(0, 0, targetWidth, targetHeight);
      }
      state.outputWidth = targetWidth;
      state.outputHeight = targetHeight;
    }
  }

  // ==========================================
  // Render Loop
  // ==========================================

  function renderFrame() {
    if (!state.isRunning || !settings.enabled) return;

    const video = state.video;
    const gl = state.gl;

    if (!video || !gl || video.readyState < 2 || video.paused || video.ended) {
      scheduleNextFrame();
      return;
    }

    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (vw === 0 || vh === 0) {
      scheduleNextFrame();
      return;
    }

    state.nativeWidth = vw;
    state.nativeHeight = vh;
    syncCanvasLayout();

    // Nạp texture từ frame video
    try {
      gl.bindTexture(gl.TEXTURE_2D, state.texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
    } catch (err) {
      console.warn('[YT-Upscale] Tainted canvas / DRM stream:', err);
      state.isTainted = true;
      state.taintedReason = 'Video bảo vệ bản quyền DRM (Widevine) không thể capture.';
      cleanup();
      return;
    }

    const program = settings.algorithm === 'easu' ? state.programEASU : state.programLanczos;
    gl.useProgram(program);

    // Uniforms
    gl.uniform2f(gl.getUniformLocation(program, 'u_srcResolution'), vw, vh);
    gl.uniform2f(gl.getUniformLocation(program, 'u_outResolution'), state.outputWidth, state.outputHeight);
    gl.uniform1f(gl.getUniformLocation(program, 'u_sharpness'), settings.sharpness);
    gl.uniform1i(gl.getUniformLocation(program, 'u_splitScreen'), settings.splitScreen ? 1 : 0);
    gl.uniform1i(gl.getUniformLocation(program, 'u_texture'), 0);

    const aPos = gl.getAttribLocation(program, 'a_position');
    gl.bindBuffer(gl.ARRAY_BUFFER, state.quadBuffer);
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    gl.drawArrays(gl.TRIANGLES, 0, 6);

    // FPS
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
      state.vfcHandle = video.requestVideoFrameCallback(renderFrame);
    } else {
      state.rafHandle = requestAnimationFrame(renderFrame);
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
        console.error('[YT-Upscale] Lỗi khởi tạo WebGL:', err);
        return;
      }

      if (video.parentElement) {
        video.parentElement.insertBefore(canvas, video.nextSibling);
      }
    }

    // Kích hoạt class ẩn video gốc qua CSS !important
    document.body.classList.add('yt-upscale-active');
    state.canvas.style.display = 'block';

    state.isRunning = true;
    state.lastFpsUpdate = performance.now();
    state.frameCount = 0;

    syncCanvasLayout();
    showHUD();
    scheduleNextFrame();

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

    // Gỡ class để hiện lại video gốc
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
      showHUD();
    } else {
      cleanup();
    }
  });

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.type === 'yt-upscale:get-status') {
      const video = state.video || getYouTubeVideo();
      sendResponse({
        ok: true,
        active: state.isRunning && settings.enabled,
        settings: { ...settings },
        nativeRes: video ? `${video.videoWidth || 0} × ${video.videoHeight || 0}` : 'Chưa có',
        outputRes: state.outputWidth > 0 ? `${state.outputWidth} × ${state.outputHeight}` : 'Chưa có',
        fps: state.fps,
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
      }, 500);
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
  console.log('[YT-Upscale v1.1.0] FSR EASU + RCAS Pipeline đã sẵn sàng.');
})();
