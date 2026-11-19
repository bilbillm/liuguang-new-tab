import { base64Bytes, callHost, mediaStore } from './data.js';

const wallpaper = document.querySelector('#wallpaper');
const image = document.querySelector('#wallpaper-image');
const video = document.querySelector('#wallpaper-video');
const canvas = document.querySelector('#wallpaper-live');
const context = canvas.getContext('2d', { alpha: false });
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const mediaLimit = 180 * 1024 * 1024;
let current = { kind: 'daily' };
let activeUrl;
let revision = 0;
let timer;
let onError = () => {};

export function dailyWallpaper() {
  const now = new Date();
  const day = Math.floor(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) / 86400000);
  wallpaper.dataset.day = String((day % 5 + 5) % 5);
}

function playing() {
  return !document.hidden && !current.paused && (!reducedMotion.matches || current.forceMotion);
}

async function syncPlayback() {
  clearTimeout(timer);
  const turn = ++revision;
  const live = current.kind === 'live';
  const enabled = Boolean(playing());
  callHost('visibility', { visible: !document.hidden, live: live && enabled }).catch(() => {});
  if (current.kind === 'video') {
    if (enabled && activeUrl) video.play().catch(() => {
      if (turn === revision) onError('视频暂停播放，可在设置中手动恢复。');
    });
    else video.pause();
  }
  if (!live || !enabled) return;
  const id = current.projectId;
  let after = 0;
  async function frames() {
    if (turn !== revision) return;
    try {
      const frame = await callHost('frame', { id, after });
      if (turn !== revision) return;
      if (frame?.restart) await callHost('start', { id });
      else if (frame?.content) {
        const bitmap = await createImageBitmap(new Blob([base64Bytes(frame.content)], { type: 'image/jpeg' }));
        if (turn !== revision) { bitmap.close(); return; }
        if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
          canvas.width = bitmap.width;
          canvas.height = bitmap.height;
        }
        context.drawImage(bitmap, 0, 0);
        bitmap.close();
        canvas.hidden = false;
        after = frame.version;
      }
      if (turn === revision) timer = setTimeout(frames, 82);
    } catch (error) {
      if (turn === revision) { canvas.hidden = true; onError(error.message); }
    }
  }
  frames();
}

export async function showWallpaper(config, reportError) {
  const changed = current.kind !== config.kind || current.mediaId !== config.mediaId || current.projectId !== config.projectId;
  current = config;
  onError = reportError;
  dailyWallpaper();
  if (!changed) { syncPlayback(); return; }
  clearTimeout(timer);
  const turn = ++revision;
  video.pause();
  video.removeAttribute('src');
  video.load();
  image.removeAttribute('src');
  image.hidden = video.hidden = canvas.hidden = true;
  if (activeUrl) URL.revokeObjectURL(activeUrl);
  activeUrl = null;
  try {
    if (config.mediaId) {
      const media = await mediaStore.read(config.mediaId);
      if (current.mediaId !== config.mediaId) return;
      if (!media) throw new Error('找不到本机背景，请重新导入。');
      activeUrl = URL.createObjectURL(media);
      if (config.kind === 'video') { video.src = activeUrl; video.hidden = false; }
      else { image.src = activeUrl; image.hidden = false; }
    }
    if (config === current || turn === revision) syncPlayback();
  } catch (error) { if (turn === revision) onError(error.message); }
}

export function reconnectWallpaper() { syncPlayback(); }

export function suspendWallpaper() {
  clearTimeout(timer);
  revision++;
}

document.addEventListener('visibilitychange', () => { dailyWallpaper(); syncPlayback(); });
reducedMotion.addEventListener('change', syncPlayback);
setInterval(() => { if (!document.hidden) dailyWallpaper(); }, 60000);

export async function verifyFile(file, kind) {
  if (!file.size || file.size > mediaLimit) throw new Error('请选择小于 180 MB 的图片或视频。');
  if (kind === 'image') {
    const bitmap = await createImageBitmap(file).catch(() => { throw new Error('这张图片无法读取，请换一张。'); });
    bitmap.close();
    return;
  }
  const sample = document.createElement('video');
  sample.preload = 'auto';
  sample.muted = true;
  const url = URL.createObjectURL(file);
  try {
    await new Promise((resolve, reject) => {
      const finish = callback => { clearTimeout(timeout); callback(); };
      const invalid = () => reject(new Error('Edge 无法解码这个视频，请尝试 H.264 MP4 或 WebM。'));
      const timeout = setTimeout(invalid, 9000);
      sample.onloadeddata = () => finish(resolve);
      sample.onerror = () => finish(invalid);
      sample.src = url;
    });
  } finally {
    sample.removeAttribute('src');
    sample.load();
    URL.revokeObjectURL(url);
  }
}

export async function readEngineVideo(id, onProgress) {
  const { size, mime } = await callHost('video-info', { id });
  if (size <= 0 || size > mediaLimit) throw new Error('这段视频超过 180 MB，无法导入此预览版。');
  const fragments = [];
  let offset = 0;
  while (offset < size) {
    const { content } = await callHost('video-read', { id, offset });
    const bytes = base64Bytes(content);
    if (!bytes.length) throw new Error('视频读取中断，请重新选择。');
    fragments.push(bytes);
    offset += bytes.length;
    onProgress(Math.min(100, Math.round(offset / size * 100)));
  }
  return new Blob(fragments, { type: mime });
}

export async function iconFromFile(file) {
  if (file.size > 10 * 1024 * 1024) throw new Error('图标图片请小于 10 MB。');
  const bitmap = await createImageBitmap(file).catch(() => { throw new Error('这张图标图片无法读取。'); });
  const output = document.createElement('canvas');
  output.width = output.height = 96;
  const side = Math.min(bitmap.width, bitmap.height);
  output.getContext('2d').drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, 96, 96);
  bitmap.close();
  return output.toDataURL('image/webp', 0.88);
}
