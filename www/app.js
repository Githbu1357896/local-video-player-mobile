// 状态
const state = {
  videos: [],
  currentIndex: 0,
  isDragging: false,
  startY: 0,
  currentY: 0,
  offsetY: 0,
  videoElements: [],
  playbackRate: 1.0,
  brightness: 1.0,
  volume: 1.0,
  isSettingsOpen: false,
  isControlsVisible: true,
  isRotated: false,
  // 是否真正用 CSS transform 旋转了舞台（仅在浏览器调试 __SIMULATE_ROTATE 时为真）。
  // 在真机（native）上全屏改走系统原生横屏锁定，舞台不会被 CSS 旋转，
  // 这样视频画面由 WebView 原生渲染，不会出现"旋转后黑屏但音频继续"的问题。
  cssRotated: false,

  // ===== 媒体库（按文件夹归类）=====
  allVideos: [],           // 扫描到的全部视频（已统一字段）
  folders: [],             // 按文件夹路径分组后的结果
  currentFolderPath: null, // 当前打开的文件夹路径
  returnTo: 'home',        // 从播放器返回时的目标：'home' | 'folder'
  currentScreen: 'home'    // 当前屏幕：'home' | 'folder' | 'player'
};

// DOM 元素
const folderSelect = document.getElementById('folder-select');
const playerScreen = document.getElementById('player');
const playerStage = document.getElementById('player-stage');
const selectFolderBtn = document.getElementById('select-folder-btn');
const backBtn = document.getElementById('back-btn');
const videoStack = document.getElementById('video-stack');
const videoTitle = document.getElementById('video-title');
const progressContainer = document.getElementById('progress-container');
const progressFill = document.getElementById('progress-fill');
const progressThumb = document.getElementById('progress-thumb');
const currentTimeEl = document.getElementById('current-time');
const totalTimeEl = document.getElementById('total-time');
const playOverlay = document.getElementById('play-overlay');
const landscapeHint = document.getElementById('landscape-hint');
const landscapeHintText = document.getElementById('landscape-hint-text');
const settingsBtn = document.getElementById('settings-btn');
const settingsModal = document.getElementById('settings-modal');
const settingsBackdrop = document.getElementById('settings-backdrop');
const settingsPanel = document.getElementById('settings-panel');
const speedItem = document.getElementById('speed-item');
const speedValue = document.getElementById('speed-value');
const pipItem = document.getElementById('pip-item');
const seekZoneLeft = document.getElementById('seek-zone-left');
const seekZoneRight = document.getElementById('seek-zone-right');
const scanStatus = document.getElementById('scan-status');

// 媒体库 / 文件夹详情
const folderDetail = document.getElementById('folder-detail');
const folderList = document.getElementById('folder-list');
const folderBackBtn = document.getElementById('folder-back-btn');
const folderDetailTitle = document.getElementById('folder-detail-title');
const folderDetailSubtitle = document.getElementById('folder-detail-subtitle');
const videoList = document.getElementById('video-list');
const librarySummary = document.getElementById('library-summary');
const libraryEmpty = document.getElementById('library-empty');
const libraryLoading = document.getElementById('library-loading');
const emptyTitle = document.getElementById('empty-title');
const ptr = document.getElementById('ptr');
const ptrText = document.getElementById('ptr-text');

const SEEK_STEP = 15;

/**
 * 屏幕坐标 → 舞台内部坐标。
 * 只有真正用 CSS transform 旋转了舞台（浏览器调试 __SIMULATE_ROTATE）时才需要换算；
 * 真机全屏走系统横屏锁定，舞台不旋转，屏幕坐标即舞台坐标。
 * 所有命中判断（点击分区、拖进度条、上下滑切换）都要先过这一层换算。
 */
function screenToStage(clientX, clientY) {
  const base = playerScreen.getBoundingClientRect();
  const x = clientX - base.left;
  const y = clientY - base.top;
  if (!state.cssRotated) return { x, y };

  // translate(-50%,-50%) 刚好把舞台中心推到布局框左上角所在的位置
  const cx = playerStage.offsetLeft;
  const cy = playerStage.offsetTop;
  const w = playerStage.offsetWidth;
  const h = playerStage.offsetHeight;
  // 顺时针 90°：局部 (a,b) → 屏幕 (cx - b, cy + a)，这里反解回局部坐标
  return { x: (y - cy) + w / 2, y: (cx - x) + h / 2 };
}

/** 元素相对舞台的布局矩形：走 offset 累加，不受 transform 影响，旋转后依然准确 */
function stageLayoutBox(el) {
  let x = 0, y = 0, node = el;
  while (node && node !== playerStage) {
    x += node.offsetLeft;
    y += node.offsetTop;
    node = node.offsetParent;
  }
  return { x, y, w: el.offsetWidth, h: el.offsetHeight };
}

/**
 * 移动端视频源。
 * Android 下通过 Capacitor 原生插件扫描 MediaStore；
 * 非原生环境（浏览器调试）会自动降级。
 */
const VideoSource = {
  // Capacitor 的 Plugins 是普通对象，自定义插件必须显式 registerPlugin 才会出现，
  // 直接读 Capacitor.Plugins.VideoScanner 永远是 undefined。
  _api: undefined,

  get api() {
    if (this._api !== undefined) return this._api;

    const cap = window.Capacitor;
    if (!cap) {
      this._api = null;
      return null;
    }

    if (cap.Plugins && cap.Plugins.VideoScanner) {
      this._api = cap.Plugins.VideoScanner;
      return this._api;
    }

    if (typeof cap.registerPlugin === 'function') {
      try {
        this._api = cap.registerPlugin('VideoScanner');
        return this._api;
      } catch (err) {
        console.error('注册 VideoScanner 插件失败:', err);
      }
    }

    this._api = null;
    return null;
  },

  get native() {
    const isNative = window.Capacitor &&
      typeof window.Capacitor.isNativePlatform === 'function' &&
      window.Capacitor.isNativePlatform();
    return !!isNative && !!this.api;
  },

  /** 把 content:// 地址转成 WebView 可以播放的本地服务地址 */
  toPlayableUrl(rawUri) {
    if (!rawUri) return '';
    if (window.Capacitor && typeof window.Capacitor.convertFileSrc === 'function') {
      return window.Capacitor.convertFileSrc(rawUri);
    }
    return rawUri;
  },

  async listVideos() {
    if (!this.native) {
      throw new Error('NATIVE_UNAVAILABLE');
    }
    return await this.api.listVideos();
  },

  async openSettings() {
    if (this.native) {
      await this.api.openSettings();
      return true;
    }
    return false;
  },

  /** 锁定/解锁屏幕方向（真机全屏用）。mode: 'portrait' | 'landscape' | 'unlocked' */
  setOrientation(mode) {
    if (!this.native) return false;
    try {
      this.api.setOrientation({ orientation: mode });
      return true;
    } catch (err) {
      console.error('设置屏幕方向失败:', err);
      return false;
    }
  },

  /** 取某视频缩略图（懒加载用）。返回可直接用于 <img src> 的地址，失败返回空串 */
  async getThumbnail(id) {
    if (!id || !this.native) return '';
    if (this._thumbCache && this._thumbCache[id] !== undefined) {
      return this._thumbCache[id];
    }
    this._thumbCache = this._thumbCache || {};
    try {
      const r = await this.api.getThumbnail({ id, width: 480, height: 480 });
      const url = (r && r.uri) ? this.toPlayableUrl(r.uri) : '';
      this._thumbCache[id] = url;
      return url;
    } catch (err) {
      this._thumbCache[id] = '';
      return '';
    }
  },

  /**
   * 流式扫描：边扫边通过 onProgress 回调实时返回已发现的文件夹。
   * onProgress(data)：data.type==='folder' 新文件夹；data.type==='update' 某文件夹计数刷新。
   * 返回值与 listVideos 相同（完整视频列表），用于最终准确渲染。
   */
  async scanVideos(onProgress) {
    if (!this.native) throw new Error('NATIVE_UNAVAILABLE');
    let handle = null;
    try {
      handle = await this.api.addListener('videoScanProgress', (data) => {
        try { onProgress && onProgress(data); } catch (e) { console.error('onProgress', e); }
      });
    } catch (e) {
      // 监听注册失败则退化为一次性扫描（无实时进度，但最终结果仍正常）
      handle = null;
    }
    try {
      return await this.api.scanVideos();
    } finally {
      if (handle && handle.remove) { try { await handle.remove(); } catch (e) {} }
    }
  },

  /** 退出应用（最顶层主页按系统返回键时调用） */
  async exitApp() {
    if (!this.native) return false;
    try { await this.api.exitApp(); return true; } catch (err) { return false; }
  }
};

