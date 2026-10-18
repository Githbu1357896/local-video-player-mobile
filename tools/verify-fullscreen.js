// 验证"真机全屏"场景下的 5 项修复。
// 模拟方式与真机一致：屏幕本身转成横屏 + 挂 rotated-mode，但【不】做 CSS 旋转
// （真机是靠原生 setRequestedOrientation 锁横屏，舞台不转）。
const nodeMajor = parseInt(process.versions.node.split('.')[0], 10);
if (nodeMajor < 21 || typeof WebSocket === 'undefined') {
  console.error(`需要 Node 21 及以上（当前 ${process.version}）`);
  process.exit(1);
}

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const PORT = 9334;
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const USER_DIR = path.join(projectRoot, '.chrome-profile-fs');

const results = [];
const out = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  const line = `${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ->  ' + detail : ''}`;
  out.push(line);
  console.log(line);
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
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); }
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
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--allow-file-access-from-files', `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${USER_DIR}`, '--window-size=420,860', 'about:blank'
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
      }
    };

    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');

    const mock = fs.readFileSync(path.join(projectRoot, 'tools', 'mock-capacitor.js'), 'utf8');
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: mock });

    // 竖屏启动
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 420, height: 860, deviceScaleFactor: 1, mobile: true });
    await cdp.send('Page.navigate', { url: 'file:///' + path.join(projectRoot, 'www', 'index.html').replace(/\\/g, '/') });
    await wait(1800); // 等 bootstrap 自动扫描 + 建栈

    // 扫描完成后主页应展示文件夹视图（按文件夹路径分组）
    const home = await cdp.eval(`(function(){
      return {
        screen: state.currentScreen,
        folders: document.querySelectorAll('.folder-card').length,
        summary: (document.getElementById('library-summary') || {}).textContent
      };
    })()`);
    check('启动扫描后主页展示文件夹视图', home.screen === 'home' && home.folders === 3, JSON.stringify(home));

    // 进入 Movies 文件夹（含 3 个视频）并点击第一个视频 -> 进入播放器
    await cdp.eval(`(function(){
      const card = Array.from(document.querySelectorAll('.folder-card')).find(c => c.dataset.path === '/sdcard/Movies');
      if (card) card.click();
    })()`);
    await wait(150);
    const detail = await cdp.eval(`({
      screen: state.currentScreen,
      rows: document.querySelectorAll('.video-row').length,
      title: (document.getElementById('folder-detail-title') || {}).textContent
    })`);
    check('点击文件夹进入详情视频列表', detail.screen === 'folder' && detail.rows === 3 && detail.title === 'Movies', JSON.stringify(detail));

    await cdp.eval(`document.querySelectorAll('.video-row')[0].click()`);
    await wait(400);
    const loaded = await cdp.eval(`({ items: document.querySelectorAll('.video-item').length, idx: state.currentIndex, screen: state.currentScreen })`);
    check('视频栈已构建', loaded.items === 3, JSON.stringify(loaded));

    // 舞台不再过渡 width/height（旋转闪烁根因）
    const trans = await cdp.eval(`getComputedStyle(document.getElementById('player-stage')).transitionProperty`);
    check('① 舞台不过渡 width/height（消除旋转闪烁）', !/width|height/.test(trans), 'transition-property=' + trans);

    // ---- 进入全屏：模拟真机（屏幕转横屏 + 原生方向锁定，不做 CSS 旋转）----
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 860, height: 420, deviceScaleFactor: 1, mobile: true });
    await wait(400);
    await cdp.eval(`setRotated(true)`);
    await wait(800); // 等 recalibrateStack 的 rAF + 延时兜底跑完

    const rot = await cdp.eval(`({
      rotated: document.getElementById('player').classList.contains('rotated-mode'),
      cssRotated: document.getElementById('player').classList.contains('css-rotated'),
      calls: window.__ORIENTATION_CALLS.slice()
    })`);
    check('② 进入全屏走原生横屏锁定（非 CSS 旋转）',
      rot.rotated && !rot.cssRotated && rot.calls.includes('landscape'), JSON.stringify(rot));

    // 进入全屏后侧边栏不应自动弹出（"又"复发问题的核心：转屏过渡的误触 click 不能打开设置）
    const autoPop = await cdp.eval(`({ active: document.getElementById('settings-modal').classList.contains('active') })`);
    check('②b 进入全屏时侧边栏保持隐藏（无自动弹出）',
      !autoPop.active, JSON.stringify(autoPop));

    // 当前视频必须完整铺满视口，否则会露出上/下一段画面
    const align = await cdp.eval(`(function () {
      const vp = document.getElementById('video-viewport').getBoundingClientRect();
      const items = document.querySelectorAll('.video-item');
      const i = state.currentIndex;
      const cur = items[i].getBoundingClientRect();
      return {
        idx: i,
        dTop: Math.round(cur.top - vp.top),
        dH: Math.round(cur.height - vp.height),
        vpH: Math.round(vp.height),
        curH: Math.round(cur.height)
      };
    })()`);
    check('③ 全屏后当前视频完整铺满视口（无残留偏移露出上一段）',
      Math.abs(align.dTop) <= 2 && Math.abs(align.dH) <= 2, JSON.stringify(align));

    // 切到第 2 个视频后再验一次：index>0 时偏移基准是 -100%，最容易露出上一段
    await cdp.eval(`loadVideoAtIndex(1)`);
    await wait(600);
    const align2 = await cdp.eval(`(function () {
      const vp = document.getElementById('video-viewport').getBoundingClientRect();
      const items = document.querySelectorAll('.video-item');
      const i = state.currentIndex;
      const cur = items[i].getBoundingClientRect();
      const prev = items[i - 1].getBoundingClientRect();
      return {
        idx: i,
        dTop: Math.round(cur.top - vp.top),
        dH: Math.round(cur.height - vp.height),
        prevBottom: Math.round(prev.bottom - vp.top) // 上一个视频底边应正好在视口顶部(0)
      };
    })()`);
    check('③b 切到 index=1 后仍铺满，上一段底边正好贴视口顶部',
      Math.abs(align2.dTop) <= 2 && Math.abs(align2.dH) <= 2 && Math.abs(align2.prevBottom) <= 2,
      JSON.stringify(align2));

    // 全屏下"退出全屏"提示按钮应已取消
    const hint = await cdp.eval(`getComputedStyle(document.getElementById('landscape-hint')).display`);
    check('④ 全屏下"退出全屏"按钮已取消', hint === 'none', 'landscape-hint display=' + hint);

    // 中央播放/暂停按钮：可点击 + 是舞台中心的命中目标
    const po = await cdp.eval(`(function () {
      const el = document.getElementById('play-overlay');
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      // 取当前可见图标的尺寸（播放/暂停二选一显示）
      var iconW = 0;
      var icons = el.querySelectorAll('svg');
      for (var i = 0; i < icons.length; i++) {
        if (getComputedStyle(icons[i]).display !== 'none') { iconW = Math.round(icons[i].getBoundingClientRect().width); break; }
      }
      return {
        pointerEvents: cs.pointerEvents,
        zIndex: cs.zIndex,
        hidden: el.classList.contains('hidden'),
        hitIsOverlay: !!(hit && (hit === el || el.contains(hit))),
        w: Math.round(r.width),
        h: Math.round(r.height),
        iconW: iconW
      };
    })()`);
    check('⑤ 中央播放/暂停按钮可单击（pointer-events 由 none 改为 auto）',
      po.pointerEvents === 'auto', JSON.stringify(po));
    check('⑤b 播放/暂停按钮已缩小（≤64px）且保留可点热区（≥44px）、图标 ≤34px',
      po.w >= 44 && po.w <= 64 && po.h >= 44 && po.h <= 64 && po.iconW > 0 && po.iconW <= 34,
      JSON.stringify({ w: po.w, h: po.h, iconW: po.iconW }));
    check('⑥ 舞台中心点击命中中央按钮', po.hitIsOverlay, 'hitIsOverlay=' + po.hitIsOverlay);

    // 图标随播放状态切换
    const icons = await cdp.eval(`(function () {
      const el = document.getElementById('play-overlay');
      const play = el.querySelector('.icon-play');
      const pause = el.querySelector('.icon-pause');
      const before = { play: getComputedStyle(play).display, pause: getComputedStyle(pause).display };
      el.classList.add('is-playing');
      const after = { play: getComputedStyle(play).display, pause: getComputedStyle(pause).display };
      el.classList.remove('is-playing');
      return { before, after };
    })()`);
    check('⑦ 播放/暂停图标随状态切换',
      icons.before.play !== 'none' && icons.before.pause === 'none' &&
      icons.after.play === 'none' && icons.after.pause !== 'none', JSON.stringify(icons));

    // 设置弹窗：全屏下从右侧弹出，占画面右侧 30%（可手动唤出）
    await cdp.eval(`openSettings()`);
    await wait(700);
    const panel = await cdp.eval(`(function () {
      const p = document.getElementById('settings-panel');
      const r = p.getBoundingClientRect();
      const W = window.innerWidth, H = window.innerHeight;
      const modal = document.getElementById('settings-modal');
      return {
        active: modal.classList.contains('active'),
        left: Math.round(r.left), right: Math.round(r.right),
        width: Math.round(r.width), height: Math.round(r.height),
        W, H, ratio: +(r.width / W).toFixed(3)
      };
    })()`);
    check('⑧ 全屏下可手动唤出设置抽屉，从右侧弹出且占 30% 宽',
      panel.active &&
      Math.abs(panel.ratio - 0.30) < 0.02 &&
      Math.abs(panel.right - panel.W) <= 2 &&
      Math.abs(panel.height - panel.H) <= 2, JSON.stringify(panel));

    // 右侧窄抽屉改了排布，确认滑块坐标换算没被弄坏：拖到轨道中点应得到约 50%
    const slider = await cdp.eval(`(function () {
      const track = document.getElementById('brightness-track');
      const r = track.getBoundingClientRect();
      const x = r.left + r.width * 0.5;
      const y = r.top + r.height / 2;
      const fire = (el, type) => el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y }));
      fire(track, 'mousedown');
      fire(window, 'mousemove');
      fire(window, 'mouseup');
      return {
        trackW: Math.round(r.width),
        value: document.getElementById('brightness-value').textContent
      };
    })()`);
    const pct = parseInt(slider.value, 10);
    check('⑨ 右侧抽屉内亮度滑块坐标换算正确（中点≈50%）',
      slider.trackW > 40 && Math.abs(pct - 50) <= 3, JSON.stringify(slider));

    await cdp.eval(`closeSettings()`);
    await wait(400);

    // 顶部返回图标：用【真实坐标点击】走浏览器命中测试，
    // 直接 .click() 会绕过命中，真机上点不到的情况就测不出来。
    const backBox = await cdp.eval(`(function () {
      const b = document.getElementById('back-btn');
      const r = b.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), w: Math.round(r.width), h: Math.round(r.height) };
    })()`);

    const hitBack = await cdp.eval(`(function (x, y) {
      const el = document.elementFromPoint(x, y);
      const b = document.getElementById('back-btn');
      return { tag: el ? el.tagName : null, id: el ? el.id : null, isBack: !!(el && (el === b || b.contains(el))) };
    })(${backBox.x}, ${backBox.y})`);
    check('⑩a 全屏下返回图标在可点击位置（命中测试）', hitBack.isBack, JSON.stringify({ backBox, hitBack }));

    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: backBox.x, y: backBox.y, button: 'left', clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: backBox.x, y: backBox.y, button: 'left', clickCount: 1 });
    await wait(700);
    const back = await cdp.eval(`({
      rotated: document.getElementById('player').classList.contains('rotated-mode'),
      calls: window.__ORIENTATION_CALLS.slice(),
      playerActive: document.getElementById('player').classList.contains('active'),
      folderActive: document.getElementById('folder-select').classList.contains('active')
    })`);
    check('⑩ 顶部返回图标在全屏时退出全屏（仍停留在播放页）',
      !back.rotated && back.calls[back.calls.length - 1] === 'portrait' &&
      back.playerActive && !back.folderActive, JSON.stringify(back));

    // 问题1修复：退出全屏后"全屏观看"按钮应重新可见（不再永久消失）
    const hintAfterExit = await cdp.eval(`(function () {
      const el = document.getElementById('landscape-hint');
      return {
        display: getComputedStyle(el).display,
        hidden: el.classList.contains('hidden'),
        text: document.getElementById('landscape-hint-text').textContent
      };
    })()`);
    check('⑫ 退出全屏后"全屏观看"按钮重新可见（可再次全屏）',
      hintAfterExit.display !== 'none' && !hintAfterExit.hidden && hintAfterExit.text === '全屏观看',
      JSON.stringify(hintAfterExit));

    // 问题1b：按钮应随控制栏一起自动隐藏（播放中淡出），单击屏幕再现。
    // 该按钮有 opacity 0.3s 过渡，需等过渡结束再读计算值。
    await cdp.eval(`setControlsVisible(false)`); // 模拟控制栏自动隐藏
    await wait(450);
    const hiddenOpacity = await cdp.eval(`parseFloat(getComputedStyle(document.getElementById('landscape-hint')).opacity)`);
    await cdp.eval(`setControlsVisible(true)`); // 模拟单击屏幕，控制栏再现
    await wait(450);
    const visibleOpacity = await cdp.eval(`parseFloat(getComputedStyle(document.getElementById('landscape-hint')).opacity)`);
    check('⑫b "全屏观看"按钮随控制栏自动隐藏（淡出），控制栏再现时恢复',
      hiddenOpacity < 0.1 && visibleOpacity > 0.9, JSON.stringify({ hiddenOpacity, visibleOpacity }));

    // 点击该按钮应再次进入全屏
    await cdp.eval(`document.getElementById('landscape-hint').click()`);
    await wait(800);
    const reEnter = await cdp.eval(`({
      rotated: document.getElementById('player').classList.contains('rotated-mode'),
      calls: window.__ORIENTATION_CALLS.slice(),
      visible: !document.getElementById('landscape-hint').classList.contains('hidden')
    })`);
    check('⑬ 点击"全屏观看"可再次进入全屏',
      reEnter.rotated && reEnter.calls[reEnter.calls.length - 1] === 'landscape',
      JSON.stringify(reEnter));

    // 问题2修复：全屏下允许手动唤出侧边栏，但屏幕旋转(orientationchange)过渡期
    // 不应自动弹出——转屏合成的误触 click 会被锁定窗口挡掉。
    await cdp.eval(`window.dispatchEvent(new Event('orientationchange'))`);

    // 过渡期刚开始（刚派发 orientationchange）即便触发 openSettings 也应被忽略，弹窗保持隐藏/稳定
    await cdp.eval(`openSettings()`);
    await wait(60);
    const duringRotate = await cdp.eval(`({
      active: document.getElementById('settings-modal').classList.contains('active'),
      visibility: getComputedStyle(document.getElementById('settings-panel')).visibility,
      rect: (function(){ var r = document.getElementById('settings-panel').getBoundingClientRect(); return { l: Math.round(r.left), t: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }; })()
    })`);
    // 关键：根因修复后，收起态面板 visibility:hidden 且被 .settings-modal overflow:hidden 裁住，
    // 其 transform 在 translateY↔translateX 之间的"对角线扫屏"中间帧不可见，绝不会露边。
    check('⑭ 全屏旋转过渡期侧边栏被锁定、不会自动弹出（显示状态保持稳定）',
      !duringRotate.active && duringRotate.visibility === 'hidden', JSON.stringify(duringRotate));

    // 关键健壮性：合成 click 可能迟到（旧实现用固定 500ms 窗口，迟到即漏网）。
    // 这里在 orientationchange 后约 550ms（仍在 800ms debounce 窗口内）再触发一次，仍应被忽略。
    await wait(490);
    const lateClick = await cdp.eval(`(function(){ openSettings(); return document.getElementById('settings-modal').classList.contains('active'); })()`);
    check('⑭b 旋转过渡期迟到的误触 click 仍被锁定（不靠固定时间窗口猜）',
      !lateClick, 'active=' + lateClick);

    // 转屏稳定后（isRotating 已解除，debounce 窗口 800ms 已过），用户主动点击设置按钮可正常唤出
    await wait(500);
    const manualOpen = await cdp.eval(`(function () {
      openSettings();
      const modal = document.getElementById('settings-modal');
      const p = document.getElementById('settings-panel').getBoundingClientRect();
      return { active: modal.classList.contains('active'),
               visibility: getComputedStyle(document.getElementById('settings-panel')).visibility,
               W: window.innerWidth, width: Math.round(p.width), ratio: +(p.width / window.innerWidth).toFixed(3) };
    })()`);
    check('⑮ 全屏旋转稳定后点击设置按钮可正常唤出侧边栏（占 30%、可见）',
      manualOpen.active && manualOpen.visibility === 'visible' && Math.abs(manualOpen.ratio - 0.30) < 0.02, JSON.stringify(manualOpen));

    await cdp.eval(`closeSettings()`);
    await wait(300);

    // 收尾：返回图标在全屏时退全屏；再点一次从播放器回到所在文件夹详情
    await cdp.eval(`document.getElementById('back-btn').click()`);
    await wait(600);
    await cdp.eval(`document.getElementById('back-btn').click()`);
    await wait(500);
    const toFolder = await cdp.eval(`({
      screen: state.currentScreen,
      playerActive: document.getElementById('player').classList.contains('active'),
      detailActive: document.getElementById('folder-detail').classList.contains('active')
    })`);
    check('⑪a 播放器返回回到所在文件夹详情', toFolder.screen === 'folder' && !toFolder.playerActive && toFolder.detailActive, JSON.stringify(toFolder));

    // 详情页返回图标回到媒体库主页
    await cdp.eval(`document.getElementById('folder-back-btn').click()`);
    await wait(400);
    const homeFinal = await cdp.eval(`({
      screen: state.currentScreen,
      folderActive: document.getElementById('folder-select').classList.contains('active'),
      playerActive: document.getElementById('player').classList.contains('active'),
      detailActive: document.getElementById('folder-detail').classList.contains('active')
    })`);
    check('⑪ 详情页返回回到媒体库主页', homeFinal.screen === 'home' && homeFinal.folderActive && !homeFinal.playerActive && !homeFinal.detailActive, JSON.stringify(homeFinal));

    const failed = results.filter(r => !r.pass);
    console.log('\n===== 汇总 =====');
    console.log(`通过 ${results.length - failed.length}/${results.length}`);
    try { fs.writeFileSync(path.join(projectRoot, 'verify-fullscreen.log'), out.join('\n')); } catch (_) { /* 环境禁止覆盖已存在文件，忽略 */ }
    process.exitCode = failed.length ? 1 : 0;
  } catch (err) {
    console.error('验证脚本异常:', err);
    fs.writeFileSync(path.join(projectRoot, 'verify-fullscreen.log'), out.join('\n') + '\nERROR: ' + err.message);
    process.exitCode = 1;
  } finally {
    cleanup();
  }
})();
