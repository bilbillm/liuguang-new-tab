export const defaults = {
  background: { kind: 'daily' },
  engineId: 'google',
  customEngines: [],
  dockIconSize: 46,
  dockScale: 100,
  settingsWidth: 408,
  shortcuts: [
    { id: 'github', name: 'GitHub', url: 'https://github.com/', glyph: 'github' },
    { id: 'youtube', name: 'YouTube', url: 'https://www.youtube.com/', glyph: 'youtube' },
    { id: 'music', name: '音乐', url: 'https://music.youtube.com/', glyph: 'music' },
    { id: 'photos', name: '相册', url: 'https://photos.google.com/', glyph: 'photos' }
  ]
};

export const engines = [
  { id: 'google', name: 'Google', url: 'https://www.google.com/search?q={query}' },
  { id: 'bing', name: 'Bing', url: 'https://www.bing.com/search?q={query}' },
  { id: 'baidu', name: '百度', url: 'https://www.baidu.com/s?wd={query}' }
];

export function validateTemplate(value) {
  const marker = 'lwqueryplaceholder7';
  if (value.includes(marker) || value.split('{query}').length !== 2) throw new Error('请在地址中填写一个 {query}。');
  const parsed = new URL(value.replace('{query}', marker));
  const hasQuery = Array.from(parsed.searchParams.values()).some(parameter => parameter.includes(marker));
  if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password ||
      parsed.origin.includes(marker) || (!parsed.pathname.includes(marker) && !hasQuery)) {
    throw new Error('请填写 HTTPS 地址，把 {query} 放在路径或查询参数值中。');
  }
  return parsed.href.replace(marker, '{query}');
}

export function validateSite(value) {
  const raw = value.trim();
  const url = new URL(/^[a-z][a-z\d+.-]*:/i.test(raw) ? raw : `https://${raw}`);
  if (!['https:', 'http:'].includes(url.protocol) || !url.hostname || url.username || url.password) throw new Error('请填写有效的 HTTP 或 HTTPS 网址。');
  return url.href;
}

let database;
function openDatabase() {
  database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open('liuguang-media', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('media');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => { database = null; reject(request.error); };
  });
  return database;
}

async function mediaTransaction(mode, action) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('media', mode);
    const request = action(tx.objectStore('media'));
    tx.oncomplete = () => resolve(request.result);
    tx.onabort = () => reject(tx.error ?? request.error);
    tx.onerror = () => reject(tx.error ?? request.error);
  });
}

export const mediaStore = {
  read: id => mediaTransaction('readonly', store => store.get(id)),
  write: (id, file) => mediaTransaction('readwrite', store => store.put(file, id)),
  remove: id => mediaTransaction('readwrite', store => store.delete(id))
};

export function base64Bytes(content) {
  if (Uint8Array.fromBase64) return Uint8Array.fromBase64(content);
  return Uint8Array.from(atob(content), char => char.charCodeAt(0));
}

let port;
let requestId = 0;
const pending = new Map();
export function callHost(action, data = {}) {
  if (!port) {
    port = chrome.runtime.connect({ name: 'wallpaper' });
    port.onMessage.addListener(message => {
      const request = pending.get(message.id);
      if (!request) return;
      clearTimeout(request.timer);
      pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error));
      else request.resolve(message.data);
    });
    port.onDisconnect.addListener(() => {
      const error = chrome.runtime.lastError?.message;
      port = null;
      for (const request of pending.values()) {
        clearTimeout(request.timer);
        request.reject(new Error(error || '本机壁纸连接已断开。'));
      }
      pending.clear();
    });
  }
  return new Promise((resolve, reject) => {
    const id = ++requestId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('本地伴侣响应超时，请重试。'));
    }, 15000);
    pending.set(id, { resolve, reject, timer });
    port.postMessage({ id, action, data });
  });
}