// 工具函数
function formatTime(seconds) {
  if (!isFinite(seconds) || isNaN(seconds)) return '00:00';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) {
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

function showToast(message) {
  let toast = document.querySelector('.toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.className = 'toast';
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2000);
}

// ===== 媒体库：文件夹视图 / 详情 / 导航 =====

/** 人类可读的文件大小 */
function formatSize(bytes) {
  if (!bytes || bytes < 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, n = bytes;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return (i === 0 ? String(n) : n.toFixed(1)) + ' ' + units[i];
}

/** 从完整路径取最后一段作为文件夹显示名 */
function displayFolderName(path) {
  if (!path) return '未分类';
  const parts = path.split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : path;
}

/** 把视频按文件夹路径分组归类 */
function groupByFolder(videos) {
  const map = new Map();
  videos.forEach(v => {
    const key = (v.folderPath && v.folderPath.trim()) || v.folder || '未分类';
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(v);
  });
  const folders = [];
  map.forEach((list, path) => {
    folders.push({
      path,
      name: displayFolderName(path),
      videos: list,
      count: list.length,
      totalDuration: list.reduce((s, v) => s + (v.duration || 0), 0),
      preview: list[0]
    });
  });
  // 数量多的在前，其次按名称，方便快速定位
  folders.sort((a, b) => b.count - a.count || a.path.localeCompare(b.path));
  return folders;
}

/** 缩略图占位图标 */
function placeholderIconSvg() {
  return '<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="1.5">' +
    '<rect x="2.5" y="5" width="19" height="14" rx="2.5"/>' +
    '<path d="M2.5 9.5h19M7 5v4.5M17 5v4.5"/></svg>';
}

/** 生成一个 <img>，缩略图就绪后显示；失败/无图则移除，保留占位图标 */
function makeThumbImg(video) {
  const img = document.createElement('img');
  img.alt = '';
  img.decoding = 'async';
  img.style.display = 'none';
  img.addEventListener('load', () => { img.style.display = 'block'; });
  img.addEventListener('error', () => { img.remove(); });
  VideoSource.getThumbnail(video.id).then(url => {
    if (url) img.src = url; else img.remove();
  });
  return img;
}

/** 屏幕路由：'home' 主页 | 'folder' 文件夹详情 | 'player' 播放器 */
function showScreen(name) {
  state.currentScreen = name;
  folderSelect.classList.toggle('active', name === 'home');
  folderDetail.classList.toggle('active', name === 'folder');
  playerScreen.classList.toggle('active', name === 'player');
}

/** 构建一个文件夹卡片元素（主页与实时扫描共用） */
function renderFolderCard(folder) {
  const card = document.createElement('button');
  card.type = 'button';
  card.className = 'folder-card';
  card.dataset.path = folder.path;

  const thumb = document.createElement('div');
  thumb.className = 'card-thumb';
  thumb.innerHTML = placeholderIconSvg();
  if (folder.preview) thumb.appendChild(makeThumbImg(folder.preview));
  const badge = document.createElement('span');
  badge.className = 'card-thumb-badge';
  badge.textContent = formatTime(folder.totalDuration || 0);
  thumb.appendChild(badge);

  const body = document.createElement('div');
  body.className = 'card-body';
  const name = document.createElement('div');
  name.className = 'card-name';
  name.textContent = folder.name;
  const path = document.createElement('div');
  path.className = 'card-path';
  path.textContent = folder.path;
  const meta = document.createElement('div');
  meta.className = 'card-meta';
  meta.textContent = `共 ${folder.count} 个视频`;
  body.appendChild(name);
  body.appendChild(path);
  body.appendChild(meta);

  card.appendChild(thumb);
  card.appendChild(body);
  card.addEventListener('click', () => openFolder(folder.path));
  return card;
}

/** 渲染主页：在"列表 / 加载态 / 空态"三者间切换，并填充内容 */
function renderLibraryHome() {
  state.folders = groupByFolder(state.allVideos);
  const total = state.allVideos.length;

  if (librarySummary) {
    librarySummary.textContent = total > 0
      ? `${total} 个视频 · ${state.folders.length} 个文件夹`
      : '未发现视频';
  }

  if (!total) {
    folderList.innerHTML = '';
    showLibraryState('empty');
    return;
  }

  showLibraryState('list');
  folderList.innerHTML = '';
  state.folders.forEach(folder => {
    folderList.appendChild(renderFolderCard(folder));
  });
}

/** 主页三种可视状态：'list' | 'loading' | 'empty'（互斥） */
function showLibraryState(which) {
  folderList.classList.toggle('show', which === 'list');
  libraryLoading.classList.toggle('show', which === 'loading');
  libraryEmpty.classList.toggle('show', which === 'empty');
}

// ---- 实时扫描（边扫边显示已发现的文件夹）----
let scanLocked = false;                 // 扫描进行中，避免并发/中途进入空文件夹
const liveCards = new Map();            // folderPath -> 卡片元素（实时更新用）

/** 把原生推送的文件夹对象规整成内部形态（预览视频保留 id 供缩略图） */
function normalizeLiveFolder(raw) {
  return {
    path: raw.path,
    name: raw.name,
    count: raw.count || 0,
    totalDuration: raw.totalDuration || 0,
    preview: raw.preview || null,
    videos: []
  };
}

/** 实时追加一个文件夹卡片 */
function appendFolderCard(folder) {
  const card = renderFolderCard(folder);
  liveCards.set(folder.path, card);
  folderList.appendChild(card);
}

/** 实时刷新某文件夹卡片的数量/时长 */
function updateFolderCard(raw) {
  const card = liveCards.get(raw.path);
  if (card) {
    const meta = card.querySelector('.card-meta');
    const badge = card.querySelector('.card-thumb-badge');
    if (meta) meta.textContent = `共 ${raw.count} 个视频`;
    if (badge) badge.textContent = formatTime(raw.totalDuration || 0);
  }
  const f = state.folders.find(x => x.path === raw.path);
  if (f) { f.count = raw.count; f.totalDuration = raw.totalDuration; }
}

/** 打开某个文件夹，渲染其视频列表 */
function renderFolderDetail(folderPath) {
  const folder = state.folders.find(f => f.path === folderPath);
  if (!folder) { showScreen('home'); return; }

  state.currentFolderPath = folderPath;
  folderDetailTitle.textContent = folder.name;
  folderDetailSubtitle.textContent = `${folder.path} · ${folder.count} 个视频`;

  videoList.innerHTML = '';
  folder.videos.forEach((v, index) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'video-row';
    row.dataset.index = index;

    const thumb = document.createElement('div');
    thumb.className = 'video-thumb';
    thumb.appendChild(makeThumbImg(v));
    const dur = document.createElement('span');
    dur.className = 'video-duration';
    dur.textContent = formatTime(v.duration || 0);
    thumb.appendChild(dur);

    const info = document.createElement('div');
    info.className = 'video-info';
    const name = document.createElement('div');
    name.className = 'video-name';
    name.textContent = v.name;
    const meta = document.createElement('div');
    meta.className = 'video-meta';
    meta.textContent = `${formatTime(v.duration || 0)} · ${formatSize(v.size)}` +
      (v.width && v.height ? ` · ${v.width}×${v.height}` : '');
    info.appendChild(name);
    info.appendChild(meta);

    const play = document.createElement('div');
    play.className = 'video-play';
    play.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';

    row.appendChild(thumb);
    row.appendChild(info);
    row.appendChild(play);
    row.addEventListener('click', () => playVideoInFolder(folderPath, index));
    videoList.appendChild(row);
  });

  showScreen('folder');
}

function openFolder(folderPath) {
  if (scanLocked) { showToast('正在扫描，请稍候…'); return; }
  renderFolderDetail(folderPath);
}

/** 播放某文件夹内的第 index 个视频：把该文件夹设为播放栈并进入播放器 */
function playVideoInFolder(folderPath, index) {
  const folder = state.folders.find(f => f.path === folderPath);
  if (!folder) return;
  state.currentFolderPath = folderPath;
  state.returnTo = 'folder';
  state.videos = folder.videos; // 播放范围限定为该文件夹
  state.currentIndex = index;
  showScreen('player');
  buildVideoStack();
  loadVideoAtIndex(index);
}

/** 从播放器返回上一级（文件夹详情 或 主页） */
function leavePlayer() {
  pauseAllVideos();
  setRotated(false);
  if (state.returnTo === 'folder' && state.currentFolderPath) {
    renderFolderDetail(state.currentFolderPath);
  } else {
    state.returnTo = 'home';
    showScreen('home');
  }
}

// 扫描手机视频
// awaitingPermission：标记当前按钮处于"去设置授权"状态
let awaitingPermission = false;

/** Promise 超时兜底：ms 内未 resolve 则调用 fallback（异步）取结果，确保扫描一定有终结状态 */
function withTimeout(promise, ms, fallback) {
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      Promise.resolve().then(fallback).then(resolve, (e) => reject(e || new Error('scan timeout')));
    }, ms);
    promise.then(
      (v) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } },
      (e) => { if (!done) { done = true; clearTimeout(timer); reject(e); } }
    );
  });
}

