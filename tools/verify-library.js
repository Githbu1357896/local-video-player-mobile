// 验证"媒体库扫描 + 文件夹视图 + 详情 + 进入播放"的新功能。
// 通过 mock-capacitor 提供 3 个文件夹（Movies=3 / Download=2 / Camera=1）共 6 个视频。
const nodeMajor = parseInt(process.versions.node.split('.')[0], 10);
if (nodeMajor < 21 || typeof WebSocket === 'undefined') {
  console.error(`需要 Node 21 及以上（当前 ${process.version}）`);
  process.exit(1);
}

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const PORT = 9335;
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const USER_DIR = path.join(projectRoot, '.chrome-profile-lib');

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

    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 420, height: 860, deviceScaleFactor: 1, mobile: true });
    await cdp.send('Page.navigate', { url: 'file:///' + path.join(projectRoot, 'www', 'index.html').replace(/\\/g, '/') });
    await wait(1800); // 等 bootstrap 自动扫描 + 渲染主页

    // ---- ① 主页：文件夹视图 ----
    const home = await cdp.eval(`(function(){
      const cards = Array.from(document.querySelectorAll('.folder-card'));
      return {
        screen: state.currentScreen,
        folderCount: cards.length,
        emptyShown: document.getElementById('library-empty').classList.contains('show'),
        listDisplay: getComputedStyle(document.getElementById('folder-list')).display,
        summary: (document.getElementById('library-summary') || {}).textContent,
        folders: state.folders.map(f => ({ path: f.path, name: f.name, count: f.count })),
        firstCard: cards[0] ? {
          name: cards[0].querySelector('.card-name').textContent,
          path: cards[0].querySelector('.card-path').textContent,
          meta: cards[0].querySelector('.card-meta').textContent,
          hasThumb: !!cards[0].querySelector('.card-thumb img')
        } : null
      };
    })()`);
    check('① 扫描后主页展示文件夹视图（非空态）',
      home.screen === 'home' && home.folderCount === 3 && !home.emptyShown && home.listDisplay !== 'none',
      JSON.stringify({ screen: home.screen, folderCount: home.folderCount, emptyShown: home.emptyShown }));
    check('①b 按文件夹路径正确分组（Movies=3 / Download=2 / Camera=1）',
      JSON.stringify(home.folders.map(f => f.count)) === '[3,2,1]' &&
      home.folders[0].path === '/sdcard/Movies' &&
      home.folders.some(f => f.path === '/sdcard/Download') &&
      home.folders.some(f => f.path === '/sdcard/DCIM/Camera'),
      JSON.stringify(home.folders));
    check('①c 文件夹卡片含名称/数量/预览（缩略图 img）',
      !!home.firstCard && home.firstCard.name === 'Movies' && /共 3 个视频/.test(home.firstCard.meta) && home.firstCard.hasThumb,
      JSON.stringify(home.firstCard));
    check('①d 概览统计正确', /6 个视频 · 3 个文件夹/.test(home.summary || ''), JSON.stringify(home.summary));

    // ---- ② 缩略图懒加载 ----
    const thumb = await cdp.eval(`(function(){
      const img = document.querySelector('.folder-card .card-thumb img');
      return {
        calls: (window.__THUMB_CALLS || []).length,
        imgSrc: img ? img.getAttribute('src') : null,
        imgDisplay: img ? getComputedStyle(img).display : null
      };
    })()`);
    check('② 缩略图懒加载（getThumbnail 被调用且 img 已就绪）',
      thumb.calls >= 3 && !!thumb.imgSrc && thumb.imgDisplay === 'block', JSON.stringify(thumb));

    // ---- ③ 点击 Movies 文件夹 -> 详情视频列表 ----
    await cdp.eval(`(function(){
      const card = Array.from(document.querySelectorAll('.folder-card')).find(c => c.dataset.path === '/sdcard/Movies');
      card.click();
    })()`);
    await wait(250);
    const detail = await cdp.eval(`(function(){
      const rows = document.querySelectorAll('.video-row');
      const r0 = rows[0];
      return {
        screen: state.currentScreen,
        rows: rows.length,
        title: (document.getElementById('folder-detail-title') || {}).textContent,
        subtitle: (document.getElementById('folder-detail-subtitle') || {}).textContent,
        detailActive: document.getElementById('folder-detail').classList.contains('active'),
        homeActive: document.getElementById('folder-select').classList.contains('active'),
        firstRowName: r0 ? r0.querySelector('.video-name').textContent : null,
        firstRowMeta: r0 ? r0.querySelector('.video-meta').textContent : null,
        firstRowDur: r0 ? r0.querySelector('.video-duration').textContent : null
      };
    })()`);
    check('③ 点击文件夹进入详情视频列表',
      detail.screen === 'folder' && detail.detailActive && !detail.homeActive && detail.rows === 3,
      JSON.stringify({ screen: detail.screen, rows: detail.rows, title: detail.title }));
    check('③b 详情标题/副标题/行信息正确',
      detail.title === 'Movies' && /\/sdcard\/Movies · 3 个视频/.test(detail.subtitle || '') &&
      detail.firstRowName === '竖屏短视频.mp4' && /01:35/.test(detail.firstRowDur || ''),
      JSON.stringify({ title: detail.title, subtitle: detail.subtitle, firstRowName: detail.firstRowName, firstRowDur: detail.firstRowDur }));

    // ---- ④ 点击第 2 个视频 -> 进入播放器，播放范围限定为该文件夹 ----
    await cdp.eval(`document.querySelectorAll('.video-row')[1].click()`);
    await wait(400);
    const player = await cdp.eval(`(function(){
      var cur = state.videoElements[state.currentIndex];
      return {
        screen: state.currentScreen,
        playerActive: document.getElementById('player').classList.contains('active'),
        items: document.querySelectorAll('.video-item').length,
        idx: state.currentIndex,
        title: (document.getElementById('video-title') || {}).textContent,
        returnTo: state.returnTo,
        folderPath: state.currentFolderPath,
        allSameFolder: state.videos.every(v => v.folderPath === '/sdcard/Movies'),
        videoLen: state.videos.length,
        poster: cur ? (cur.getAttribute('poster') || cur.poster || '') : '',
        preload: cur ? cur.preload : ''
      };
    })()`);
    check('④ 点击视频进入播放器并选中该视频',
      player.screen === 'player' && player.playerActive && player.items === 3 && player.idx === 1 && player.title === '横屏电影片段.mkv',
      JSON.stringify({ screen: player.screen, idx: player.idx, title: player.title }));
    check('④b 播放范围限定为该文件夹（returnTo=folder，全部同路径）',
      player.returnTo === 'folder' && player.folderPath === '/sdcard/Movies' && player.videoLen === 3 && player.allSameFolder,
      JSON.stringify({ returnTo: player.returnTo, folderPath: player.folderPath, videoLen: player.videoLen, allSameFolder: player.allSameFolder }));
    check('④c 当前视频已设置 poster 占位图 + preload=auto（消除首帧前黑屏间隙）',
      !!player.poster && player.preload === 'auto', JSON.stringify({ poster: player.poster ? player.poster.slice(0, 24) : '', preload: player.preload }));

    // ④d 封面层：盖在 video 上的独立 <img>，初始显示、不挡手势，hideCover 后淡出
    const coverInfo = await cdp.eval(`(function(){
      var el = state.videoElements[state.currentIndex];
      var cover = el.__cover;
      var before = cover && !cover.classList.contains('hidden');
      hideCover(cover);
      var after = cover && cover.classList.contains('hidden');
      var cs = cover && getComputedStyle(cover);
      return { exists: !!cover, tag: cover && cover.tagName, shownBefore: before, hiddenAfterHide: after, pointerEvents: cs && cs.pointerEvents, zIndex: cs && cs.zIndex };
    })()`);
    check('④d 封面层存在且初始显示、pointer-events:none、hideCover 生效（挡点播放黑闪）',
      coverInfo.exists && coverInfo.tag === 'IMG' && coverInfo.shownBefore && coverInfo.hiddenAfterHide &&
      coverInfo.pointerEvents === 'none' && coverInfo.zIndex === '2', JSON.stringify(coverInfo));

    // ---- ⑤ 播放器返回 -> 回到该文件夹详情 ----
    await cdp.eval(`document.getElementById('back-btn').click()`);
    await wait(400);
    const backToFolder = await cdp.eval(`({
      screen: state.currentScreen,
      detailActive: document.getElementById('folder-detail').classList.contains('active'),
      playerActive: document.getElementById('player').classList.contains('active'),
      rows: document.querySelectorAll('.video-row').length
    })`);
    check('⑤ 播放器返回回到该文件夹详情',
      backToFolder.screen === 'folder' && backToFolder.detailActive && !backToFolder.playerActive && backToFolder.rows === 3,
      JSON.stringify(backToFolder));

    // ---- ⑥ 详情返回 -> 媒体库主页 ----
    await cdp.eval(`document.getElementById('folder-back-btn').click()`);
    await wait(300);
    const backHome = await cdp.eval(`({
      screen: state.currentScreen,
      homeActive: document.getElementById('folder-select').classList.contains('active'),
      detailActive: document.getElementById('folder-detail').classList.contains('active'),
      playerActive: document.getElementById('player').classList.contains('active'),
      folders: document.querySelectorAll('.folder-card').length
    })`);
    check('⑥ 详情返回回到媒体库主页',
      backHome.screen === 'home' && backHome.homeActive && !backHome.detailActive && !backHome.playerActive && backHome.folders === 3,
      JSON.stringify(backHome));

    // ---- ⑥b/⑥c 下拉刷新：模拟下拉手势（touchstart→touchmove 越过阈值→touchend）触发刷新 ----
    await cdp.eval(`(function(){
      var list = document.getElementById('folder-list');
      function fire(type, y){
        var t = new Touch({ identifier: 1, target: list, clientX: 200, clientY: y });
        list.dispatchEvent(new TouchEvent(type, { touches: type==='touchend'?[]:[t], bubbles:true, cancelable:true }));
      }
      fire('touchstart', 300);
      fire('touchmove', 500); // dy=200 → dist=100 ≥ 阈值64
      fire('touchend', 500);
    })()`);
    await wait(120); // 刷新进行中（mock 每个文件夹延时 200ms）
    const midPtr = await cdp.eval(`({
      summary: (document.getElementById('library-summary') || {}).textContent,
      cards: document.querySelectorAll('.folder-card').length,
      ptrRefreshing: document.getElementById('ptr').classList.contains('refreshing'),
      rescanGone: document.getElementById('rescan-btn') === null
    })`);
    check('⑥b 下拉手势触发刷新：保留现有列表、显示刷新指示器、手动刷新按钮已移除',
      /正在刷新/.test(midPtr.summary) && midPtr.cards === 3 && midPtr.ptrRefreshing && midPtr.rescanGone,
      JSON.stringify(midPtr));

    // 等待刷新扫描完成
    for (let i = 0; i < 24; i++) {
      const s = await cdp.eval(`(document.getElementById('library-summary') || {}).textContent || ''`);
      if (/6 个视频 · 3 个文件夹/.test(s)) break;
      await wait(150);
    }
    const donePtr = await cdp.eval(`({
      summary: (document.getElementById('library-summary') || {}).textContent,
      cards: document.querySelectorAll('.folder-card').length,
      folders: state.folders.map(f => f.count),
      ptrRefreshing: document.getElementById('ptr').classList.contains('refreshing')
    })`);
    check('⑥c 下拉刷新完成后主页恢复完整列表（3 个、计数正确、指示器复位）',
      donePtr.cards === 3 && JSON.stringify(donePtr.folders) === '[3,2,1]' &&
      !donePtr.ptrRefreshing && /6 个视频 · 3 个文件夹/.test(donePtr.summary),
      JSON.stringify(donePtr));

    // ---- ⑥d 首次扫描(无数据)显示"加载中"而非黑屏空列表 ----
    await cdp.eval(`(function(){ state.allVideos = []; runScan(); })()`);
    await wait(80); // 第一个文件夹延时 200ms 后才下发，此刻应仍处于加载态
    const loadingState = await cdp.eval(`({
      loadingShown: document.getElementById('library-loading').classList.contains('show'),
      listShown: document.getElementById('folder-list').classList.contains('show'),
      emptyShown: document.getElementById('library-empty').classList.contains('show'),
      cards: document.querySelectorAll('.folder-card').length
    })`);
    check('⑥d 首次扫描显示"加载中"状态（非黑屏空列表）',
      loadingState.loadingShown && !loadingState.listShown && !loadingState.emptyShown && loadingState.cards === 0,
      JSON.stringify(loadingState));
    for (let i = 0; i < 24; i++) {
      const s = await cdp.eval(`(document.getElementById('library-summary') || {}).textContent || ''`);
      if (/6 个视频 · 3 个文件夹/.test(s)) break;
      await wait(150);
    }

    // ---- ⑦ 换一个文件夹（Download=2）也能正确进入并播放 ----
    await cdp.eval(`(function(){
      const card = Array.from(document.querySelectorAll('.folder-card')).find(c => c.dataset.path === '/sdcard/Download');
      card.click();
    })()`);
    await wait(200);
    const dlDetail = await cdp.eval(`({ rows: document.querySelectorAll('.video-row').length, screen: state.currentScreen })`);
    check('⑦ Download 文件夹显示 2 个视频', dlDetail.screen === 'folder' && dlDetail.rows === 2, JSON.stringify(dlDetail));

    await cdp.eval(`document.querySelectorAll('.video-row')[0].click()`);
    await wait(400);
    const dlPlayer = await cdp.eval(`({ items: document.querySelectorAll('.video-item').length, folderPath: state.currentFolderPath, allSameFolder: state.videos.every(v => v.folderPath === '/sdcard/Download') })`);
    check('⑦b 进入 Download 播放（范围=2，全部同文件夹）',
      dlPlayer.items === 2 && dlPlayer.folderPath === '/sdcard/Download' && dlPlayer.allSameFolder, JSON.stringify(dlPlayer));

    // ---- ⑧ 系统返回键（派发 window 'appBackButton' 模拟原生拦截）----
    // 播放中 -> 先关设置（若开）-> 再退全屏（若全屏）-> 再返回上一层；仅最顶层主页才退出应用
    // ⑧a: 打开设置后按返回 -> 只关设置，仍停留播放器
    await cdp.eval(`openSettings()`);
    await wait(120);
    const settingsOpen = await cdp.eval(`document.getElementById('settings-modal').classList.contains('active')`);
    await cdp.eval(`window.dispatchEvent(new Event('appBackButton'))`);
    await wait(150);
    const afterCloseSettings = await cdp.eval(`({
      screen: state.currentScreen,
      settingsActive: document.getElementById('settings-modal').classList.contains('active')
    })`);
    check('⑧a 播放中返回键优先关闭设置弹窗（仍停留播放器）',
      settingsOpen && !afterCloseSettings.settingsActive && afterCloseSettings.screen === 'player',
      JSON.stringify({ settingsOpen, afterCloseSettings }));

    // ⑧b: 全屏中按返回 -> 退全屏，仍停留播放器
    await cdp.eval(`setRotated(true)`);
    await wait(400);
    const rotatedOn = await cdp.eval(`document.getElementById('player').classList.contains('rotated-mode')`);
    await cdp.eval(`window.dispatchEvent(new Event('appBackButton'))`);
    await wait(400);
    const afterExitFs = await cdp.eval(`({
      screen: state.currentScreen,
      rotated: document.getElementById('player').classList.contains('rotated-mode')
    })`);
    check('⑧b 全屏中返回键退出全屏（仍停留播放器）',
      rotatedOn && !afterExitFs.rotated && afterExitFs.screen === 'player',
      JSON.stringify({ rotatedOn, afterExitFs }));

    // ⑧c: 播放中按返回 -> 返回所在文件夹详情
    await cdp.eval(`window.dispatchEvent(new Event('appBackButton'))`);
    await wait(300);
    const playerBack = await cdp.eval(`({
      screen: state.currentScreen,
      detailActive: document.getElementById('folder-detail').classList.contains('active'),
      playerActive: document.getElementById('player').classList.contains('active')
    })`);
    check('⑧c 播放中返回键返回上一层（所在文件夹详情）',
      playerBack.screen === 'folder' && playerBack.detailActive && !playerBack.playerActive,
      JSON.stringify(playerBack));

    // ⑧d: 文件夹详情按返回 -> 回到主页
    await cdp.eval(`window.dispatchEvent(new Event('appBackButton'))`);
    await wait(300);
    const folderBack = await cdp.eval(`({ screen: state.currentScreen, homeActive: document.getElementById('folder-select').classList.contains('active') })`);
    check('⑧d 文件夹详情返回键回到主页',
      folderBack.screen === 'home' && folderBack.homeActive, JSON.stringify(folderBack));

    // ⑧e: 最顶层主页按返回 -> 退出应用（调用 exitApp）
    await cdp.eval(`window.__EXIT_CALLED = 0`);
    await cdp.eval(`window.dispatchEvent(new Event('appBackButton'))`);
    await wait(200);
    const exitCalled = await cdp.eval(`({ screen: state.currentScreen, exit: window.__EXIT_CALLED || 0 })`);
    check('⑧e 最顶层主页返回键退出应用（仅此时才退出）',
      exitCalled.exit >= 1 && exitCalled.screen === 'home', JSON.stringify(exitCalled));

    const failed = results.filter(r => !r.pass);
    console.log('\n===== 汇总 =====');
    console.log(`通过 ${results.length - failed.length}/${results.length}`);
    try { fs.writeFileSync(path.join(projectRoot, 'verify-library.log'), out.join('\n')); } catch (_) { /* ignore */ }
    process.exitCode = failed.length ? 1 : 0;
  } catch (err) {
    console.error('验证脚本异常:', err);
    try { fs.writeFileSync(path.join(projectRoot, 'verify-library.log'), out.join('\n') + '\nERROR: ' + err.message); } catch (_) {}
    process.exitCode = 1;
  } finally {
    cleanup();
  }
})();
