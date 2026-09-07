var SITE_BASE = (document.currentScript && document.currentScript.src || '').replace(/assets\/[^\/]*$/, '');
const VERT = `
  attribute vec2 position;
  void main() { gl_Position = vec4(position, 0.0, 1.0); }
`;
const FRAG = `
  precision mediump float;
  uniform sampler2D u_tex;
  uniform vec2  u_resolution;
  uniform vec2  u_pointer;
  uniform float u_time;
  uniform vec3  u_color;
  uniform float u_amp, u_freq_far, u_freq_near, u_detail_mix;
  uniform float u_near_damp, u_time_scale, u_octave_mix, u_swell;
  uniform float u_feather, u_bloom;
  uniform float u_smoke, u_smoke_spread, u_smoke_scale, u_smoke_speed;
  uniform float u_smoke_rise;

  float hash21(vec2 p){
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }
  float noise2(vec2 p){
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    float a = hash21(i + vec2(0.0, 0.0));
    float b = hash21(i + vec2(1.0, 0.0));
    float c = hash21(i + vec2(0.0, 1.0));
    float d = hash21(i + vec2(1.0, 1.0));
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
  }
  float fbm(vec2 p, float octaveMix){
    mat2 rot = mat2(1.6, 1.2, -1.2, 1.6);
    float o1 = 0.5 * (noise2(p) * 2.0 - 1.0);
    float o2 = o1 + 0.25 * (noise2(rot * p * 1.45) * 2.0 - 1.0);
    return mix(o1, o2, octaveMix);
  }

  // 25-tap disc blur. Radius is corrected for aspect so the feather stays
  // round on a wide canvas instead of smearing horizontally.
  float sampleA(vec2 uv, float r, float aspect){
    if (r <= 0.0002) return texture2D(u_tex, uv).a;
    vec2 rr = vec2(r / aspect, r);
    float a = texture2D(u_tex, uv).a * 2.0;
    float w = 2.0;
    for (int i = 0; i < 12; i++){
      float ang = float(i) * 0.5235988;
      vec2 d = vec2(cos(ang), sin(ang));
      a += texture2D(u_tex, uv + d * rr * 0.5).a * 1.0;  w += 1.0;
      a += texture2D(u_tex, uv + d * rr).a       * 0.5;  w += 0.5;
    }
    return a / w;
  }

  // Wide, cheap blur used only as the smoke's containment field. 25 taps over
  // three offset rings; the octagon banding it would otherwise show is hidden
  // by the noise it gets multiplied with.
  float haloA(vec2 uv, float r, float aspect){
    vec2 rr = vec2(r / aspect, r);
    float a = texture2D(u_tex, uv).a * 0.6;
    float w = 0.6;
    for (int i = 0; i < 8; i++){
      float ang = float(i) * 0.7853982;
      vec2 d1 = vec2(cos(ang), sin(ang));
      vec2 d2 = vec2(cos(ang + 0.3926991), sin(ang + 0.3926991));
      a += texture2D(u_tex, uv + d1 * rr * 0.45).a * 1.00;  w += 1.00;
      a += texture2D(u_tex, uv + d1 * rr * 0.80).a * 0.70;  w += 0.70;
      a += texture2D(u_tex, uv + d2 * rr).a        * 0.45;  w += 0.45;
    }
    return a / w;
  }

  void main(){
    vec2 st = gl_FragCoord.xy / u_resolution.xy;
    vec2 mouse = u_pointer / u_resolution.xy;

    float aspect = u_resolution.x / u_resolution.y;
    vec2 sa = vec2(st.x * aspect, st.y);
    vec2 ma = vec2(mouse.x * aspect, mouse.y);

    float dis = distance(ma, sa);
    float dis2 = dis * dis;
    float disNorm = dis2 / (1. + dis2);
    float influence = 1. - disNorm;
    float nearDamp = mix(1., u_near_damp, influence);

    float t = u_time * u_time_scale;
    vec2 p = sa * mix(u_freq_far, u_freq_near, influence);
    float baseX   = fbm(p + vec2(t, -t * 0.65), u_octave_mix);
    float detailX = fbm(p * 1.35 + vec2(-t * 1.2, t * 0.95), u_octave_mix);
    float baseY   = fbm(p + vec2(-t * 0.75, t * 0.55) + vec2(3.1, -2.7), u_octave_mix);
    float detailY = fbm(p * 1.28 + vec2(t * 1.35, -t * 1.05) + vec2(-5.2, 4.4), u_octave_mix);

    float bw = 1.0 - u_detail_mix;
    vec2 warp = vec2(baseX * bw + detailX * u_detail_mix,
                     baseY * bw + detailY * u_detail_mix) * u_amp;

    vec2 uv = st + warp * influence * nearDamp;
    uv = (uv - 0.5) * (1.0 - u_swell * disNorm) + 0.5;
    uv.y = 1.0 - uv.y;

    float a = sampleA(uv, u_feather, aspect);

    // Same bloom curve as the ring version: saturates the core to solid while
    // leaving the blurred rim as a soft falloff.
    float bloomed = min(0.02 / max(1.0 - a, 1e-4) - 0.02, 1.0);
    a = clamp(mix(a, bloomed, u_bloom), 0.0, 1.0);

    // ---- smoke -----------------------------------------------------------
    // A drifting fbm density, domain-warped by a second fbm so it curls, then
    // confined to a shell hugging the outside of the mark.
    float smoke = 0.0;
    if (u_smoke > 0.0001) {
      float halo = clamp(haloA(uv, u_smoke_spread, aspect), 0.0, 1.0);
      float shell = halo * (1.0 - a);           // outside the shape only

      float ts = u_time * u_smoke_speed;
      vec2 q = sa * u_smoke_scale;
      vec2 curl = vec2(
        fbm(q + vec2(ts * 0.60, -ts * 0.40), 0.75),
        fbm(q + vec2(-ts * 0.50, ts * 0.70) + vec2(5.2, -3.7), 0.75)
      );
      float d = fbm(q + curl * 1.6 + vec2(ts * 0.25, -ts * u_smoke_rise), 0.85);
      d = clamp(d * 0.5 + 0.5, 0.0, 1.0);
      d = smoothstep(0.30, 0.85, d);

      smoke = shell * d * u_smoke;
    }

    float outA = clamp(a + smoke, 0.0, 1.0);
    gl_FragColor = vec4(u_color * outA, outA);
  }
`;
const SVG  = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 912 444"><g transform="translate(0,444) scale(0.1,-0.1)" fill="#fff"><path d="M4374 4390 c-787 -65 -1461 -516 -1809 -1210 -169 -339 -229 -572
-285 -1105 -23 -211 -64 -370 -127 -485 -50 -90 -158 -194 -263 -252 -47 -25
-292 -133 -545 -238 -253 -106 -613 -256 -800 -335 -187 -78 -377 -157 -422
-175 -46 -19 -81 -35 -80 -37 7 -7 710 181 1222 327 693 198 1002 293 2195
678 175 57 792 268 2040 697 272 93 1287 466 1655 608 706 272 1915 770 1902
784 -3 2 -69 -14 -148 -36 -320 -89 -1551 -422 -1649 -446 -138 -34 -291 -43
-382 -21 -87 20 -193 73 -288 144 -41 30 -174 155 -295 277 -227 228 -317 307
-490 424 -302 206 -640 339 -977 385 -139 19 -331 26 -454 16z m499 -569 c354
-72 634 -225 921 -501 183 -176 406 -448 406 -495 0 -12 -8 -32 -17 -44 -21
-24 -373 -175 -384 -164 -4 5 -21 43 -39 85 -140 341 -445 617 -806 731 -147
47 -247 61 -409 61 -169 -1 -274 -20 -449 -81 -405 -141 -706 -448 -834 -853
-44 -139 -57 -227 -57 -390 0 -150 13 -249 47 -359 15 -50 17 -65 7 -71 -21
-14 -353 -100 -382 -100 -15 0 -37 10 -48 21 -21 21 -21 26 -16 273 9 429 69
706 213 986 88 170 178 294 309 425 138 138 262 226 440 314 187 92 357 147
549 176 129 20 419 12 549 -14z m-23 -414 c321 -84 574 -260 746 -518 65 -97
130 -226 140 -277 l6 -28 -219 -86 c-550 -216 -1383 -502 -1971 -677 -112 -34
-209 -61 -217 -61 -13 0 -45 104 -64 214 -16 86 -13 317 4 411 72 400 322 734
684 915 84 42 277 106 376 124 127 24 393 16 515 -17z M6152 2039 c-51 -567
-376 -1047 -879 -1298 -119 -60 -301 -124 -437 -153 -87 -19 -132 -22 -316
-22 -184 0 -229 3 -316 22 -338 73 -622 234 -857 482 l-96 102 -63 -48 c-103
-78 -196 -163 -219 -200 -27 -44 -29 -116 -5 -167 45 -92 311 -319 516 -437
229 -133 494 -224 771 -264 123 -18 393 -21 519 -6 839 104 1527 649 1788
1415 50 148 82 283 94 405 14 138 7 179 -35 227 -51 58 -81 66 -277 71 l-176
4 -12 -133z M5758 2103 c-10 -2 -18 -8 -18 -12 0 -33 -34 -191 -56 -256 -100
-304 -324 -564 -610 -708 -77 -39 -244 -94 -342 -114 -106 -20 -315 -23 -422
-4 -222 39 -445 150 -618 307 -47 42 -67 54 -82 49 -11 -3 -20 -10 -20 -14 0
-5 33 -40 73 -78 270 -257 671 -378 1047 -318 109 18 298 78 391 126 350 175
592 494 674 887 16 79 20 143 8 141 -5 -1 -16 -3 -25 -6z"/></g></svg>`;
function mountMark(wrap, U, opts) {
  opts = opts || {};
  const COLOR = opts.color || '#ffffff';
  const MAX_DPR = opts.maxDpr || 2;
  const SS = 1.5;
  const EASE_IN = 0.14, EASE_OUT = 0.05;
  const hoverOnly = opts.hoverOnly !== false;
  const cv = document.createElement('canvas');
  wrap.appendChild(cv);
  const gl = cv.getContext('webgl', { alpha: true, antialias: true });
  if (!gl) return;
  const sh = (t, s) => { const x = gl.createShader(t); gl.shaderSource(x, s);
    gl.compileShader(x);
    if (!gl.getShaderParameter(x, gl.COMPILE_STATUS)) console.error(gl.getShaderInfoLog(x));
    return x; };
  const prog = gl.createProgram();
  gl.attachShader(prog, sh(gl.VERTEX_SHADER, VERT));
  gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FRAG));
  gl.linkProgram(prog); gl.useProgram(prog);
  const bf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, bf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,1,-1,-1,1,1,1]), gl.STATIC_DRAW);
  const ap = gl.getAttribLocation(prog, 'position');
  gl.enableVertexAttribArray(ap); gl.vertexAttribPointer(ap, 2, gl.FLOAT, false, 0, 0);
  const L = {};
  for (const n of ['u_tex','u_resolution','u_pointer','u_time','u_color','u_amp',
    'u_freq_far','u_freq_near','u_detail_mix','u_near_damp','u_time_scale',
    'u_octave_mix','u_swell','u_feather','u_bloom','u_smoke','u_smoke_spread',
    'u_smoke_scale','u_smoke_speed','u_smoke_rise'])
    L[n] = gl.getUniformLocation(prog, n);
  const hex = COLOR.replace('#','');
  const col = [parseInt(hex.slice(0,2),16)/255, parseInt(hex.slice(2,4),16)/255,
               parseInt(hex.slice(4,6),16)/255];
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
  const off = document.createElement('canvas');
  const octx = off.getContext('2d');
  const img = new Image();
  let ready = false;
  const paintTexture = () => {
    if (!img.complete || !img.naturalWidth) return;
    const r = wrap.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    const tw = Math.max(2, Math.round(r.width * dpr * SS));
    const th = Math.max(2, Math.round(r.height * dpr * SS));
    if (off.width !== tw || off.height !== th) { off.width = tw; off.height = th; }
    octx.clearRect(0, 0, tw, th);
    const pad = Math.min(0.26, 0.10 + (U.smokeSpread || 0) * 0.9);
    octx.drawImage(img, tw * pad, th * pad, tw * (1 - 2*pad), th * (1 - 2*pad));
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, off);
    ready = true;
  };
  const resize = () => {
    const r = wrap.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    cv.width  = Math.max(1, Math.round(r.width  * dpr));
    cv.height = Math.max(1, Math.round(r.height * dpr));
    paintTexture();
  };
  img.onload = () => { resize(); };
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(SVG);
  new ResizeObserver(resize).observe(wrap);
  let hovering = false;
  const cur = { x: 0.5, y: 0.5 };
  const ptr = { x: 0, y: 0 };
  wrap.addEventListener('pointerenter', () => { hovering = true; });
  wrap.addEventListener('pointerleave', () => { hovering = false; });
  wrap.addEventListener('pointermove', (e) => {
    const r = cv.getBoundingClientRect();
    if (!r.width) return;
    ptr.x = (e.clientX - r.left) / r.width;
    ptr.y = 1 - (e.clientY - r.top) / r.height;
  });
  const t0 = performance.now();
  let lastF = t0;
  (function draw(now) {
    requestAnimationFrame(draw);
    if (!ready) return;
    const dt = Math.min((now - lastF) / 1000, 0.05); lastF = now;
    const el = (now - t0) * 0.001;
    if (opts.forcePointer) {
      cur.x = opts.forcePointer[0]; cur.y = opts.forcePointer[1];
    } else {
      const it = el * U.idleSpeed;
      const ix = 0.5 + Math.cos(it) * U.idleRadius;
      const iy = 0.5 + Math.sin(it * 0.73) * U.idleRadius * 0.8;
      const tx = hoverOnly ? (hovering ? ptr.x : ix) : ptr.x;
      const ty = hoverOnly ? (hovering ? ptr.y : iy) : ptr.y;
      const k = hovering ? EASE_IN : EASE_OUT;
      const a = 1 - Math.pow(1 - k, dt * 60);
      cur.x += (tx - cur.x) * a; cur.y += (ty - cur.y) * a;
    }
    gl.viewport(0, 0, cv.width, cv.height);
    gl.clearColor(0,0,0,0); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(L.u_tex, 0);
    gl.uniform2f(L.u_resolution, cv.width, cv.height);
    gl.uniform2f(L.u_pointer, cur.x * cv.width, cur.y * cv.height);
    gl.uniform1f(L.u_time, el);
    gl.uniform3f(L.u_color, col[0], col[1], col[2]);
    gl.uniform1f(L.u_amp, U.amplitude);
    gl.uniform1f(L.u_freq_far, U.frequencyFar);
    gl.uniform1f(L.u_freq_near, U.frequencyNear);
    gl.uniform1f(L.u_detail_mix, U.detailMix);
    gl.uniform1f(L.u_near_damp, U.nearDamp);
    gl.uniform1f(L.u_time_scale, U.timeScale);
    gl.uniform1f(L.u_octave_mix, U.octaveMix);
    gl.uniform1f(L.u_swell, U.swell);
    gl.uniform1f(L.u_feather, U.feather);
    gl.uniform1f(L.u_bloom, U.bloom);
    gl.uniform1f(L.u_smoke, U.smoke);
    gl.uniform1f(L.u_smoke_spread, U.smokeSpread);
    gl.uniform1f(L.u_smoke_scale, U.smokeScale);
    gl.uniform1f(L.u_smoke_speed, U.smokeSpeed);
    gl.uniform1f(L.u_smoke_rise, U.smokeRise);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  })(t0);
}
window.__mountBlackHole = (elId) => mountMark(document.getElementById(elId), {
  amplitude: 0.06,
  frequencyFar: 6.0,
  frequencyNear: 10.0,
  detailMix: 0.45,
  octaveMix: 0.6,
  timeScale: 1.2,
  nearDamp: 0.55,
  swell: 0.12,
  feather: 0.01,
  bloom: 1.0,
  smoke: 0.55,
  smokeSpread: 0.15,
  smokeScale: 7.5,
  smokeSpeed: 0.35,
  smokeRise: 0.55,
  idleSpeed: 0.65,
  idleRadius: 0.26,
}, { color: '#ffffff', maxDpr: 2, hoverOnly: true });
window.__mountBlackHole('navLogo');
window.__mountBlackHole('footLogo');
window.mountSpringPhotos = function (root) {
  if (!root) return null;
  var photos = [].slice.call(root.querySelectorAll('[data-spring-photo]'));
  if (!photos.length) return null;
  var SMOOTH = 0.16, GAIN = 8.5, RATE = 0.55,
      MAX_X = 1.87, MAX_Y = 0.66, ROT = 4.2, RADIUS_FRAC = 0.71;
  var reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  var slots = photos.map(function (el) {
    return { cx: +el.dataset.cx, cy: +el.dataset.cy, rot: +el.dataset.rot || 0,
             w: 0, el: el };
  });
  var st = slots.map(function () { return { x: 0, y: 0 }; });
  var rawX = 0, rawY = 0, lastX = null, lastY = null, ptrX = null, ptrY = null;
  var vx = 0, vy = 0;
  addEventListener('pointermove', function (e) {
    if (lastX !== null) { rawX += e.clientX - lastX; rawY += e.clientY - lastY; }
    lastX = ptrX = e.clientX; lastY = ptrY = e.clientY;
  }, { passive: true });
  var drop = function () { lastX = lastY = null; ptrX = ptrY = null; };
  addEventListener('pointerleave', drop);
  addEventListener('blur', drop);
  function clamp(v, m) { return v < -m ? -m : (v > m ? m : v); }
  var half = 1;
  function measure() {
    var r = root.getBoundingClientRect();
    half = Math.max(1, r.width / 2);
    for (var i = 0; i < slots.length; i++)
      slots[i].w = slots[i].el.offsetWidth || slots[i].w || 1;
  }
  measure();
  addEventListener('resize', measure, { passive: true });
  if (window.ResizeObserver) new ResizeObserver(measure).observe(root);
  slots.forEach(function (s) { s.el.style.transform = 'rotate(' + s.rot + 'deg)'; });
  if (reduce) return { photos: photos };
  var prev = performance.now(), running = true;
  if (window.IntersectionObserver) {
    new IntersectionObserver(function (es) {
      var vis = es[0].isIntersecting;
      if (vis && !running) { running = true; prev = performance.now(); requestAnimationFrame(frame); }
      running = vis;
    }, { rootMargin: '120px' }).observe(root);
  }
  function frame(now) {
    var dt = now - prev; prev = now;
    if (dt > 64) dt = 64;
    var f = Math.max(dt / 16.6667, 0.05);
    var aV = 1 - Math.pow(1 - SMOOTH, f);
    vx += (rawX / f - vx) * aV;
    vy += (rawY / f - vy) * aV;
    rawX = 0; rawY = 0;
    var box = root.getBoundingClientRect();
    var throwX = vx * GAIN, throwY = vy * GAIN;
    var a = 1 - Math.pow(1 - RATE, f);
    var rad = Math.max(1, RADIUS_FRAC * half);
    var inside = ptrX !== null &&
                 ptrX >= box.left && ptrX <= box.right &&
                 ptrY >= box.top  && ptrY <= box.bottom;
    for (var i = 0; i < slots.length; i++) {
      var s = slots[i], p = st[i], w0 = s.w || 1;
      var dx = (box.left + s.cx - ptrX) / rad;
      var dy = (box.top  + s.cy - ptrY) / rad;
      var w = inside ? Math.exp(-(dx * dx + dy * dy)) : 0;
      p.x += (clamp(throwX * w, MAX_X * w0) - p.x) * a;
      p.y += (clamp(throwY * w, MAX_Y * w0) - p.y) * a;
      s.el.style.transform =
        'translate3d(' + p.x.toFixed(2) + 'px,' + p.y.toFixed(2) + 'px,0) ' +
        'rotate(' + (s.rot + (p.x / w0) * ROT).toFixed(3) + 'deg)';
    }
    if (running) requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
  return { photos: photos };
};
(function(){ var el = document.getElementById('fairPhotos');
  if (el && window.mountSpringPhotos) window.mountSpringPhotos(el); })();
window.mountVimeoFit = function () {
  var slots = [].slice.call(document.querySelectorAll('.fair__video'));
  if (!slots.length) return null;
  var reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  var api = null, waiting = [], asked = false;
  function withApi(fn) {
    if (api) return fn(api);
    waiting.push(fn);
    if (asked) return;
    asked = true;
    var s = document.createElement('script');
    s.src = 'https://player.vimeo.com/api/player.js';
    s.async = true;
    s.onload = function () {
      api = window.Vimeo;
      if (!api) return;
      var q = waiting; waiting = [];
      q.forEach(function (f) { f(api); });
    };
    document.head.appendChild(s);
  }
  slots.forEach(function (slot) {
    var frame = slot.querySelector('iframe');
    if (!frame) return;
    var player = null;
    withApi(function (v) {
      player = new v.Player(frame);
      Promise.all([player.getVideoWidth(), player.getVideoHeight()])
        .then(function (d) {
          if (d[0] > 0 && d[1] > 0)
            slot.style.setProperty('--ar', d[0] + ' / ' + d[1]);
        })
        .catch(function () {});
      if (reduce) {
        player.getDuration()
          .then(function (t) { return player.setCurrentTime(t * 0.45); })
          .then(function () { return player.pause(); })
          .catch(function () {});
      }
    });
    if (reduce || !window.IntersectionObserver) return;
    new IntersectionObserver(function (es) {
      if (!player) return;
      (es[0].isIntersecting ? player.play() : player.pause())
        .catch(function () {});
    }, { rootMargin: '200px' }).observe(slot);
  });
  return { slots: slots };
};
(function(){ if (window.mountVimeoFit) window.mountVimeoFit(); })();
window.mountEcoFit = function () {
  var frames = [].slice.call(document.querySelectorAll('[data-eco-fit]'));
  if (!frames.length) return null;
  var MIN  = 0.55;
  var STEP = 15;
  var SLOT = 419;
  function fit() {
    frames.forEach(function (frame) {
      var inner = frame.querySelector('iframe');
      if (!inner) return;
      var w  = frame.clientWidth;
      var iw = +frame.dataset.ecoW || 1180;
      var ih = +frame.dataset.ecoH || 982;
      var s  = Math.max(w / iw, MIN);
      inner.style.width  = iw + 'px';
      inner.style.height = ih + 'px';
      inner.style.transform = 'scale(' + s.toFixed(6) + ')';
      var h = Math.round(ih * s);
      frame.style.height = h + 'px';
      frame.style.overflowX = iw * s > w + 0.5 ? 'auto' : 'hidden';
      var section = frame.parentElement;
      if (section) section.style.paddingBottom =
        (((SLOT - h) % STEP) + STEP) % STEP + 'px';
    });
  }
  fit();
  addEventListener('resize', fit, { passive: true });
  if (window.ResizeObserver) {
    var ro = new ResizeObserver(fit);
    frames.forEach(function (f) { ro.observe(f); });
  }
  return { frames: frames, fit: fit };
};
(function(){ if (window.mountEcoFit) window.mountEcoFit(); })();
window.mountImageReveal = function () {
  var items = [].slice.call(document.querySelectorAll('.hh__reveal, .nv__reveal, .irc__reveal'));
  if (!items.length) return null;
  function show(el) { el.classList.add('is-in'); }
  if (matchMedia('(prefers-reduced-motion: reduce)').matches ||
      !window.IntersectionObserver) {
    items.forEach(show);
    return { items: items };
  }
  var STEP = 90,
      MAX  = 4;
  var groups = [], counts = [];
  items.forEach(function (el) {
    var g = (el.closest && el.closest('section, ul')) || el.parentNode;
    var i = groups.indexOf(g);
    if (i < 0) { i = groups.length; groups.push(g); counts.push(0); }
    el.style.setProperty('--reveal-delay',
      Math.min(counts[i], MAX) * STEP + 'ms');
    counts[i]++;
  });
  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      if (!e.isIntersecting) return;
      show(e.target);
      io.unobserve(e.target);
    });
  }, { rootMargin: '0px 0px -10% 0px', threshold: 0.01 });
  items.forEach(function (el) { io.observe(el); });
  return { items: items, observer: io };
};
(function(){ if (window.mountImageReveal) window.mountImageReveal(); })();
window.mountHandStage = function () {
  var stages = [].slice.call(document.querySelectorAll('[data-hh-stage]'));
  if (!stages.length) return null;
  function loadBelts(stage) {
    if (stage.dataset.loaded) return;
    stage.dataset.loaded = '1';
    [].forEach.call(stage.querySelectorAll('img[loading="lazy"]'), function (im) {
      im.loading = 'eager';
    });
  }
  if (!window.IntersectionObserver) {
    stages.forEach(function (s) { loadBelts(s); s.classList.add('is-running'); });
    return { stages: stages };
  }
  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      if (e.isIntersecting) loadBelts(e.target);
      e.target.classList.toggle('is-running', e.isIntersecting);
    });
  }, { rootMargin: '600px 0px' });
  stages.forEach(function (s) { io.observe(s); });
  document.addEventListener('visibilitychange', function () {
    if (document.hidden)
      stages.forEach(function (s) { s.classList.remove('is-running'); });
    else
      stages.forEach(function (s) {
        var r = s.getBoundingClientRect();
        s.classList.toggle('is-running', r.bottom > -200 && r.top < innerHeight + 200);
      });
  });
  return { stages: stages, observer: io };
};
(function(){ if (window.mountHandStage) window.mountHandStage(); })();
window.mountBoardFit = function () {
  var boards = [].slice.call(document.querySelectorAll('.nv__board, .irc__fit'));
  if (!boards.length) return null;
  var W = 960;
  boards.forEach(function (b) {
    if (b.firstElementChild && b.firstElementChild.classList &&
        b.firstElementChild.classList.contains('fit-in')) return;
    var inner = document.createElement('div');
    inner.className = 'fit-in nv__board-in';
    while (b.firstChild) inner.appendChild(b.firstChild);
    b.appendChild(inner);
    b.dataset.nvH = Math.round(b.getBoundingClientRect().height) || 644;
  });
  function fit() {
    boards.forEach(function (b) {
      var inner = b.firstElementChild;
      if (!inner) return;
      var h = +b.dataset.nvH || 644;
      var s = Math.min(1, b.clientWidth / W);
      inner.style.width  = W + 'px';
      inner.style.height = h + 'px';
      inner.style.transform = s < 1 ? 'scale(' + s.toFixed(6) + ')' : '';
      b.style.height = Math.round(h * s) + 'px';
    });
  }
  fit();
  addEventListener('resize', fit, { passive: true });
  if (window.ResizeObserver) {
    var ro = new ResizeObserver(fit);
    boards.forEach(function (b) { ro.observe(b); });
  }
  return { boards: boards, fit: fit };
};
(function(){ if (window.mountBoardFit) window.mountBoardFit(); })();
window.mountWipe = function () {
  var stages = [].slice.call(document.querySelectorAll('[data-irc-wipe]'));
  if (!stages.length) return null;
  stages.forEach(function (stage) {
    var handle = stage.querySelector('.irc__handle');
    var pos = 50;
    function set(p, announce) {
      pos = Math.max(0, Math.min(100, p));
      stage.style.setProperty('--wipe', pos.toFixed(3) + '%');
      if (handle && announce !== false)
        handle.setAttribute('aria-valuenow', Math.round(pos));
    }
    function fromEvent(e) {
      var r = stage.getBoundingClientRect();
      if (!r.width) return;
      set(((e.clientX - r.left) / r.width) * 100);
    }
    var dragging = false;
    stage.addEventListener('pointerdown', function (e) {
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      dragging = true;
      stage.classList.add('is-dragging');
      try { stage.setPointerCapture(e.pointerId); } catch (err) {}
      fromEvent(e);
      e.preventDefault();
    });
    stage.addEventListener('pointermove', function (e) {
      if (dragging) fromEvent(e);
    });
    function end(e) {
      if (!dragging) return;
      dragging = false;
      stage.classList.remove('is-dragging');
      try { stage.releasePointerCapture(e.pointerId); } catch (err) {}
    }
    stage.addEventListener('pointerup', end);
    stage.addEventListener('pointercancel', end);
    if (handle) handle.addEventListener('keydown', function (e) {
      var step = e.shiftKey ? 10 : 2, next = null;
      if (e.key === 'ArrowLeft'  || e.key === 'ArrowDown') next = pos - step;
      if (e.key === 'ArrowRight' || e.key === 'ArrowUp')   next = pos + step;
      if (e.key === 'Home') next = 0;
      if (e.key === 'End')  next = 100;
      if (next === null) return;
      e.preventDefault();
      set(next);
    });
    set(50);
  });
  return { stages: stages };
};
(function(){ if (window.mountWipe) window.mountWipe(); })();
window.mountGridSnap = function () {
  var main = document.querySelector('[data-grid-snap]');
  if (!main) return null;
  var root = document.documentElement;
  var textSel = main.getAttribute('data-grid-snap') || '';
  function firstBaseline(el) {
    var d = getComputedStyle(el).display;
    if (/flex|grid/.test(d)) {
      var kid = el.firstElementChild;
      if (!kid) return null;
      return firstBaseline(kid);
    }
    var probe = document.createElement('span');
    probe.style.cssText = 'display:inline-block;width:0;height:0;' +
                          'vertical-align:baseline;overflow:hidden';
    el.insertBefore(probe, el.firstChild);
    var y = probe.getBoundingClientRect().bottom;
    probe.remove();
    return y;
  }
  function scaleOf(el) {
    var s = 1, n = el;
    while (n && n !== document.body) {
      var t = getComputedStyle(n).transform;
      if (t && t !== 'none') {
        var m = t.match(/matrix\(([-\d.eE]+)/);
        if (m) s *= parseFloat(m[1]) || 1;
      }
      n = n.parentElement;
    }
    return s || 1;
  }
  function nudge(el, delta) {
    if (!delta) return;
    var s = scaleOf(el);
    var was = +(el.dataset.snapY || 0);
    var now = was + delta / (s || 1);
    el.dataset.snapY = now;
    el.style.translate = '0 ' + now.toFixed(3) + 'px';
  }
  function run() {
    var cs   = getComputedStyle(root);
    var step = parseFloat(cs.getPropertyValue('--grid-step')) || 15;
    var top  = parseFloat(cs.getPropertyValue('--grid-top'));
    if (!isFinite(top)) return;
    function toRule(y) {
      var off = ((y - top) % step + step) % step;
      return off <= step / 2 ? -off : step - off;
    }
    var lastIn = new Map();
    [].forEach.call(main.querySelectorAll(textSel), function (el) {
      if (/(?:^|\s)[a-z]+__reveal(?:\s|$)/.test(el.className || '')) return;
      if (!el.textContent || !el.textContent.trim()) return;
      var box = el.getBoundingClientRect();
      if (!box.height) return;
      var prev = lastIn.get(el.parentElement);
      var gap   = prev ? box.top - prev.bottom : 1e9;
      var tight = prev && gap > -6 && gap < 14;
      if (tight) {
        nudge(el, prev.moved);
        lastIn.set(el.parentElement,
                   { bottom: box.bottom + prev.moved, moved: prev.moved });
        return;
      }
      var base = firstBaseline(el);
      if (base === null) return;
      var d = toRule(base + scrollY);
      el.dataset.snapHead = '1';
      nudge(el, d);
      lastIn.set(el.parentElement, { bottom: box.bottom + d, moved: d });
    });
  }
  function reset() {
    [].forEach.call(main.querySelectorAll('[data-snap-y]'), function (el) {
      el.style.translate = ''; delete el.dataset.snapY; delete el.dataset.snapHead;
    });
    [].forEach.call(main.querySelectorAll('[data-snap-head]'), function (el) {
      delete el.dataset.snapHead;
    });
    [].forEach.call(main.children, function (el) {
      if (el.dataset && el.dataset.snapY !== undefined) {
        el.style.translate = ''; delete el.dataset.snapY;
      }
    });
  }
  function refresh() { reset(); run(); }
  refresh();
  addEventListener('resize', function () {
    clearTimeout(refresh._t);
    refresh._t = setTimeout(refresh, 120);
  }, { passive: true });
  addEventListener('load', refresh);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(refresh);
  return { refresh: refresh };
};
(function(){ if (window.mountGridSnap) window.mountGridSnap(); })();
(function(){
  var page = document.querySelector('.page'),
      nav  = document.querySelector('.nav'),
      foot = document.querySelector('.foot'),
      root = document.documentElement;
  if (!(page && nav && foot)) return;
  function fit(){
    var phase = parseFloat(getComputedStyle(root).getPropertyValue('--grid-phase')) || 0;
    var top = nav.offsetHeight - 1 + phase;
    var h   = Math.max(0, page.offsetHeight - top);
    root.style.setProperty('--grid-top', top + 'px');
    root.style.setProperty('--grid-h',   h   + 'px');
    var fh = foot.offsetHeight;
    root.dataset.footReveal = fh <= innerHeight * 0.7 ? 'on' : 'off';
    root.style.setProperty('--foot-h', fh + 'px');
  }
  fit();
  addEventListener('resize', fit, { passive:true });
  addEventListener('load', fit);
  if (window.ResizeObserver){ var ro = new ResizeObserver(fit); ro.observe(page); ro.observe(foot); }
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(fit);
})();
(function(){
  var root = document.documentElement, on = null;
  function read(){
    var now = (scrollY || root.scrollTop || 0) > 60;
    if (now === on) return;
    on = now;
    if (now) root.setAttribute('data-scrolled', '');
    else     root.removeAttribute('data-scrolled');
  }
  read();
  addEventListener('scroll', read, { passive: true });
  addEventListener('resize', read, { passive: true });
})();
(function(){
  var reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  document.addEventListener('click', function(e){
    var a = e.target.closest && e.target.closest('a[href$="#contact"]');
    if (!a) return;
    e.preventDefault();
    scrollTo({ top: document.documentElement.scrollHeight,
               behavior: reduce ? 'auto' : 'smooth' });
  });
})();
(function(){
  var btn = document.getElementById('sndFooter');
  var tip = document.getElementById('sndTip');
  var off = false;
  function apply(){
    document.documentElement.dataset.sound = off ? 'off' : 'on';
    if (window.expeditionFan && window.expeditionFan.sound) window.expeditionFan.sound.setMuted(off);
    if (window.cardHoverSound) window.cardHoverSound.enabled = !off;
    if (window.writingSound) window.writingSound.setMuted(off);
    var label = off ? 'Unmute sound effects' : 'Mute sound effects';
    if (btn) {
      btn.setAttribute('aria-pressed', off ? 'true' : 'false');
      btn.setAttribute('aria-label', label);
      btn.title = label;
    }
    if (tip) tip.textContent = label;
  }
  if (btn) btn.addEventListener('click', function(){
    off = !off;
    btn.classList.remove('is-swap');
    void btn.offsetWidth;
    btn.classList.add('is-swap');
    clearTimeout(btn._swap);
    btn._swap = setTimeout(function(){ btn.classList.remove('is-swap'); }, 220);
    apply();
  });
  apply();
})();
(function(){
  var SPEAKER = (SITE_BASE+"assets/media/1d75baa585db.mp3");
  var CONTACT = (SITE_BASE+"assets/media/495bc28c2d84.mp3");
  var LOGO    = (SITE_BASE+"assets/media/ab00208a9e4d.mp3");
  var quiet = matchMedia('(prefers-reduced-motion: reduce)');
  function muted(){ return document.documentElement.dataset.sound === 'off'; }
  function voice(src, vol){
    var MAX = 4, pool = [], next = 0;
    var seed = new Audio(src); seed.preload = 'auto'; seed.volume = vol;
    pool.push(seed);
    return function(){
      var a = null, i;
      for (i = 0; i < pool.length; i++)
        if (pool[i].paused || pool[i].ended) { a = pool[i]; break; }
      if (!a && pool.length < MAX) {
        a = seed.cloneNode(); pool.push(a);
      }
      if (!a) { a = pool[next % pool.length]; next++; }
      a.volume = vol;
      try { a.currentTime = 0; } catch (e) {}
      var p = a.play(); if (p && p.catch) p.catch(function(){});
    };
  }
  var playSpeaker = voice(SPEAKER, .55),
      playContact = voice(CONTACT, .35),
      playLogo    = voice(LOGO,    .35);
  var sw = document.getElementById('sndFooter');
  if (sw) sw.addEventListener('click', function(){ playSpeaker(); });
  function onTap(el, play){
    el.addEventListener('click', function(e){
      if (muted()) return;
      play();
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey ||
          e.altKey || e.button !== 0 || el.target === '_blank') return;
      var here = location.href.split('#')[0];
      var to   = el.href ? el.href.split('#')[0] : here;
      if (to === here) {
        if (!el.hash) {
          e.preventDefault();
          scrollTo({ top: 0, behavior: quiet.matches ? 'auto' : 'smooth' });
        }
        return;
      }
      if (el.protocol && el.protocol !== 'http:' && el.protocol !== 'https:' &&
          el.protocol !== 'file:') return;
      if (quiet.matches) return;
      e.preventDefault();
      setTimeout(function(){ location.href = el.href; }, 150);
    });
  }
  (function(){
    function copy(text){
      if (navigator.clipboard && navigator.clipboard.writeText) {
        return navigator.clipboard.writeText(text).then(function(){ return true; },
                                                        function(){ return legacy(text); });
      }
      return Promise.resolve(legacy(text));
    }
    function legacy(text){
      try{
        var ta = document.createElement('textarea');
        ta.value = text; ta.setAttribute('readonly','');
        ta.style.cssText = 'position:fixed;top:0;left:-9999px;opacity:0';
        document.body.appendChild(ta);
        ta.select(); ta.setSelectionRange(0, text.length);
        var ok = document.execCommand('copy');
        document.body.removeChild(ta);
        return !!ok;
      }catch(e){ return false; }
    }
    var quiet = matchMedia('(prefers-reduced-motion: reduce)');
    var toast = document.createElement('div');
    toast.className = 'toast';
    toast.setAttribute('role', 'status');
    toast.setAttribute('aria-live', 'polite');
    toast.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"' +
      ' stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M20 6 9 17l-5-5"/></svg><span></span>';
    var toastMsg = toast.querySelector('span'), toastOff = 0;
    (document.body || document.documentElement).appendChild(toast);
    function say(ok, email){
      toastMsg.innerHTML = ok
        ? '<b>' + email + '</b> copied to clipboard'
        : 'Couldn’t copy — the address is <b>' + email + '</b>';
      toast.querySelector('svg').style.display = ok ? '' : 'none';
      toast.dataset.show = '1';
      clearTimeout(toastOff);
      toastOff = setTimeout(function(){ delete toast.dataset.show; }, 1000);
    }
    [].forEach.call(document.querySelectorAll('.cbtn'), function(btn){
      var wrap  = btn.parentNode,
          email = btn.dataset.email || '',
          shine = btn.querySelector('.cbtn__shine'),
          tick  = btn.querySelector('.cbtn__tick path'),
          said  = btn.querySelector('.cbtn__said'),
          halos = [].slice.call(wrap.querySelectorAll('.cbtn__halo')),
          slots = { idle:   btn.querySelector('.cbtn__slot--idle'),
                    hover:  btn.querySelector('.cbtn__slot--hover'),
                    copied: btn.querySelector('.cbtn__slot--copied') },
          mode = 'idle', inside = false, widths = {}, t1 = 0, t2 = 0;
      function measure(){
        var em = parseFloat(getComputedStyle(btn).fontSize) || 14, k;
        for (k in slots) if (slots[k])
          widths[k] = Math.max(7 * em, slots[k].offsetWidth + 2.3 * em);
        if (widths[mode]) btn.style.width = widths[mode] + 'px';
      }
      measure();
      if (document.fonts && document.fonts.ready) document.fonts.ready.then(measure);
      addEventListener('resize', measure, { passive:true });
      function sweep(ms, peak){
        if (!shine || quiet.matches || !shine.animate) return;
        var w = btn.getBoundingClientRect().width;
        shine.animate([
          { transform:'translateX(' + (-0.18 * w) + 'px)', opacity:0 },
          { transform:'translateX(' + ( 0.35 * w) + 'px)', opacity:peak, offset:.45 },
          { transform:'translateX(' + ( 1.15 * w) + 'px)', opacity:0 }
        ], { duration:ms, easing:'cubic-bezier(.32,.06,.28,1)' });
      }
      function go(next){
        if (mode === next) return;
        btn.dataset.prev = mode;
        mode = next;
        btn.dataset.mode = next;
        if (widths[next]) btn.style.width = widths[next] + 'px';
        if (!quiet.matches) {
          btn.dataset.morph = '1';
          clearTimeout(t1);
          t1 = setTimeout(function(){ delete btn.dataset.morph; }, 200);
        }
      }
      btn.addEventListener('pointerenter', function(){
        inside = true;
        if (mode !== 'copied') { go('hover'); sweep(880, .7); }
      });
      btn.addEventListener('pointerleave', function(){
        inside = false; delete btn.dataset.press;
        if (mode !== 'copied') go('idle');
      });
      btn.addEventListener('pointerdown', function(){ btn.dataset.press = '1'; });
      addEventListener('pointerup', function(){ delete btn.dataset.press; }, { passive:true });
      btn.addEventListener('focus', function(){ if (mode !== 'copied') go('hover'); });
      btn.addEventListener('blur',  function(){ if (mode !== 'copied' && !inside) go('idle'); });
      btn.addEventListener('click', function(){
        playContact();
        copy(email).then(function(ok){
          if (said) said.textContent = ok ? 'Copied' : 'Blocked';
          if (tick) tick.style.display = ok ? '' : 'none';
          say(ok, email);
          measure();
          if (!quiet.matches) {
            halos.forEach(function(h, i){
              if (!h.animate) return;
              h.animate([
                { opacity:.85, transform:'scale(1,1)',       filter:'blur(0px)' },
                { opacity:0,   transform:'scale(1.45,2.1)',  filter:'blur(6px)' }
              ], { duration:760, delay:i * 110,
                   easing:'cubic-bezier(.2,.7,.3,1)', fill:'forwards' });
            });
            if (tick && tick.animate && ok)
              tick.animate([{ strokeDashoffset:1 }, { strokeDashoffset:0 }],
                { duration:440, delay:160, easing:'cubic-bezier(.2,.8,.3,1)', fill:'forwards' });
            sweep(360, .95);
            setTimeout(function(){ sweep(420, .55); }, 110);
          }
          go('copied');
          clearTimeout(t2);
          t2 = setTimeout(function(){
            go(inside ? 'hover' : 'idle');
            if (tick) tick.setAttribute('stroke-dashoffset', '1');
          }, 2000 + (quiet.matches ? 0 : 400));
        });
      });
    });
    [].forEach.call(document.querySelectorAll('.foot__copy'), function(el){
      var word = el.querySelector('span'),
          was  = word ? word.textContent : '',
          hold = 0;
      el.addEventListener('click', function(){
        playContact();
        var mail = el.dataset.email || '';
        copy(mail).then(function(ok){
          say(ok, mail);
          if (!word) return;
          word.textContent = ok ? 'Copied!' : 'Blocked';
          el.dataset.said = '1';
          clearTimeout(hold);
          hold = setTimeout(function(){
            word.textContent = was;
            delete el.dataset.said;
          }, 2000);
        });
      });
    });
  })();
  [].forEach.call(document.querySelectorAll('#navLogo, #footLogo, .brandmark'),
                  function(el){ onTap(el, playLogo); });
})();
(function(){
  var MAX=2.4;
  if(!matchMedia('(hover:hover) and (pointer:fine)').matches) return;
  if(matchMedia('(prefers-reduced-motion:reduce)').matches) return;
  document.querySelectorAll('.pcard').forEach(function(card){
    if(!(parseFloat(getComputedStyle(card).getPropertyValue('--tilt'))||0)) return;
    var raf=0,tx=0,ty=0;
    function apply(){ raf=0;
      card.style.setProperty('--ry',tx.toFixed(2)+'deg');
      card.style.setProperty('--rx',ty.toFixed(2)+'deg'); }
    card.addEventListener('pointermove',function(e){
      var k=parseFloat(getComputedStyle(card).getPropertyValue('--tilt'))||0;
      if(!k) return;
      var r=card.getBoundingClientRect();
      tx=((e.clientX-r.left)/r.width -.5)* 2*MAX*k;
      ty=((e.clientY-r.top )/r.height-.5)*-2*MAX*k;
      if(!raf) raf=requestAnimationFrame(apply);
    });
    card.addEventListener('pointerleave',function(){ tx=ty=0; if(!raf) raf=requestAnimationFrame(apply); });
  });
})();
(function(){
  var SRC = (SITE_BASE+"assets/media/bbe838c71e35.mp3");
  var OFFSET  = 0.032;
  var MIN_GAP = 90;
  var api = window.cardHoverSound = { volume: 0.70, enabled: true };
  var fine = !window.matchMedia || matchMedia('(hover:hover) and (pointer:fine)').matches;
  var AC = window.AudioContext || window.webkitAudioContext;
  var ctx, raw, buf, last = 0, decoding = false, woke = false;
  api.status = function(){
    return {
      pointerOk : fine,
      webAudio  : !!AC,
      bytes     : raw ? raw.byteLength : 0,
      decoded   : !!buf,
      context   : ctx ? ctx.state : 'not created',
      enabled   : api.enabled,
      muted     : document.documentElement.dataset.sound === 'off',
      inIframe  : window.top !== window.self,
      hint      : !AC ? 'this browser has no Web Audio'
                : !raw ? 'audio file has not loaded — if you opened the folder build from disk, serve it over http instead'
                : (!ctx || ctx.state !== 'running')
                    ? 'click, tap or press a key once — browsers block audio until then'
                        + (window.top !== window.self ? ' (and this page is in an iframe, which must allow autoplay)' : '')
                : document.documentElement.dataset.sound === 'off' ? 'muted via data-sound="off"'
                : 'ready'
    };
  };
  if(!fine || !AC) return;
  try{ ctx = new AC(); }catch(e){}
  fetch(SRC).then(function(r){ return r.arrayBuffer(); })
            .then(function(b){ raw = b; decode(); })
            .catch(function(){});
  function decode(){
    if(buf || decoding || !raw || !ctx) return;
    decoding = true;
    try{
      var pr = ctx.decodeAudioData(raw.slice(0));
      if(pr && pr.then) pr.then(function(b){ buf = b; decoding = false; },
                                function(){ decoding = false; });
    }catch(e){ decoding = false; }
  }
  function arm(){
    try{
      if(!ctx) ctx = new AC();
      decode();
      if(ctx.state === 'suspended') return ctx.resume();
    }catch(e){}
  }
  function wake(e){
    var r = arm();
    if (woke) return;
    var settle = function(){
      if (woke || !ctx || ctx.state !== 'running') return;
      woke = true;
      var el = document.querySelector('.pcard:hover');
      if (!el) return;
      var from = e && e.target && e.target.closest && e.target.closest('.pcard');
      if (from === el) return;
      play();
    };
    if (r && r.then) r.then(settle, function(){}); else settle();
  }
  ['pointerdown','pointerup','click','keydown','touchstart','touchend','wheel'].forEach(function(ev){
    addEventListener(ev, wake, { passive:true });
  });
  function play(){
    if(!api.enabled) return;
    if(document.documentElement.dataset.sound === 'off') return;
    if(!ctx || ctx.state !== 'running' || !buf) return;
    var now = performance.now();
    if(now - last < MIN_GAP) return;
    last = now;
    try{
      var s = ctx.createBufferSource(); s.buffer = buf;
      var g = ctx.createGain();
      g.gain.value = Math.max(0, Math.min(1, api.volume));
      s.connect(g); g.connect(ctx.destination);
      s.start(0, OFFSET);
      woke = true;
    }catch(e){}
  }
  document.querySelectorAll('.pcard').forEach(function(card){
    function hit(){
      var r = arm();
      play();
      if(r && r.then) r.then(function(){
        if(card.matches(':hover')) play();
      }, function(){});
    }
    card.addEventListener('pointerenter', hit);
    card.addEventListener('focus', function () {
      try { if (!card.matches(':focus-visible')) return; } catch (e) {}
      hit();
    });
  });
})();
