const HOST = 'com.lumoren.edge_wallpaper_preview';
const tabs = new Map();
const pending = new Map();
let host;
let requestId = 0;
let idleTimer;
let activeProject;
let newestFrame;
let frameRequest;
let frameNumber = 0;

function requestNative(action, details = {}) {
  if (!host) {
    const connected = chrome.runtime.connectNative(HOST);
    host = connected;
    connected.onMessage.addListener(message => {
      const request = pending.get(message.requestId);
      if (!request) return;
      pending.delete(message.requestId);
      clearTimeout(request.timer);
      if (message.error) request.reject(new Error(message.error));
      else request.resolve(message.data);
    });
    connected.onDisconnect.addListener(() => {
      const error = chrome.runtime.lastError?.message || '';
      if (host !== connected) return;
      host = null;
      activeProject = null;
      newestFrame = null;
      const reason = /not found|not registered|not specified|找不到|未注册/i.test(error)
        ? '本地伴侣未连接。请先运行随扩展提供的安装脚本。'
        : '本地伴侣连接已断开。请确认已完成安装，再点刷新。';
      for (const request of pending.values()) {
        clearTimeout(request.timer);
        request.reject(new Error(reason));
      }
      pending.clear();
    });
  }
  return new Promise((resolve, reject) => {
    const id = ++requestId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('本地伴侣响应超时，请重试。'));
    }, 12000);
    pending.set(id, { resolve, reject, timer });
    try { host.postMessage({ requestId: id, action, ...details }); }
    catch (error) { pending.delete(id); clearTimeout(timer); reject(error); }
  });
}

function checkIdle() {
  clearTimeout(idleTimer);
  if (!host || [...tabs.values()].some(Boolean)) return;
  idleTimer = setTimeout(async () => {
    if (activeProject && host) {
      try { await requestNative('stop'); } catch { /* The host already exited. */ }
      activeProject = null;
      newestFrame = null;
    }
    if (!tabs.size) host?.disconnect();
  }, tabs.size ? 2600 : 100);
}

async function receive(action, data, port) {
  if (action === 'visibility') {
    tabs.set(port, data.visible === true && data.live === true);
    checkIdle();
    return null;
  }
  if (action === 'start') {
    const result = await requestNative(action, data);
    if (activeProject !== data.id) newestFrame = null;
    activeProject = data.id;
    checkIdle();
    return result;
  }
  if (action === 'frame') {
    if (activeProject !== data.id) return { restart: true };
    if (newestFrame?.version > data.after) return newestFrame;
    frameRequest ??= requestNative('frame', { id: data.id }).finally(() => { frameRequest = null; });
    const frame = await frameRequest;
    if (frame.content && frame.content !== newestFrame?.content && activeProject === data.id) {
      newestFrame = { content: frame.content, version: ++frameNumber };
    }
    return newestFrame?.version > data.after ? newestFrame : null;
  }
  if (['catalog', 'thumbnail', 'video-info', 'video-read'].includes(action)) return requestNative(action, data);
  throw new Error('无法识别的壁纸操作。');
}

chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'wallpaper' || port.sender?.id !== chrome.runtime.id || port.sender.url !== chrome.runtime.getURL('newtab.html')) return;
  tabs.set(port, false);
  port.onDisconnect.addListener(() => { tabs.delete(port); checkIdle(); });
  port.onMessage.addListener(async ({ id, action, data = {} }) => {
    let response;
    try { response = { id, data: await receive(action, data, port) }; }
    catch (error) { response = { id, error: error.message }; }
    if (tabs.has(port)) port.postMessage(response);
  });
});