// ---- 下拉刷新（pull-to-refresh）指示器 ----
const PTR_THRESHOLD = 64;   // 触发刷新的下拉距离
const PTR_MAX = 100;        // 最大下拉距离（带阻尼）
let ptrStartY = 0, ptrActive = false, ptrDist = 0;

function ptrSpinner() { return ptr ? ptr.querySelector('.ptr-spinner') : null; }

/** 下拉过程中根据距离更新指示器（位移/透明度/旋转/文案） */
function ptrShow(dist) {
  if (!ptr) return;
  const d = Math.max(0, Math.min(dist, PTR_MAX));
  ptr.style.transition = 'none';
  ptr.style.opacity = String(Math.min(1, d / PTR_THRESHOLD));
  ptr.style.transform = `translateY(${d - 56}px)`;
  const sp = ptrSpinner();
  if (sp) sp.style.transform = `rotate(${d * 4}deg)`;
  if (ptrText) ptrText.textContent = d >= PTR_THRESHOLD ? '松开刷新' : '下拉刷新';
}

/** 进入"刷新中"状态（持续旋转） */
function ptrRefreshing() {
  if (!ptr) return;
  ptr.classList.add('refreshing');
  ptr.style.transition = '';
  ptr.style.opacity = '1';
  ptr.style.transform = 'translateY(0px)';
  const sp = ptrSpinner();
  if (sp) sp.style.transform = '';
  if (ptrText) ptrText.textContent = '正在刷新…';
}

/** 隐藏指示器并复位 */
function ptrHide() {
  if (!ptr) return;
  ptr.classList.remove('refreshing');
  ptr.style.transition = '';
  ptr.style.opacity = '0';
  ptr.style.transform = 'translateY(-56px)';
  const sp = ptrSpinner();
  if (sp) sp.style.transform = '';
  if (ptrText) ptrText.textContent = '下拉刷新';
  ptrActive = false;
  ptrDist = 0;
}

// 下拉刷新手势：仅在列表滚动到顶部、且向下拖动时触发
folderList.addEventListener('touchstart', (e) => {
  if (scanLocked) return;
  if (folderList.scrollTop > 0) return;
  ptrActive = true;
  ptrStartY = e.touches[0].clientY;
  ptrDist = 0;
}, { passive: true });

folderList.addEventListener('touchmove', (e) => {
  if (!ptrActive) return;
  if (folderList.scrollTop > 0) { ptrActive = false; ptrHide(); return; }
  const dy = e.touches[0].clientY - ptrStartY;
  if (dy <= 0) { ptrShow(0); return; }
  e.preventDefault(); // 阻止浏览器默认 Overscroll
  ptrDist = Math.min(dy * 0.5, PTR_MAX);
  ptrShow(ptrDist);
}, { passive: false });

folderList.addEventListener('touchend', () => {
  if (!ptrActive) return;
  const triggered = ptrDist >= PTR_THRESHOLD && !scanLocked;
  ptrActive = false;
  ptrDist = 0;
  if (triggered) {
    runScan({ viaPtr: true });
  } else {
    ptrHide();
  }
});

/**
 * 执行一次扫描（流式）。首次/无数据显示"加载中"并边扫边追加文件夹；
 * 下拉刷新(viaPtr)或已有数据时保留现有列表、仅显示顶部刷新指示器，完成后整体重渲。
 * 无论成功/空/权限拒绝/异常/超时，都会落到确定的可视状态，绝不残留黑屏空列表。
 */
