// 用本机 Chrome + CDP 无头加载手机版 www，注入模拟 Capacitor 桥并验证运行时行为
// 需要 Node 21+：用到了内置的全局 WebSocket 连 Chrome 调试端口
const nodeMajor = parseInt(process.versions.node.split('.')[0], 10);
if (nodeMajor < 21 || typeof WebSocket === 'undefined') {
  console.error(`需要 Node 21 及以上（当前 ${process.version}），旧版 Node 没有全局 WebSocket。`);
  process.exit(1);
}

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const PORT = 9333;
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const USER_DIR = path.join(projectRoot, '.chrome-profile');

const logLines = [];
function log(msg) {
  logLines.push(String(msg));
  fs.writeFileSync(path.join(projectRoot, 'verify.log'), logLines.join('\n'));
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function getWsUrl() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === 'page');
      if (page && page.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch (_) { /* 还没起来 */ }
    await wait(250);
  }
  throw new Error('Chrome 调试端口未就绪');
}

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.events = []; }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => { if (this.pending.delete(id)) reject(new Error('timeout: ' + method)); }, 20000);
    });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  }
}

(async () => {
  const chrome = spawn(CHROME, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--allow-file-access-from-files',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${USER_DIR}`,
    '--window-size=420,860',
    'about:blank'
  ], { stdio: 'ignore' });

  const cleanup = () => { try { chrome.kill(); } catch (_) {} };
  process.on('exit', cleanup);

  try {
    const wsUrl = await getWsUrl();
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const cdp = new Cdp(ws);
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.id && cdp.pending.has(msg.id)) {
        const { resolve } = cdp.pending.get(msg.id);
        cdp.pending.delete(msg.id);
        resolve(msg.result || {});
      } else if (msg.method === 'Runtime.consoleAPICalled') {
        const txt = (msg.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ');
        log(`[console.${msg.params.type}] ${txt}`);
      } else if (msg.method === 'Runtime.exceptionThrown') {
        log('[exception] ' + (msg.params.exceptionDetails.text || ''));
      }
    };

    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('Log.enable');

    // 模拟 Capacitor 桥，必须在页面脚本之前注入
    const mock = fs.readFileSync(path.join(projectRoot, 'tools', 'mock-capacitor.js'), 'utf8');
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: mock });

    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 420, height: 860, deviceScaleFactor: 1, mobile: true
    });

    await cdp.send('Page.navigate', { url: 'file:///' + path.join(projectRoot, 'www', 'index.html').replace(/\\/g, '/') });
    await wait(1200);
    log('page loaded');

    // 强制走 CSS 旋转预览路径（真机上是原生横屏锁定，这里无法模拟系统旋转）
    await cdp.eval(`window.__SIMULATE_ROTATE = true`);

    log('bridge: ' + JSON.stringify(await cdp.eval(`
      (function () {
        return {
          hasCapacitor: !!window.Capacitor,
          isNative: !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()),
          pluginApi: !!(window.VideoSource && window.VideoSource.api)
        };
      })()
    `)));

    const shot = async (name) => {
      const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(projectRoot, name), Buffer.from(r.data, 'base64'));
      log('written ' + name);
    };
    await shot('preview-mobile-home.png');

    await cdp.eval(`document.getElementById('select-folder-btn').click()`);
    await wait(900);
    log('scan: ' + JSON.stringify(await cdp.eval(`
      (function () {
        var vs = document.querySelectorAll('#video-stack video');
        return { playerActive: document.getElementById('player').classList.contains('active'), videoCount: vs.length };
      })()
    `)));
    await shot('preview-mobile-player.png');

    // 假视频地址加载失败，play() 会 reject 并触发 pause，等它结束再测自动隐藏
    await wait(2000);

    // ---- 自动隐藏链路 ----
    log('diag: ' + JSON.stringify(await cdp.eval(`
      (function () {
        var vs = document.querySelectorAll('#video-stack video');
        for (var i = 0; i < vs.length; i++) {
          Object.defineProperty(vs[i], 'paused', { get: function () { return false; }, configurable: true });
        }
        vs[0].dispatchEvent(new Event('play'));
        return { count: vs.length, paused0: vs[0].paused, cls: document.getElementById('player').className };
      })()
    `)));

    const readHidden = () => cdp.eval(`document.getElementById('player').classList.contains('controls-hidden')`);

    await wait(1200);
    log(`auto-hide @1.2s (期望 false): ${await readHidden()}`);
    await wait(2600);
    log(`auto-hide @3.8s (期望 true): ${await readHidden()}`);
    if (await readHidden()) await shot('preview-mobile-autohide.png');

    await cdp.eval(`
      (function () {
        var v = document.querySelectorAll('#video-stack video')[0];
        Object.defineProperty(v, 'paused', { get: function () { return true; }, configurable: true });
        v.dispatchEvent(new Event('pause'));
        return true;
      })()
    `);
    await wait(300);
    log(`auto-hide 暂停后 (期望 false): ${await readHidden()}`);

    // ---- 全屏图标跟随控制栏隐藏 ----
    await cdp.eval(`
      (function () {
        var v = document.querySelectorAll('#video-stack video')[0];
        Object.defineProperty(v, 'videoWidth', { get: function () { return 1920; }, configurable: true });
        Object.defineProperty(v, 'videoHeight', { get: function () { return 1080; }, configurable: true });
        window.checkAspectRatio(v);
        return true;
      })()
    `);
    await wait(600); // 等淡入过渡结束再读 opacity
    log('控制栏可见时 图标(期望 opacity 1): ' + JSON.stringify(await cdp.eval(`
      (function () {
        var hint = document.getElementById('landscape-hint');
        return {
          hintCls: hint.className,
          hintOpacity: getComputedStyle(hint).opacity,
          overlayOpacity: getComputedStyle(document.getElementById('play-overlay')).opacity
        };
      })()
    `)));

    await cdp.eval(`window.setControlsVisible(false)`);
    await wait(450);
    log('控制栏隐藏后 图标(期望 opacity 0): ' + JSON.stringify(await cdp.eval(`
      (function () {
        return {
          controlsHidden: document.getElementById('player').classList.contains('controls-hidden'),
          hintOpacity: getComputedStyle(document.getElementById('landscape-hint')).opacity,
          overlayOpacity: getComputedStyle(document.getElementById('play-overlay')).opacity
        };
      })()
    `)));

    // ---- 舞台整体旋转 ----
    await cdp.eval(`window.setControlsVisible(true)`);
    await wait(350);

    const stageInfo = () => cdp.eval(`
      (function () {
        var pr = document.getElementById('player').getBoundingClientRect();
        var st = document.getElementById('player-stage');
        var item = document.querySelector('.video-item');
        function box(el) { var r = el.getBoundingClientRect(); return { x: Math.round(r.x - pr.left), y: Math.round(r.y - pr.top), w: Math.round(r.width), h: Math.round(r.height) }; }
        return {
          playerCls: document.getElementById('player').className,
          stage: { w: st.offsetWidth, h: st.offsetHeight, offset: [st.offsetLeft, st.offsetTop], transform: getComputedStyle(st).transform },
          videoItemH: item.offsetHeight,
          topBar: box(document.getElementById('top-bar')),
          bottomControls: box(document.getElementById('bottom-controls')),
          playOverlay: box(document.getElementById('play-overlay')),
          hint: box(document.getElementById('landscape-hint')),
          hintText: document.getElementById('landscape-hint-text').textContent,
          viewport: { w: window.innerWidth, h: window.innerHeight }
        };
      })()
    `);

    log('竖屏 舞台: ' + JSON.stringify(await stageInfo()));

    await cdp.eval(`document.getElementById('landscape-hint').click()`);
    await wait(800);
    log('全屏旋转 舞台: ' + JSON.stringify(await stageInfo()));
    await shot('preview-mobile-rotated.png');

    // ---- 问题1：旋转后视频画面不应丢失（元素仍存在且有尺寸）----
    log('旋转后视频可见: ' + JSON.stringify(await cdp.eval(`
      (function () {
        var v = document.querySelectorAll('#video-stack video')[0];
        var r = v.getBoundingClientRect();
        return { exists: !!v, w: Math.round(r.width), h: Math.round(r.height), hasTransform: !!getComputedStyle(v).transform && getComputedStyle(v).transform !== 'none' };
      })()
    `)));

    // ---- 问题3：退出全屏按钮与中央暂停按钮不应重叠 ----
    log('全屏按钮与暂停按钮重叠检测: ' + JSON.stringify(await cdp.eval(`
      (function () {
        function rect(el){ var r = el.getBoundingClientRect(); return { l:r.left, t:r.top, r:r.right, b:r.bottom }; }
        var h = rect(document.getElementById('landscape-hint'));
        var p = rect(document.getElementById('play-overlay'));
        var overlap = !(h.r <= p.l || p.r <= h.l || h.b <= p.t || p.b <= h.t);
        return { hint: h, play: p, overlap: overlap };
      })()
    `)));

    // ---- 问题2：全屏状态下上下滑切换视频，方向保持不变 ----
    await cdp.eval(`window.dispatchEvent(new KeyboardEvent('keydown', { code: 'ArrowDown' }))`);
    await wait(700);
    log('全屏切换视频后方向保持: ' + JSON.stringify(await cdp.eval(`
      (function () {
        return {
          rotatedMode: document.getElementById('player').classList.contains('rotated-mode'),
          cssRotated: document.getElementById('player').classList.contains('css-rotated'),
          stageTransform: getComputedStyle(document.getElementById('player-stage')).transform
        };
      })()
    `)));
    await cdp.eval(`window.dispatchEvent(new KeyboardEvent('keydown', { code: 'ArrowUp' }))`);
    await wait(500);

    // ---- 问题4：设置弹窗在舞台内（随旋转），滑块坐标换算正确 ----
    await cdp.eval(`document.getElementById('settings-btn').click()`);
    await wait(500);
    log('设置弹窗结构/滑块: ' + JSON.stringify(await cdp.eval(`
      (function () {
        var modal = document.getElementById('settings-modal');
        var insideStage = !!modal.closest('#player-stage');
        var track = document.getElementById('brightness-track');
        var box = window.stageLayoutBox(track);
        // 在轨道中心（舞台坐标）映射到屏幕，派发鼠标事件验证亮度值变化
        var st = document.getElementById('player-stage');
        var pr = document.getElementById('player').getBoundingClientRect();
        var u = box.x + box.w/2, v = box.y + box.h/2;
        var a = u - st.offsetWidth/2, b = v - st.offsetHeight/2;
        var sx = pr.left + st.offsetLeft - b, sy = pr.top + st.offsetTop + a;
        var before = document.getElementById('brightness-value').textContent;
        var ev = new MouseEvent('mousedown', { clientX: sx, clientY: sy, bubbles: true });
        track.dispatchEvent(ev);
        window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        var after = document.getElementById('brightness-value').textContent;
        return { insideStage: insideStage, modalTransform: getComputedStyle(modal).transform, sliderBox: box, before: before, after: after };
      })()
    `)));
    await cdp.eval(`document.getElementById('settings-backdrop').click()`);
    await wait(400);

    // 坐标换算：屏幕中心映射回舞台中心；进度条起点/中点/末点应算出 0% / 50% / 100%
    log('坐标换算: ' + JSON.stringify(await cdp.eval(`
      (function () {
        var st = document.getElementById('player-stage');
        var pr = document.getElementById('player').getBoundingClientRect();
        var mid = window.screenToStage(pr.left + pr.width / 2, pr.top + pr.height / 2);
        var box = window.stageLayoutBox(document.getElementById('progress-container'));
        // 舞台局部 → 屏幕（顺时针 90°）
        function toScreen(u, v) {
          var a = u - st.offsetWidth / 2, b = v - st.offsetHeight / 2;
          return { x: pr.left + st.offsetLeft - b, y: pr.top + st.offsetTop + a };
        }
        var video = document.querySelectorAll('#video-stack video')[0];
        Object.defineProperty(video, 'duration', { get: function () { return 100; }, configurable: true });
        function seekAt(u) {
          var s = toScreen(u, box.y + box.h / 2);
          window.seekFromEvent({ clientX: s.x, clientY: s.y });
          return Math.round(video.currentTime * 10) / 10;
        }
        return {
          centerMapsTo: { x: Math.round(mid.x), y: Math.round(mid.y) },
          stageCenter: [Math.round(st.offsetWidth / 2), Math.round(st.offsetHeight / 2)],
          progressBox: box,
          seekStart: seekAt(box.x + 1),
          seekMiddle: seekAt(box.x + box.w / 2),
          seekEnd: seekAt(box.x + box.w - 1)
        };
      })()
    `)));

    await cdp.eval(`window.setControlsVisible(false)`);
    await wait(500);
    log('旋转模式下隐藏(期望控制栏滑出左、标题栏滑出右): ' + JSON.stringify(await cdp.eval(`
      (function () {
        var pr = document.getElementById('player').getBoundingClientRect();
        var bc = document.getElementById('bottom-controls').getBoundingClientRect();
        var tb = document.getElementById('top-bar').getBoundingClientRect();
        return { bottomRight: Math.round(bc.right - pr.left), topBarLeft: Math.round(tb.left - pr.left) };
      })()
    `)));

    await cdp.eval(`window.setControlsVisible(true); document.getElementById('landscape-hint').click();`);
    await wait(800);
    log('退出全屏后: ' + JSON.stringify(await stageInfo()));

    log('done');
  } catch (err) {
    log('ERROR: ' + (err && err.stack ? err.stack : err));
  } finally {
    cleanup();
    await wait(300);
    process.exit(0);
  }
})();
