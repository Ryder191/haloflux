/*!
 * HALOFLUX - Copyright (c) 2026 Ryder191 (RYDER CODE / Ms MAIKEBAIs CAT). All rights reserved.
 * https://github.com/Ryder191/haloflux
 * Licensed under the PolyForm Noncommercial License 1.0.0 (see LICENSE).
 * Noncommercial use only. ANY COMMERCIAL USE IS STRICTLY PROHIBITED.
 * 仅限非商业用途，严格禁止任何商业用途。转载或二创须保留本声明并注明出处。
 */
/* =========================================================
   HALOFLUX — Wallpaper Engine bridge
   属性由 project.json 的 general.properties 定义：
   预设 / 节拍 / 柔光 / 圆环转速 / 光束辉光 / 扫描线 / 界面 / 音乐 / 音量
   在普通浏览器里打开时用下面的默认值，方便预览
   ========================================================= */
(function () {
  'use strict';
  const num = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d);

  const DEFAULTS = {
    preset: 'MINE',
    tempo: 0.6,
    glow: 1.1,
    ringSpeed: 0.6,
    beamGlow: 2.6,
    camera: true,
    camZoom: 1,
    showui: true,
    scanlines: true,
    music: true,
    volume: 55
  };
  const P = { ...DEFAULTS };
  let wired = false;

  function hasFn(n) { return typeof window[n] === 'function'; }

  /* ---------- 参数 ---------- */
  function applyParams() {
    if (hasFn('loadPreset')) { try { loadPreset(P.preset, null); } catch (e) { } }
    if (!hasFn('setParam')) return;
    const set = (k, v) => { try { setParam(k, v, true); } catch (e) { } };
    set('tempo', P.tempo);
    set('glow', P.glow);
    set('ringSpeed', P.ringSpeed);
    set('beamGlow', P.beamGlow);
    set('scan', P.scanlines ? 1 : 0);
    set('camera', P.camera ? 1 : 0);
    set('camZoom', P.camZoom);
  }

  /* ---------- 界面：默认只留中间的圆环 ---------- */
  function applyUI() {
    const app = document.querySelector('.app');
    const show = !!P.showui;
    // 不能用 display:none：面板里的小画布尺寸归零会让绘制循环卡死。
    // 改为脱离布局 + 不可见，尺寸保持不变。
    document.querySelectorAll('header, .panels').forEach(el => {
      el.style.position = show ? '' : 'absolute';
      el.style.left = el.style.right = show ? '' : '0';
      el.style.visibility = show ? '' : 'hidden';
      el.style.pointerEvents = show ? '' : 'none';
      if (el.tagName === 'HEADER') el.style.top = show ? '' : '0';
      else el.style.bottom = show ? '' : '0';
    });
    if (app) app.style.gridTemplateRows = show ? '' : 'minmax(0,1fr)';
    document.body.classList.toggle('noscan', !P.scanlines);
    // 布局变了要重算画布尺寸
    if (hasFn('resizeAll')) { requestAnimationFrame(() => setTimeout(resizeAll, 30)); setTimeout(resizeAll, 220); }
  }

  /* ---------- 音乐 ---------- */
  function applyAudio() {
    if (!window.__bgm) return;
    window.__bgm.set(P.music);
    window.__bgm.setVol(P.volume);
  }

  function applyAll() { applyParams(); applyUI(); applyAudio(); }

  /* ---------- Wallpaper Engine 回调 ---------- */
  window.wallpaperPropertyListener = {
    applyUserProperties(props) {
      if (!props) return;
      if (props.preset && props.preset.value) P.preset = String(props.preset.value).toUpperCase();
      if (props.tempo) P.tempo = num(props.tempo.value, DEFAULTS.tempo);
      if (props.glow) P.glow = num(props.glow.value, DEFAULTS.glow);
      if (props.ringspeed) P.ringSpeed = num(props.ringspeed.value, DEFAULTS.ringSpeed);
      if (props.beamglow) P.beamGlow = num(props.beamglow.value, DEFAULTS.beamGlow);
      if (props.camera) P.camera = props.camera.value !== false;
      if (props.camzoom) P.camZoom = num(props.camzoom.value, DEFAULTS.camZoom);
      if (props.showui) P.showui = props.showui.value !== false;
      if (props.scanlines) P.scanlines = props.scanlines.value !== false;
      if (props.music) P.music = props.music.value !== false;
      if (props.volume) P.volume = num(props.volume.value, DEFAULTS.volume);
      wired = true;
      applyAll();
    },
    setPaused(p) {
      window.__wpPaused = !!p;
      // 全屏游戏 / 其他程序遮挡时，音乐也一起停；恢复后再接着放
      const au = document.getElementById('bgmAudio');
      if (p) { if (au && !au.paused) au.pause(); }
      else if (P.music && window.__bgm) window.__bgm.kick();
    },
    setAudioMuted(m) {
      if (!window.__bgm) return;
      if (m) window.__bgm.set(false);
      else if (P.music) { window.__bgm.set(true); window.__bgm.setVol(P.volume); }
    }
  };

  /* ---------- 启动：先套默认，再等壁纸属性覆盖 ---------- */
  function boot() {
    applyAll();
    // 主脚本初始化较晚时再校一次
    setTimeout(() => { if (!wired) applyAll(); }, 500);
    // Wallpaper Engine 的浏览器允许自动播放；万一被拦就重试几次
    [1200, 3000, 6000].forEach(t => setTimeout(() => { if (window.__bgm) window.__bgm.kick(); }, t));
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