async function runScan(opts) {
  opts = opts || {};
  const viaPtr = !!opts.viaPtr;
  if (scanLocked) return;

  // 已处于"去授权"状态时，点击按钮改为跳转到系统设置页
  if (awaitingPermission) {
    await VideoSource.openSettings();
    return;
  }

  if (!VideoSource.native) {
    showToast('请在手机上打开 App 后使用（当前为浏览器环境）');
    return;
  }

  scanLocked = true;
  selectFolderBtn.disabled = true;
  const isRefresh = viaPtr || state.allVideos.length > 0;

  if (isRefresh) {
    // 刷新：保留现有列表，仅显示顶部"刷新中"指示器
    if (librarySummary) librarySummary.textContent = '正在刷新...';
    ptrRefreshing();
  } else {
    // 首次/无数据：显示加载态并清空列表，避免黑屏空列表
    if (scanStatus) scanStatus.textContent = '正在读取媒体库...';
    if (librarySummary) librarySummary.textContent = '正在扫描本机视频...';
    if (emptyTitle) emptyTitle.textContent = '正在扫描...';
    state.allVideos = [];
    state.folders = [];
    liveCards.clear();
    folderList.innerHTML = '';
    showLibraryState('loading');
    ptrHide();
  }
  showScreen('home');

  let liveCount = 0;
  const onProgress = (data) => {
    if (!data || !data.type || !data.folder) return;
    if (isRefresh) return; // 刷新时保留旧列表，不增量追加，完成后整体重渲
    if (data.type === 'folder') {
      const folder = normalizeLiveFolder(data.folder);
      state.folders.push(folder);
      appendFolderCard(folder);
      liveCount++;
      if (librarySummary) librarySummary.textContent = `正在扫描… 已发现 ${liveCount} 个文件夹`;
    } else if (data.type === 'update') {
      updateFolderCard(data.folder);
    }
  };

  try {
    const result = await withTimeout(
      VideoSource.scanVideos(onProgress),
      20000,
      () => VideoSource.listVideos() // 超时兜底：回退一次性扫描，确保有终结状态
    );

    if (result && result.permissionDenied) {
      awaitingPermission = true;
      showToast('需要存储权限才能读取视频');
      state.allVideos = [];
      renderLibraryHome();
      if (emptyTitle) emptyTitle.textContent = '需要存储权限';
      if (scanStatus) {
        scanStatus.innerHTML = '未授予视频读取权限。<br/>点击下方按钮前往设置授权。';
      }
      selectFolderBtn.textContent = '去设置授权';
      showScreen('home');
      return;
    }

    awaitingPermission = false;
    const videos = (result && result.videos) || [];

    if (videos.length === 0) {
      showToast('手机上没有检测到视频文件');
      state.allVideos = [];
      renderLibraryHome();
      if (emptyTitle) emptyTitle.textContent = '未发现视频';
      if (scanStatus) scanStatus.textContent = '未检测到视频文件';
      selectFolderBtn.textContent = '重新扫描';
      showScreen('home');
      return;
    }

    // 统一字段后渲染主页（按文件夹归类，覆盖实时扫描的中间态）
    state.allVideos = videos.map(v => ({
      id: v.id,
      name: v.name,
      path: v.path,
      url: VideoSource.toPlayableUrl(v.uri || v.path),
      duration: v.duration,
      size: v.size,
      width: v.width,
      height: v.height,
      folder: v.folder,
      folderPath: v.folderPath
    }));
    state.currentIndex = 0;
    state.returnTo = 'home';

    renderLibraryHome();
    showScreen('home');
    showToast(`已扫描到 ${state.allVideos.length} 个视频`);
    selectFolderBtn.textContent = '重新扫描';
  } catch (err) {
    if (!state.allVideos.length) renderLibraryHome(); // 无数据则落为空态，避免一直转圈/黑屏
    console.error('扫描视频失败:', err);
    showToast('扫描视频失败，请重试');
    if (scanStatus) scanStatus.textContent = '扫描失败，请重试';
    selectFolderBtn.textContent = '重新扫描';
  } finally {
    ptrHide();
    showScreen('home');
    scanLocked = false;
    selectFolderBtn.disabled = false;
  }
}

selectFolderBtn.addEventListener('click', () => runScan());

// 从系统设置页返回后，自动重试扫描
function retryAfterResume() {
  if (!awaitingPermission) return;
  awaitingPermission = false;
  if (document.hidden) return;
  runScan();
}

window.addEventListener('focus', retryAfterResume);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) retryAfterResume();
});

// 顶部返回图标：全屏状态下优先"退出全屏"，非全屏状态返回上一级
// （从文件夹进来则回到该文件夹的视频列表，否则回到媒体库主页）
backBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  if (state.isRotated) {
    setRotated(false);
    setControlsVisible(true);
    scheduleAutoHide();
    showToast('已退出全屏');
    return;
  }
  leavePlayer();
});

// 文件夹详情页返回图标：回到媒体库主页
folderBackBtn.addEventListener('click', () => {
  showScreen('home');
});

// （手动"重新扫描"按钮已移除，刷新改为主页下拉手势触发，见上方 folderList 的 PTR 处理）

// ===== 系统返回键（物理返回键 / 手势返回）=====
// 原生 MainActivity 拦截 onBackPressed 后派发 window 'appBackButton' 事件到此处。
// 规则：子界面返回上一层；仅位于最顶层主界面时才退出应用。
function handleSystemBack() {
  if (state.currentScreen === 'player') {
    if (state.isSettingsOpen) { closeSettings(); return; } // 先关设置弹窗
    if (state.isRotated) {                                  // 再退全屏
      setRotated(false);
      setControlsVisible(true);
      scheduleAutoHide();
      return;
    }
    leavePlayer();                                          // 播放中 -> 返回所在文件夹详情
  } else if (state.currentScreen === 'folder') {
    showScreen('home');                                     // 文件夹详情 -> 主页
  } else {
    VideoSource.exitApp();                                  // 最顶层主界面 -> 退出应用
  }
}

window.addEventListener('appBackButton', () => handleSystemBack());

// 构建视频栈
function buildVideoStack() {
  videoStack.innerHTML = '';
  state.videoElements = [];

  state.videos.forEach((video, index) => {
    const item = document.createElement('div');
    item.className = 'video-item';
    item.dataset.index = index;

    const el = document.createElement('video');
    // 移动端视频数量可能很多，改为懒加载：先只给相邻的视频挂 src
    el.dataset.src = video.url;
    el.preload = 'none';
    el.playsInline = true;
    el.setAttribute('playsinline', '');
    el.setAttribute('webkit-playsinline', '');
    el.loop = true;
    el.muted = false;
    el.volume = state.volume;
    // 关联视频对象，供设置 poster（首帧前的占位图）使用
    el.__video = video;

    item.appendChild(el);

    // 封面层：盖在 video 之上的独立 <img>（缩略图），由我们控制显隐，
    // 仅在视频真正出画的 'playing' 时才淡出 —— 消除"点击播放→真正播放"之间的黑屏闪烁
    // （WebView 仅有首帧时点播放，需经本地 HTTP 桥补缓冲+初始化解码器，会短暂清空视频层）。
    const cover = document.createElement('img');
    cover.className = 'video-cover';
    cover.alt = '';
    cover.decoding = 'async';
    VideoSource.getThumbnail(video.id).then((url) => { if (url) cover.src = url; });
    item.appendChild(cover);
    el.__cover = cover;

    videoStack.appendChild(item);
    state.videoElements.push(el);

    // 事件监听
    el.addEventListener('loadedmetadata', () => {
      if (index === state.currentIndex) {
        totalTimeEl.textContent = formatTime(el.duration);
        checkAspectRatio(el);
      }
    });

    el.addEventListener('timeupdate', () => {
      if (index === state.currentIndex && !state.isDragging) {
        updateProgress(el.currentTime, el.duration);
      }
    });

    el.addEventListener('play', () => {
      if (index === state.currentIndex) {
        updatePlayOverlay(); // 图标切回"暂停"
        scheduleAutoHide();  // 开始播放 → 3 秒后自动隐藏控制栏
      }
    });

    el.addEventListener('pause', () => {
      if (index === state.currentIndex) {
        cancelAutoHide();         // 暂停时取消自动隐藏
        setControlsVisible(true); // 并立即把控制栏显示回来
        updatePlayOverlay();      // 图标切回"播放"
      }
    });

    el.addEventListener('click', (e) => {
      e.stopPropagation();
      handleVideoTap(el, screenToStage(e.clientX, e.clientY).x);
    });

    // 封面显隐：真正播放出画(playing)才隐藏；缓冲(waiting)/拖动 seek(seeking)时盖回挡黑屏
    el.addEventListener('playing', () => hideCover(el.__cover));
    el.addEventListener('waiting', () => { if (index === state.currentIndex) showCover(el.__cover); });
    el.addEventListener('seeking', () => showCover(el.__cover));
    el.addEventListener('seeked', () => hideCover(el.__cover));
  });
}

