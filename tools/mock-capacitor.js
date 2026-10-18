// 测试用 preload：在页面脚本执行前注入一个假的 Capacitor 原生桥
// 用于验证手机版 app.js 的运行时行为（插件注册、扫描流程、播放器渲染）
// 在 Electron preload 下能拿到 contextBridge；在无头 Chrome(CDP 注入)下拿不到，直接写 window 即可
let contextBridge = null;
try {
  contextBridge = require('electron').contextBridge;
} catch (e) {
  contextBridge = null;
}

const FAKE_VIDEOS = [
  // Movies 文件夹放 3 个（保持全屏验证套件的 items:3 与竖/横两种比例）
  { id: 1, name: '竖屏短视频.mp4', path: '/sdcard/Movies/a.mp4', uri: 'content://media/external/video/media/1', duration: 95, size: 1024 * 1024 * 12, width: 1080, height: 1920, folder: 'Movies', folderPath: '/sdcard/Movies' },
  { id: 2, name: '横屏电影片段.mkv', path: '/sdcard/Movies/b.mkv', uri: 'content://media/external/video/media/2', duration: 7320, size: 1024 * 1024 * 800, width: 1920, height: 1080, folder: 'Movies', folderPath: '/sdcard/Movies' },
  { id: 3, name: '测试录像.mov', path: '/sdcard/Movies/c.mov', uri: 'content://media/external/video/media/3', duration: 240, size: 1024 * 1024 * 55, width: 1080, height: 1920, folder: 'Movies', folderPath: '/sdcard/Movies' },
  { id: 4, name: '旅行短片.mp4', path: '/sdcard/Download/d.mp4', uri: 'content://media/external/video/media/4', duration: 512, size: 1024 * 1024 * 120, width: 1920, height: 1080, folder: 'Download', folderPath: '/sdcard/Download' },
  { id: 5, name: '教程合集.mp4', path: '/sdcard/Download/e.mp4', uri: 'content://media/external/video/media/5', duration: 1265, size: 1024 * 1024 * 260, width: 1280, height: 720, folder: 'Download', folderPath: '/sdcard/Download' },
  { id: 6, name: 'IMAG0007.mp4', path: '/sdcard/DCIM/Camera/f.mp4', uri: 'content://media/external/video/media/6', duration: 18, size: 1024 * 1024 * 8, width: 1080, height: 1920, folder: 'Camera', folderPath: '/sdcard/DCIM/Camera' }
];

// 1x1 透明 PNG，供 <img> 真正加载，验证缩略图懒加载管线
const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

// 记录原生方向锁定调用，供验证脚本核对"进入/退出全屏"是否真的触发了方向切换
try {
  window.__ORIENTATION_CALLS = [];
} catch (e) { /* ignore */ }

// 事件监听注册表（模拟 Capacitor addListener / notifyListeners）
const __listeners = {};
function __emit(event, data) {
  (__listeners[event] || []).forEach(cb => { try { cb(data); } catch (e) { /* ignore */ } });
}
const __delay = (ms) => new Promise(r => setTimeout(r, ms));

const mockPlugin = {
  async addListener(event, cb) {
    (__listeners[event] = __listeners[event] || []).push(cb);
    return {
      remove: async () => {
        const arr = __listeners[event] || [];
        const i = arr.indexOf(cb);
        if (i >= 0) arr.splice(i, 1);
      }
    };
  },
  async removeAllListeners() {
    for (const k in __listeners) delete __listeners[k];
  },
  async listVideos() {
    return { videos: FAKE_VIDEOS, count: FAKE_VIDEOS.length, permissionDenied: false };
  },
  // 流式扫描：按文件夹逐个推送进度事件（带延时，模拟真实边扫边发现），最后返回完整列表
  async scanVideos() {
    const byFolder = new Map();
    FAKE_VIDEOS.forEach(v => {
      const key = v.folderPath || v.folder;
      if (!byFolder.has(key)) byFolder.set(key, []);
      byFolder.get(key).push(v);
    });
    let i = 0;
    for (const [path, list] of byFolder) {
      const folder = {
        path,
        name: path.split('/').filter(Boolean).pop() || path,
        count: list.length,
        totalDuration: list.reduce((s, v) => s + (v.duration || 0), 0),
        preview: list[0]
      };
      // 每个文件夹（含第一个）都延时下发，模拟真实边扫边发现，便于验证"加载态/渐进显示"
      await __delay(200);
      __emit('videoScanProgress', { type: 'folder', folder });
      i++;
    }
    return { videos: FAKE_VIDEOS, count: FAKE_VIDEOS.length, permissionDenied: false };
  },
  async checkPermission() {
    return { granted: true, permission: 'android.permission.READ_MEDIA_VIDEO' };
  },
  async openSettings() {
    return {};
  },
  async setOrientation(options) {
    try {
      window.__ORIENTATION_CALLS.push(options && options.orientation);
    } catch (e) { /* ignore */ }
    return {};
  },
  async exitApp() {
    try { window.__EXIT_CALLED = (window.__EXIT_CALLED || 0) + 1; } catch (e) { /* ignore */ }
    return {};
  },
  async getThumbnail(options) {
    try {
      window.__THUMB_CALLS = window.__THUMB_CALLS || [];
      window.__THUMB_CALLS.push(options && options.id);
    } catch (e) { /* ignore */ }
    return { uri: TINY_PNG };
  }
};

const registered = {};

const CapacitorMock = {
  getPlatform: () => 'android',
  isNativePlatform: () => true,
  isPluginAvailable: (name) => !!registered[name],
  convertFileSrc: (uri) => {
    if (!uri) return uri;
    if (uri.startsWith('content://')) {
      return 'http://localhost/_capacitor_content_/' + uri.substring('content://'.length);
    }
    if (uri.startsWith('file://')) {
      return 'http://localhost/_capacitor_file_/' + uri.substring('file://'.length);
    }
    return uri;
  },
  registerPlugin: (name) => {
    registered[name] = mockPlugin;
    return mockPlugin;
  },
  Plugins: registered
};

// contextIsolation 关闭时可以直接写 window；开启时用 contextBridge 暴露
try {
  window.Capacitor = CapacitorMock;
} catch (e) {
  /* ignore */
}

if (contextBridge) {
  try {
    contextBridge.exposeInMainWorld('Capacitor', CapacitorMock);
  } catch (e) {
    /* ignore */
  }
}
