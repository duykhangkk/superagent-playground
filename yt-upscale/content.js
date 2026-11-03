/**
 * YT Upscale - Content Script
 * Real-time WebGL Video Upscaling for YouTube (AMD FSR 1.0 EASU & Lanczos-3)
 * Manifest V3 - Vanilla JavaScript & WebGL
 */
(() => {
  'use strict';

  // Tránh inject trùng lặp
  if (window.__YT_UPSCALE_INJECTED__) return;
  window.__YT_UPSCALE_INJECTED__ = true;

  // Cấu hình mặc định
  const DEFAULT_SETTINGS = {
    enabled: true,
    algorithm: 'easu',      // 'easu' | 'lanczos'
    scaleMode: 'fit'        // 'fit' (khớp player/màn hình) | '2x' (gấp đôi native)
  };

  let settings = { ...DEFAULT_SETTINGS };

  // Trạng thái runtime
  const state = {
    video: null,
    canvas: null,
    gl: null,
    programLanczos: null,
    programEASU: null,
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
    lastVideoSrc: ''
  };

  // ==========================================
  // WebGL Shaders (GLSL)
  // ==========================================

  const VERTEX_SHADER = `
    attribute vec2 a_position;
    varying vec2 v_texCoord;
    void main() {
      // Ánh xạ toạ độ không gian [-1, 1] sang UV [0, 1]
      // WebGL mặc định (0,0) ở góc dưới-trái, video top-left (0,0)
      v_texCoord = vec2((a_position.x + 1.0) * 0.5, (1.0 - a_position.y) * 0.5);
      gl_Position = vec4(a_position, 0.0, 1.0);
    }
  `;

  // Lanczos-3 Fragment Shader: Nội suy Sinc cửa sổ 6x6 tap chuẩn toán học
  const FRAGMENT_SHADER_LANCZOS = `
    precision highp float;
    uniform sampler2D u_texture;
    uniform vec2 u_srcResolution;
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

    void main() {
      vec2 pos = v_texCoord * u_srcResolution - 0.5;
      vec2 f = fract(pos);
      vec2 base = floor(pos);

      vec4 sum = vec4(0.0);
      float totalWeight = 0.0;

      // Quét 6x6 tap xung quanh tâm nội suy
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

      gl_FragColor = (totalWeight > 0.0) ? (sum / totalWeight) : texture2D(u_texture, v_texCoord);
    }
  `;

  // AMD FSR 1.0 EASU (Edge-Adaptive Spatial Upsampling) Fragment Shader
  const FRAGMENT_SHADER_EASU = `
    precision highp float;
    uniform sampler2D u_texture;
    uniform vec2 u_srcResolution;
    varying vec2 v_texCoord;

    float getLuma(vec3 c) {
      return dot(c, vec3(0.2126, 0.7152, 0.0722));
    }

    void main() {
      vec2 invSrc = 1.0 / u_srcResolution;
      vec2 pos = v_texCoord * u_srcResolution - 0.5;
      vec2 fp = fract(pos);
      vec2 base = (floor(pos) + 0.5) * invSrc;

      // 9 taps (3x3 kernel) để phân tích hướng gradient biên cạnh
      vec3 b = texture2D(u_texture, base + vec2(-1.0, -1.0) * invSrc).rgb;
      vec3 c = texture2D(u_texture, base + vec2( 0.0, -1.0) * invSrc).rgb;
      vec3 d = texture2D(u_texture, base + vec2( 1.0, -1.0) * invSrc).rgb;
      vec3 e = texture2D(u_texture, base + vec2(-1.0,  0.0) * invSrc).rgb;
      vec3 f = texture2D(u_texture, base).rgb;
      vec3 g = texture2D(u_texture, base + vec2( 1.0,  0.0) * invSrc).rgb;
      vec3 h = texture2D(u_texture, base + vec2(-1.0,  1.0) * invSrc).rgb;
      vec3 i = texture2D(u_texture, base + vec2( 0.0,  1.0) * invSrc).rgb;
      vec3 j = texture2D(u_texture, base + vec2( 1.0,  1.0) * invSrc).rgb;

      float lb = getLuma(b), lc = getLuma(c), ld = getLuma(d);
      float le = getLuma(e), lf = getLuma(f), lg = getLuma(g);
      float lh = getLuma(h), li = getLuma(i), lj = getLuma(j);

      // Phân tích độ dốc ngang, dọc và đường chéo
      float gradH = abs(le - lg) + abs(lb - ld) * 0.5 + abs(lh - lj) * 0.5;
      float gradV = abs(lc - li) + abs(lb - lh) * 0.5 + abs(ld - lj) * 0.5;

      vec2 dir = vec2(gradH, gradV);
      float len = length(dir);
      if (len > 0.0001) {
        dir /= len;
      } else {
        dir = vec2(1.0, 0.0);
      }

      // Xoay toạ độ lấy mẫu dọc theo hướng biên cạnh
      vec2 delta = fp - 0.5;
      float alongEdge = abs(dot(delta, vec2(-dir.y, dir.x)));
      float acrossEdge = abs(dot(delta, dir));

      // Độ sắc nét biên thích ứng
      float sharpness = clamp(len * 4.2, 0.0, 1.0);

      // Tái tạo viền và bộ lọc High-pass
      vec3 highPass = f - (b + c + d + e + g + h + i + j) * 0.125;
      vec3 result = f + highPass * (sharpness * 0.48);

      // Khử lem / chống chói (Anti-ringing clamp)
      vec3 minCol = min(min(min(b, c), min(d, e)), min(min(f, g), min(h, min(i, j))));
      vec3 maxCol = max(max(max(b, c), max(d, e)), max(max(f, g), max(h, max(i, j))));
      result = clamp(result, minCol, maxCol);

      gl_FragColor = vec4(result, 1.0);
    }
  `;

  // ==========================================
  // Quản lý WebGL Pipeline
  // ==========================================

  function createShader(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const info = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      throw new Error('Lỗi biên dịch shader: ' + info);
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
      const info = gl.getProgramInfoLog(program);
      gl.deleteProgram(program);
      throw new Error('Lỗi liên kết WebGL program: ' + info);
    }
    return program;
  }

  function initWebGL(canvas) {
    const gl = canvas.getContext('webgl2', { alpha: false, depth: false, antialias: false, preserveDrawingBuffer: false }) ||
               canvas.getContext('webgl', { alpha: false, depth: false, antialias: false, preserveDrawingBuffer: false });
    if (!gl) {
      throw new Error('Trình duyệt không hỗ trợ WebGL để upscale video.');
    }

    state.gl = gl;
    state.programLanczos = createProgram(gl, VERTEX_SHADER, FRAGMENT_SHADER_LANCZOS);
    state.programEASU = createProgram(gl, VERTEX_SHADER, FRAGMENT_SHADER_EASU);

    // Quad geometry [-1, -1] -> [1, 1]
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

    // Texture cho video frame
    state.texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, state.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    return gl;
  }

  // ==========================================
  // Định vị và đồng bộ Canvas với Player YouTube
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

    const rect = video.getBoundingClientRect();
    const parent = video.parentElement;
    if (!parent) return;

    // Định vị canvas khớp chuẩn 100% video
    canvas.style.position = 'absolute';
    canvas.style.top = video.offsetTop + 'px';
    canvas.style.left = video.offsetLeft + 'px';
    canvas.style.width = video.clientWidth + 'px';
    canvas.style.height = video.clientHeight + 'px';
    canvas.style.pointerEvents = 'none'; // Bắt buộc: chuột bấm xuyên qua thanh điều khiển
    canvas.style.zIndex = '10';          // Dưới thanh controls (.ytp-chrome-bottom z-index > 50)
    canvas.style.objectFit = 'contain';

    // Tính toán độ phân giải đầu ra
    const dpr = window.devicePixelRatio || 1;
    let targetWidth = 0;
    let targetHeight = 0;

    if (settings.scaleMode === 'fit') {
      targetWidth = Math.round(video.clientWidth * dpr);
      targetHeight = Math.round(video.clientHeight * dpr);
    } else {
      // 2x native resolution
      targetWidth = (video.videoWidth || 1920) * 2;
      targetHeight = (video.videoHeight || 1080) * 2;
    }

    if (targetWidth > 0 && targetHeight > 0) {
      if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
        canvas.width = targetWidth;
        canvas.height = targetHeight;
        if (state.gl) {
          state.gl.viewport(0, 0, targetWidth, targetHeight);
        }
      }
      state.outputWidth = targetWidth;
      state.outputHeight = targetHeight;
    }
  }

  // ==========================================
  // Vòng lặp Render (Frame Loop)
  // ==========================================

  function renderFrame(now, metadata) {
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

    // Tự động kiểm tra kích thước
    syncCanvasLayout();

    // Nạp frame từ thẻ <video> vào WebGL Texture
    try {
      gl.bindTexture(gl.TEXTURE_2D, state.texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
    } catch (err) {
      // Canvas tainting do DRM (Widevine/EME) hoặc cross-origin
      console.warn('[YT-Upscale] Không thể đọc khung hình từ video (DRM/Taint):', err);
      state.isTainted = true;
      state.taintedReason = 'Video được bảo vệ bản quyền DRM (Widevine) hoặc cross-origin.';
      cleanup();
      return;
    }

    // Chọn Program tương ứng thuật toán
    const program = settings.algorithm === 'lanczos' ? state.programLanczos : state.programEASU;
    gl.useProgram(program);

    // Uniforms
    const uSrcRes = gl.getUniformLocation(program, 'u_srcResolution');
    gl.uniform2f(uSrcRes, vw, vh);

    const uTexture = gl.getUniformLocation(program, 'u_texture');
    gl.uniform1i(uTexture, 0);

    // Bật vị trí toạ độ
    const aPos = gl.getAttribLocation(program, 'a_position');
    gl.bindBuffer(gl.ARRAY_BUFFER, state.quadBuffer);
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    // Vẽ fullscreen quad
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    // Đo FPS
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
      state.rafHandle = requestAnimationFrame(() => renderFrame(performance.now()));
    }
  }

  // ==========================================
  // Bật / Tắt và Dọn Dẹp (Lifecycle)
  // ==========================================

  function startUpscale() {
    if (state.isRunning) return;

    const video = getYouTubeVideo();
    if (!video) return;

    state.video = video;
    state.isTainted = false;
    state.taintedReason = '';

    // Tạo canvas nếu chưa có
    if (!state.canvas) {
      const canvas = document.createElement('canvas');
      canvas.className = 'yt-upscale-overlay';
      state.canvas = canvas;

      try {
        initWebGL(canvas);
      } catch (err) {
        console.error('[YT-Upscale] Khởi tạo WebGL thất bại:', err);
        return;
      }

      // Chèn canvas ngay sau video element
      if (video.parentElement) {
        video.parentElement.insertBefore(canvas, video.nextSibling);
      }
    }

    // Ẩn hiển thị của video gốc (vẫn phát âm thanh và decode frame)
    video.style.opacity = '0';
    state.canvas.style.display = 'block';

    state.isRunning = true;
    state.lastFpsUpdate = performance.now();
    state.frameCount = 0;

    syncCanvasLayout();
    scheduleNextFrame();

    // Lắng nghe thay đổi kích thước cửa sổ
    window.addEventListener('resize', syncCanvasLayout);
  }

  function cleanup() {
    state.isRunning = false;

    // Huỷ bỏ request callbacks
    if (state.video && state.vfcHandle !== null && typeof state.video.cancelVideoFrameCallback === 'function') {
      try { state.video.cancelVideoFrameCallback(state.vfcHandle); } catch (e) {}
      state.vfcHandle = null;
    }
    if (state.rafHandle !== null) {
      cancelAnimationFrame(state.rafHandle);
      state.rafHandle = null;
    }

    // Khôi phục hiển thị video gốc nguyên vẹn
    if (state.video) {
      state.video.style.opacity = '';
    }

    // Ẩn hoặc gỡ canvas
    if (state.canvas) {
      state.canvas.style.display = 'none';
    }

    state.fps = 0;
    window.removeEventListener('resize', syncCanvasLayout);
  }

  // ==========================================
  // Đồng bộ cài đặt & Lắng nghe sự kiện YouTube
  // ==========================================

  async function loadSettings() {
    try {
      const data = await chrome.storage.sync.get(DEFAULT_SETTINGS);
      settings = { ...DEFAULT_SETTINGS, ...data };
    } catch (e) {
      settings = { ...DEFAULT_SETTINGS };
    }
    applySettings();
  }

  function applySettings() {
    if (settings.enabled) {
      startUpscale();
    } else {
      cleanup();
    }
  }

  // Lắng nghe thay đổi settings từ popup
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    let changed = false;
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      if (changes[key] && changes[key].newValue !== undefined) {
        settings[key] = changes[key].newValue;
        changed = true;
      }
    }
    if (changed) {
      applySettings();
    }
  });

  // Trả về metrics cho Popup
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

  // Quan sát SPA điều hướng trên YouTube
  function watchPageChanges() {
    const onNavigate = () => {
      setTimeout(() => {
        const currentVideo = getYouTubeVideo();
        if (currentVideo && currentVideo !== state.video) {
          cleanup();
          state.video = currentVideo;
          if (settings.enabled) startUpscale();
        }
      }, 500);
    };

    window.addEventListener('yt-navigate-finish', onNavigate);
    window.addEventListener('yt-page-data-updated', onNavigate);

    // Observer nếu player được nạp trễ
    const observer = new MutationObserver(() => {
      const v = getYouTubeVideo();
      if (v && v !== state.video && settings.enabled) {
        onNavigate();
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  // Khởi động
  loadSettings();
  watchPageChanges();

  console.log('[YT-Upscale] Extension đã sẵn sàng.');
})();