/** 显示/隐藏视频封面层（首帧前与缓冲中的占位，挡黑屏） */
function showCover(cover) { if (cover) cover.classList.remove('hidden'); }
function hideCover(cover) { if (cover) cover.classList.add('hidden'); }

/**
 * 给 video 元素设置 poster（首帧渲染前的占位图 = 该视频缩略图）。
 * 作用：消除"点击视频 → 真正出画"之间的黑屏/空白间隙——播放器一显示就先画出缩略图，
 * 视频首帧就绪后浏览器会自动用真实画面覆盖 poster，实现平滑过渡。
 * 说明：文件夹列表页已对每个视频取过缩略图，getThumbnail 多能命中缓存（同步级返回）；
 * 未命中则异步取，取到再补上（仍早于首帧，因为视频加载/解码更慢）。
 */
function applyVideoPoster(el) {
  const video = el && el.__video;
  if (!video || !video.id || el.__posterApplied) return;
  el.__posterApplied = true;
  const cached = VideoSource._thumbCache && VideoSource._thumbCache[video.id];
  if (cached) {
    try { el.poster = cached; } catch (e) { /* ignore */ }
    return;
  }
  VideoSource.getThumbnail(video.id).then((url) => {
    if (url && !el.poster) { try { el.poster = url; } catch (e) { /* ignore */ } }
  });
}

/** 给指定 video 元素挂上播放地址（懒加载） */
function ensureLoaded(el) {
  if (el && el.dataset.src && !el.getAttribute('src')) {
    el.setAttribute('src', el.dataset.src);
    el.load();
    applyVideoPoster(el); // 挂 src 的同时设置 poster，覆盖加载/解码前的黑屏间隙
  }
}

/** 预加载当前视频及前后各一个 */
function ensureWindowLoaded(index) {
  const total = state.videoElements.length;
  if (!total) return;
  for (let i = Math.max(0, index - 1); i <= Math.min(total - 1, index + 1); i++) {
    ensureLoaded(state.videoElements[i]);
  }
}

// 单击显示/隐藏控制栏；双击播放/暂停；双击左/右边缘快退/快进 15 秒
const DOUBLE_TAP_DELAY = 260;
const SEEK_EDGE_RATIO = 0.3; // 左右各 30% 宽度为快退/快进区
const AUTO_HIDE_DELAY = 3000; // 播放中无操作 3 秒自动隐藏控制栏
// 上/下滑切换视频的触发阈值：占视口高度的比例。值越小越灵敏（滑动距离更短即切换）。
// 由 0.15 下调到 0.08，提升上滑切到下一个视频的灵敏度。
const SWIPE_SWITCH_RATIO = 0.08;

let tapTimer = null;
let autoHideTimer = null;

// 转屏过渡期的"旋转中"标记 + debounce 解除定时器。
// 真机在「进入/退出全屏」或「横竖屏切换」时系统会旋转屏幕，WebView 在转屏过渡期
// 会合成/误派 click 事件，这些事件常落在设置按钮或背景上，导致 openSettings / closeSettings
// 被"自动"触发，表现为侧边栏不受控地弹出又隐藏、产生闪烁。
//
// 关键教训：之前用"固定 500ms 时间窗口"去猜合成 click 何时到达 —— 但设备旋转动画时长不固定、
// 合成 click 派发时机也不确定，500ms 往往不够，于是误触 click 落在窗口之外仍会弹出。
// 正确做法是不靠猜时间，而是跟踪"是否正在转屏"这个状态：
//   · setRotated / orientationchange / resize 触发时【同步】置位 isRotating；
//   · 之后用 debounce：只要转屏事件还在继续，就一直顺延"解除"时机；
//     最后一次转屏事件后再过 ROTATE_SETTLE_MS 没有新事件，才认为转屏稳定，解除 isRotating。
// 这样无论设备旋转动画多长、合成 click 何时派发，锁定都覆盖整个过渡期。
// openSettings / 背景关闭都在 isRotating 期间被忽略，弹窗显示状态保持稳定。
// 转屏稳定后用户主动点击设置按钮仍正常弹出（不破坏手动交互）。
let isRotating = false;
let rotationSettleTimer = null;
const ROTATE_SETTLE_MS = 800;

function armRotationLock() {
  isRotating = true;
  playerScreen.classList.add('rotating'); // 同时用 CSS 把设置按钮/背景的 pointer-events 关掉，双重保险
  if (rotationSettleTimer) clearTimeout(rotationSettleTimer);
  rotationSettleTimer = setTimeout(() => {
    isRotating = false;
    rotationSettleTimer = null;
    playerScreen.classList.remove('rotating');
  }, ROTATE_SETTLE_MS);
}

/** 统一的控制器显隐入口 */
function setControlsVisible(visible) {
  if (state.isControlsVisible === visible) return;
  state.isControlsVisible = visible;
  playerScreen.classList.toggle('controls-hidden', !visible);
  updatePlayOverlay();
}

/**
 * 中央播放/暂停按钮。
 * 之前它 pointer-events:none 且只在暂停时露出，导致按钮根本点不动。
 * 现在：控制栏可见时常驻显示，图标随播放状态切换（播放中显示暂停条），单击即可切换。
 */
function updatePlayOverlay() {
  const video = state.videoElements[state.currentIndex];
  const playing = !!video && !video.paused;
  playOverlay.classList.toggle('is-playing', playing);
  playOverlay.classList.toggle('hidden', !state.isControlsVisible);
}

/** 播放中启动自动隐藏倒计时；暂停或打开设置时会被取消 */
function scheduleAutoHide() {
  clearTimeout(autoHideTimer);
  autoHideTimer = null;

  if (state.isSettingsOpen) return;

  const video = state.videoElements[state.currentIndex];
  if (!video || video.paused) return;

  autoHideTimer = setTimeout(() => {
    autoHideTimer = null;
    setControlsVisible(false);
  }, AUTO_HIDE_DELAY);
}

function cancelAutoHide() {
  clearTimeout(autoHideTimer);
  autoHideTimer = null;
}

function toggleControls() {
  if (state.isSettingsOpen) return; // 设置面板打开时不要动
  setControlsVisible(!state.isControlsVisible);
  // 手动显示后重新开始倒计时，隐藏则无需计时
  scheduleAutoHide();
}

function handleVideoTap(video, stageX) {
  // 已经有一次待判定的点击 → 这次是双击
  if (tapTimer) {
    clearTimeout(tapTimer);
    tapTimer = null;

    // 用舞台坐标算比例：全屏旋转后左右快进区自动跟着转到屏幕上下两侧
    const ratio = stageX / playerStage.offsetWidth;

    if (ratio <= SEEK_EDGE_RATIO) {
      seekBySeconds(video, -SEEK_STEP, true);
    } else if (ratio >= 1 - SEEK_EDGE_RATIO) {
      seekBySeconds(video, SEEK_STEP, false);
    } else {
      togglePlay(video); // 双击中间 → 播放/暂停
    }
    return;
  }

  // 第一次点击，先等一等看有没有第二次
  tapTimer = setTimeout(() => {
    tapTimer = null;
    toggleControls(); // 单击 → 显示/隐藏控制栏
  }, DOUBLE_TAP_DELAY);
}

function seekBySeconds(video, delta, isLeft) {
  if (!video || !isFinite(video.duration) || isNaN(video.duration)) return;

  const target = Math.max(0, Math.min(video.duration, video.currentTime + delta));
  video.currentTime = target;
  updateProgress(target, video.duration);
  flashSeekZone(isLeft);
}

let seekFlashTimer = null;

function flashSeekZone(isLeft) {
  const zone = isLeft ? seekZoneLeft : seekZoneRight;
  zone.classList.remove('active');
  void zone.offsetWidth; // 重启弹出动画
  zone.classList.add('active');

  clearTimeout(seekFlashTimer);
  seekFlashTimer = setTimeout(() => zone.classList.remove('active'), 650);
}

function togglePlay(video) {
  if (video.paused) {
    video.play().catch(err => console.log('播放失败:', err));
  } else {
    video.pause();
  }
}

// 中央播放/暂停按钮：单击即切换播放状态。
// 必须阻止冒泡，否则会同时触发"单击切换控制栏"以及视口的上下滑切换视频。
let lastPlayToggleAt = 0;

playOverlay.addEventListener('click', (e) => {
  e.stopPropagation();
  const video = state.videoElements[state.currentIndex];
  if (!video) return;

  // 双击手势正好落在按钮上时只响应一次，避免来回切换却看不出变化
  const now = Date.now();
  if (now - lastPlayToggleAt < 400) return;
  lastPlayToggleAt = now;

  togglePlay(video);
  cancelAutoHide();
  setControlsVisible(true);
  updatePlayOverlay();
  if (!video.paused) scheduleAutoHide();
});

function pauseAllVideos() {
  state.videoElements.forEach(v => {
    v.pause();
    v.currentTime = 0;
  });
}

function loadVideoAtIndex(index) {
  if (index < 0 || index >= state.videos.length) return;

  // 暂停旧的（但【不】退出全屏：全屏状态下上下滑切换视频要保持当前方向不变）
  state.videoElements.forEach((v, i) => {
    if (i !== index) {
      v.pause();
      v.currentTime = 0;
    }
  });

  ensureWindowLoaded(index);

  state.currentIndex = index;
  const currentVideo = state.videoElements[index];
  // 切到某视频先显示其封面，直到它真正播放(playing)再淡出，避免切换/进入瞬间黑屏
  showCover(currentVideo.__cover);
  currentVideo.playbackRate = state.playbackRate;
  currentVideo.volume = state.volume;

  videoTitle.textContent = state.videos[index].name;
  updateStackPosition(0);

  // 切换视频：先显示控制栏并清掉旧计时，等 play 事件再重新计时
  cancelAutoHide();
  setControlsVisible(true);

  // 预加载前后视频；当前视频也设为 auto，加快起播缓冲、缩短黑屏间隙
  currentVideo.preload = 'auto';
  if (index > 0) state.videoElements[index - 1].preload = 'auto';
  if (index < state.videos.length - 1) state.videoElements[index + 1].preload = 'auto';

  // 自动播放（被阻止时把控制栏和中央按钮显示出来，方便手动点播放）
  updatePlayOverlay();
  currentVideo.play().catch(err => {
    console.log('自动播放被阻止:', err);
    setControlsVisible(true);
    updatePlayOverlay();
  });

  currentTimeEl.textContent = '00:00';
  totalTimeEl.textContent = formatTime(currentVideo.duration || 0);

  if (currentVideo.readyState >= 1) {
    checkAspectRatio(currentVideo);
  }
}

function checkAspectRatio(video) {
  if (!video.videoWidth || !video.videoHeight) {
    landscapeHint.classList.add('hidden');
    return;
  }

  const ratio = video.videoWidth / video.videoHeight;
  // 全屏时不再显示这个提示（退出交给顶部返回图标）
  if (ratio > 1.1 && !state.isRotated) {
    landscapeHint.classList.remove('hidden');
    updateLandscapeHintText(video);
  } else {
    landscapeHint.classList.add('hidden');
  }
}

/**
 * 切换全屏模式。
 * - 真机（native）：调用系统方向锁定，把屏幕本身转成横屏，视频由 WebView 原生渲染，
 *   舞台不做 CSS 旋转 —— 这样不会出现"旋转后黑屏但音频继续"的问题。
 * - 浏览器调试：默认也不旋转（避免坐标错乱）；仅在 window.__SIMULATE_ROTATE 为真时
 *   才用 CSS transform 旋转舞台，用于本地预览验证布局。
 */
function setRotated(on) {
  on = !!on;
  state.isRotated = on;
  playerScreen.classList.toggle('rotated-mode', on);

  // 真机且非调试：用系统横屏锁定（视频原生渲染，不黑屏）。
  // __SIMULATE_ROTATE 为真时（本地预览/验证）强制走 CSS 旋转，以便检查布局。
  if (VideoSource.native && !window.__SIMULATE_ROTATE) {
    state.cssRotated = false;
    playerScreen.classList.remove('css-rotated');
    VideoSource.setOrientation(on ? 'landscape' : 'portrait');
  } else {
    const useCss = on && !!window.__SIMULATE_ROTATE;
    state.cssRotated = useCss;
    playerScreen.classList.toggle('css-rotated', useCss);
  }

  // 进入全屏：强制关闭设置抽屉（侧边栏），避免遮挡画面
  if (on) {
    closeSettings();
  }
  // 进入/退出全屏都会触发系统横屏切换动画，过渡期内可能合成误触 click。
  // 同步置位 isRotating（覆盖 orientationchange 之前的阶段），由 debounce 在转屏稳定后解除。
  // 注意：进入和退出都要挂 —— 退出全屏(portrait 旋转)同样可能产生误触，旧实现漏掉了退出分支。
  armRotationLock();

  updateLandscapeHintText();

  // 方向/尺寸变化后瞬时校正视频栈，避免残留偏移与滑行闪烁
  recalibrateStack();
}

/**
 * 提示文案固定为"全屏观看"：退出全屏已改由顶部标题栏返回图标负责，
 * 全屏状态下这个提示不再显示（CSS 里 rotated-mode 也会 display:none）。
 */
function updateLandscapeHintText() {
  if (!landscapeHintText) return;
  landscapeHintText.textContent = '全屏观看';
  if (state.isRotated) {
    // 全屏时隐藏（CSS rotated-mode 也会 display:none）
    landscapeHint.classList.add('hidden');
  } else {
    // 退出全屏后重新显示"全屏观看"按钮，保证可再次进入全屏（不再永久消失）
    const v = state.videoElements[state.currentIndex];
    if (v) landscapeHint.classList.remove('hidden');
  }
}

/**
 * 更新视频栈偏移。
 * snap=true 时关闭过渡、瞬时归位：屏幕旋转/尺寸变化必须走这条路，
 * 否则栈会带着 0.3s 过渡从"旧视口高度算出的位置"滑向新位置，
 * 表现为切换全屏时闪烁、以及视频上方露出上一段视频的画面。
 */
function updateStackPosition(offset, snap) {
  /*
   * 基准偏移用【百分比】而不是 px。
   * translateY 的百分比相对元素自身高度解析，而 #video-stack 高度 = 视口高度，
   * 所以 -index*100% 恒等于 -index*视口高度：屏幕旋转、地址栏收放、WebView 重排滞后
   * 等任何尺寸变化，浏览器都会自动重算，不再依赖 JS 读到的 clientHeight 快照
   * （真机上这个快照在方向切换后往往是旧值，正是"露出上一段画面"的根因）。
   * 拖拽的临时位移仍用 px，两者用 calc 相加。
   */
  const base = -state.currentIndex * 100;
  const value = `translateY(calc(${base}% + ${offset}px))`;

  if (snap) {
    const prev = videoStack.style.transition;
    videoStack.style.transition = 'none';
    videoStack.style.transform = value;
    void videoStack.offsetHeight; // 强制重排，确保新位置在无过渡状态下提交
    videoStack.style.transition = prev || '';
  } else {
    videoStack.style.transform = value;
  }
}

/**
 * 屏幕旋转/尺寸变化后瞬时校正视频栈。
 * Android WebView 在方向切换后重排可能滞后若干帧，所以除立即校正外
 * 再补一帧 rAF 和两次延时兜底，确保偏移按新视口高度算准。
 */
function recalibrateStack() {
  updateStackPosition(0, true);
  requestAnimationFrame(() => updateStackPosition(0, true));
  setTimeout(() => updateStackPosition(0, true), 120);
  setTimeout(() => updateStackPosition(0, true), 420);
}

// 滑动切换
const viewport = document.getElementById('video-viewport');

function onDragStart(y) {
  state.isDragging = true;
  state.startY = y;
  state.currentY = y;
  state.offsetY = 0;
  videoStack.style.transition = 'none';
}

function onDragMove(y) {
  if (!state.isDragging) return;
  state.offsetY = y - state.startY;
  updateStackPosition(state.offsetY);
}

function onDragEnd() {
  if (!state.isDragging) return;
  state.isDragging = false;
  videoStack.style.transition = 'transform 0.3s cubic-bezier(0.25, 0.46, 0.45, 0.94)';

  // 触发阈值改用 SWIPE_SWITCH_RATIO（视口高度的 8%）：比原来的 15% 更灵敏，
  // 上滑更短距离即可切到下一个视频；direction=1 为上滑(next)，-1 为下拉(prev)。
  const threshold = viewport.clientHeight * SWIPE_SWITCH_RATIO;
  const direction = state.offsetY > threshold ? -1 : (state.offsetY < -threshold ? 1 : 0);

  if (direction === -1 && state.currentIndex > 0) {
    loadVideoAtIndex(state.currentIndex - 1);
  } else if (direction === 1 && state.currentIndex < state.videos.length - 1) {
    loadVideoAtIndex(state.currentIndex + 1);
  } else {
    updateStackPosition(0);
  }
}

// 鼠标事件
viewport.addEventListener('mousedown', (e) => {
  if (e.target.closest('.bottom-controls') || e.target.closest('.top-bar')) return;
  onDragStart(screenToStage(e.clientX, e.clientY).y);
});

window.addEventListener('mousemove', (e) => {
  onDragMove(screenToStage(e.clientX, e.clientY).y);
});

window.addEventListener('mouseup', () => {
  onDragEnd();
});

// 触摸事件
viewport.addEventListener('touchstart', (e) => {
  if (e.target.closest('.bottom-controls') || e.target.closest('.top-bar') || e.target.closest('.settings-modal')) return;
  const t = e.touches[0];
  onDragStart(screenToStage(t.clientX, t.clientY).y);
}, { passive: false });

window.addEventListener('touchmove', (e) => {
  if (!state.isDragging) return;
  const t = e.touches[0];
  onDragMove(screenToStage(t.clientX, t.clientY).y);
}, { passive: false });

window.addEventListener('touchend', () => {
  onDragEnd();
});

// 滚轮切换
viewport.addEventListener('wheel', (e) => {
  if (state.isSettingsOpen) return;
  e.preventDefault();
  if (e.deltaY > 50 && state.currentIndex < state.videos.length - 1) {
    loadVideoAtIndex(state.currentIndex + 1);
  } else if (e.deltaY < -50 && state.currentIndex > 0) {
    loadVideoAtIndex(state.currentIndex - 1);
  }
}, { passive: false });

// 键盘快捷键
window.addEventListener('keydown', (e) => {
  const video = state.videoElements[state.currentIndex];
  if (!video) return;

  switch (e.code) {
    case 'Space':
      e.preventDefault();
      togglePlay(video);
      break;
    case 'ArrowLeft':
      video.currentTime = Math.max(0, video.currentTime - 5);
      break;
    case 'ArrowRight':
      video.currentTime = Math.min(video.duration, video.currentTime + 5);
      break;
    case 'ArrowUp':
      if (state.currentIndex > 0) loadVideoAtIndex(state.currentIndex - 1);
      break;
    case 'ArrowDown':
      if (state.currentIndex < state.videos.length - 1) loadVideoAtIndex(state.currentIndex + 1);
      break;
  }
});

// "全屏观看"提示：点击进入全屏（退出全屏已改由顶部标题栏返回图标负责）
landscapeHint.addEventListener('click', (e) => {
  e.stopPropagation();
  if (state.isRotated) return;

  setRotated(true);
  // 切换后把控制栏显示出来并重新计时，避免刚好撞上自动隐藏
  setControlsVisible(true);
  scheduleAutoHide();

  showToast('已切换全屏');
});

// 进度条
function updateProgress(current, duration) {
  if (!duration || isNaN(duration)) return;
  const percent = (current / duration) * 100;
  progressFill.style.width = `${percent}%`;
  progressThumb.style.left = `${percent}%`;
  currentTimeEl.textContent = formatTime(current);
}

let isDraggingProgress = false;

progressContainer.addEventListener('mousedown', (e) => {
  isDraggingProgress = true;
  cancelAutoHide(); // 拖进度条期间不要自动隐藏
  seekFromEvent(e);
});

window.addEventListener('mousemove', (e) => {
  if (isDraggingProgress) {
    seekFromEvent(e);
  }
});

window.addEventListener('mouseup', () => {
  if (isDraggingProgress) {
    isDraggingProgress = false;
    scheduleAutoHide(); // 松手后重新开始倒计时
  }
});

progressContainer.addEventListener('touchstart', (e) => {
  isDraggingProgress = true;
  cancelAutoHide();
  seekFromEvent(e.touches[0]);
}, { passive: false });

window.addEventListener('touchmove', (e) => {
  if (isDraggingProgress) {
    seekFromEvent(e.touches[0]);
  }
}, { passive: false });

window.addEventListener('touchend', () => {
  if (isDraggingProgress) {
    isDraggingProgress = false;
    scheduleAutoHide();
  }
});

function seekFromEvent(e) {
  const box = stageLayoutBox(progressContainer);
  const p = screenToStage(e.clientX, e.clientY);
  const x = Math.max(0, Math.min(p.x - box.x, box.w));
  const percent = x / box.w;
  const video = state.videoElements[state.currentIndex];
  if (video && video.duration) {
    video.currentTime = percent * video.duration;
    updateProgress(video.currentTime, video.duration);
  }
}

// 设置弹窗
/**
 * 打开设置弹窗（侧边栏）。显隐控制条件（全屏 vs 非全屏 明确区分）：
 *
 * - 非全屏（竖屏）：设置按钮点击即弹出底部抽屉，无任何额外限制。
 * - 全屏（rotated-mode）：
 *     · 转屏过渡期（isRotating 为真）一律忽略本次打开，屏蔽"系统横屏切换过渡"
 *       合成的误触 click 自动弹出侧边栏 —— 这正是"进入/退出全屏侧边栏不受控自动弹出"的根因；
 *     · isRotating 由 setRotated / orientationchange / resize 同步置位，并在转屏稳定后自动解除，
 *       因此过渡期之外（已稳定）用户主动点击设置按钮仍可正常弹出右侧 30% 抽屉，不破坏手动交互；
 *     · 本函数只由设置按钮的 click 触发，orientationchange/resize 不会自动调用它，
 *       故"屏幕旋转本身"不会自动弹出侧边栏，只有转屏过渡期的误触会被 isRotating 挡掉。
 */
function openSettings() {
  // 转屏过渡期内的误触（坐标错乱导致的合成 click）一律忽略，避免侧边栏自动弹出
  if (isRotating) return;
  state.isSettingsOpen = true;
  settingsModal.classList.add('active');
  cancelAutoHide(); // 设置面板打开期间不自动隐藏
  setControlsVisible(true);
}

function closeSettings() {
  state.isSettingsOpen = false;
  settingsModal.classList.remove('active');
  scheduleAutoHide(); // 关闭后恢复自动隐藏倒计时
}

settingsBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  openSettings();
});

settingsBackdrop.addEventListener('click', () => {
  // 转屏过渡期内的误触 click 也可能落在背景上把弹窗关掉，一并忽略以保持显示状态稳定
  if (isRotating) return;
  closeSettings();
});
settingsPanel.addEventListener('click', (e) => e.stopPropagation());

// 倍速
speedItem.addEventListener('click', () => {
  const speeds = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0];
  let currentIdx = speeds.indexOf(state.playbackRate);
  if (currentIdx === -1) currentIdx = 2;
  const nextIdx = (currentIdx + 1) % speeds.length;
  state.playbackRate = speeds[nextIdx];

  state.videoElements.forEach(v => {
    v.playbackRate = state.playbackRate;
  });

  speedValue.textContent = `${state.playbackRate.toFixed(state.playbackRate % 1 === 0 ? 0 : 1)}X`;
  showToast(`播放速度: ${speedValue.textContent}`);
});

// 画中画
pipItem.addEventListener('click', async () => {
  const video = state.videoElements[state.currentIndex];
  if (!video) return;

  try {
    // Android WebView 多数不支持 PiP，这里做能力检测后再调用
    const canPip = !!(document.pictureInPictureEnabled &&
      video.requestPictureInPicture &&
      (video.disablePictureInPicture === false || video.disablePictureInPicture === undefined));

    if (!canPip) {
      showToast('当前设备不支持画中画');
      return;
    }

    if (document.pictureInPictureElement) {
      await document.exitPictureInPicture();
    } else {
      await video.requestPictureInPicture();
    }
  } catch (err) {
    console.error('画中画失败:', err);
    showToast('画中画不可用');
  }
});

// 滑块通用逻辑
function setupSlider(trackId, fillId, thumbId, valueId, initialValue, onChange) {
  const track = document.getElementById(trackId);
  const fill = document.getElementById(fillId);
  const thumb = document.getElementById(thumbId);
  const valueLabel = valueId ? document.getElementById(valueId) : null;

  function setValue(value) {
    const percent = Math.max(0, Math.min(1, value)) * 100;
    fill.style.width = `${percent}%`;
    thumb.style.left = `${percent}%`;
    if (valueLabel) valueLabel.textContent = `${Math.round(percent)}%`;
  }

  setValue(initialValue);

  let dragging = false;

  function updateFromEvent(e) {
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    // 弹窗已移入舞台内，全屏旋转后轨道的包围盒是旋转后的轴对齐框，
    // 必须改用舞台局部坐标 + stageLayoutBox 来换算，否则滑块会反向/错位。
    const rect = stageLayoutBox(track);
    const p = screenToStage(clientX, clientY);
    const x = Math.max(0, Math.min(p.x - rect.x, rect.w));
    const value = x / rect.w;
    const clamped = Math.max(0, Math.min(1, value));
    setValue(clamped);
    onChange(clamped);
  }

  track.addEventListener('mousedown', (e) => {
    dragging = true;
    updateFromEvent(e);
  });

  window.addEventListener('mousemove', (e) => {
    if (dragging) updateFromEvent(e);
  });

  window.addEventListener('mouseup', () => {
    dragging = false;
  });

  track.addEventListener('touchstart', (e) => {
    dragging = true;
    updateFromEvent(e);
  }, { passive: false });

  window.addEventListener('touchmove', (e) => {
    if (dragging) updateFromEvent(e);
  }, { passive: false });

  window.addEventListener('touchend', () => {
    dragging = false;
  });
}

// 亮度滑块
setupSlider('brightness-track', 'brightness-fill', 'brightness-thumb', 'brightness-value', state.brightness, (value) => {
  state.brightness = value;
  const overlay = document.getElementById('brightness-overlay') || createBrightnessOverlay();
  overlay.style.background = `rgba(0, 0, 0, ${1 - value})`;
});

function createBrightnessOverlay() {
  const overlay = document.createElement('div');
  overlay.id = 'brightness-overlay';
  overlay.style.position = 'absolute';
  overlay.style.top = '0';
  overlay.style.left = '0';
  overlay.style.width = '100%';
  overlay.style.height = '100%';
  overlay.style.pointerEvents = 'none';
  overlay.style.zIndex = '5';
  overlay.style.background = 'rgba(0,0,0,0)';
  document.getElementById('video-viewport').appendChild(overlay);
  return overlay;
}

// 音量滑块
setupSlider('volume-track', 'volume-fill', 'volume-thumb', 'volume-value', state.volume, (value) => {
  state.volume = value;
  state.videoElements.forEach(v => {
    v.volume = value;
  });
});

// 窗口大小 / 屏幕方向变化时重新计算位置。
// 必须走瞬时校正，否则视频栈会带着过渡从旧视口高度滑过来，露出相邻视频的画面。
window.addEventListener('resize', () => {
  recalibrateStack();
  armRotationLock(); // 转屏过渡期：屏蔽合成 click 误触弹窗（debounce 覆盖整个过渡）
});

window.addEventListener('orientationchange', () => {
  recalibrateStack();
  armRotationLock(); // 转屏过渡期：屏蔽合成 click 误触弹窗（debounce 覆盖整个过渡）
});

// 初始化：原生环境下自动开始扫描，浏览器中给出提示
function bootstrap() {
  if (VideoSource.native) {
    showToast('正在扫描本机视频...');
    // 等 Capacitor 原生桥准备就绪
    setTimeout(() => {
      if (!document.hidden) runScan();
    }, 700);
  } else {
    showToast('浏览器模式：请打包成 Android App 后再使用');
  }
}

bootstrap();
