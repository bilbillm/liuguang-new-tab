import { base64Bytes, callHost, defaults, engines, mediaStore, validateSite, validateTemplate } from './data.js';
import { dailyWallpaper, iconFromFile, readEngineVideo, reconnectWallpaper, showWallpaper, suspendWallpaper, verifyFile } from './wallpaper.js';

const $ = id => document.getElementById(id);
const all = selector => [...document.querySelectorAll(selector)];
const settings = $('settings-dialog');
const settingsTabs = Array.from($('settings-nav').querySelectorAll('[data-pane]'));
const settingsResize = $('settings-resize');
const dock = $('dock');
const dockMenu = $('dock-menu');
const shortcutList = $('shortcut-list');
const engineMenu = $('engine-menu');
const engineHighlight = $('engine-highlight');
const engineOptions = $('engine-options');
const wallpaperPane = $('pane-background');
const wallpaperGrid = $('library');
const clockDate = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' });
const clockWeekday = new Intl.DateTimeFormat('zh-CN', { weekday: 'long' });
const clockTime = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const state = await chrome.storage.local.get(defaults);
const motion = matchMedia('(prefers-reduced-motion: reduce)');
const dockSizing = {
  dockIconSize: { id: 'dock-icon-size', suffix: ' px', css: value => `${value}px` },
  dockScale: { id: 'dock-scale', suffix: '%', css: value => String(value / 100) }
};
const kinds = { scene: '场景', video: '视频', web: '网页' };
const library = { items: [], kind: 'all', loaded: false, loading: false, liveSupported: false };
let busy = false;
let toastTimer;
let editingShortcut;
let editingEngine;
let thumbnails;
let settingsAnimation;
let resizeDrag;
let engineSelection = 0;
let libraryColumns = 0;
let clockTimer;
let dockDrag;
let dockMenuOrigin;
let dockScrollFrame = 0;
let suppressDockClick = false;
let shortcutExit;
const dockEntries = new WeakMap();
const shortcutSlideTiming = { duration: 185, easing: 'cubic-bezier(.22, .7, .28, 1)' };
const libraryMoves = new Map();
const thumbUrls = new Map();

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function updateClock() {
  clearTimeout(clockTimer);
  const now = new Date();
  const localTime = clockTime.format(now);
  const localIsoDate = new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
  $('local-time').textContent = localTime;
  $('local-time').dateTime = localTime;
  $('local-date').textContent = `${clockDate.format(now)} · ${clockWeekday.format(now)}`;
  $('local-date').dateTime = localIsoDate;
  clockTimer = setTimeout(updateClock, 60_000 - now.getTime() % 60_000);
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) updateClock();
});
updateClock();

function icon(name) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  const use = document.createElementNS(ns, 'use');
  svg.setAttribute('aria-hidden', 'true');
  use.setAttribute('href', `#${name}`);
  svg.append(use);
  return svg;
}

function button(label, className, onClick, symbol) {
  const node = element('button', className, symbol ? null : label);
  node.type = 'button';
  node.addEventListener('click', onClick);
  if (symbol) {
    node.title = label;
    node.setAttribute('aria-label', label);
    node.append(icon(symbol));
  }
  return node;
}

function notice(message, error = false) {
  const target = settings.open ? $('sheet-notice') : $('toast');
  target.hidden = !message;
  target.textContent = message;
  target.dataset.level = error ? 'error' : 'info';
  if (target === $('toast')) {
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { target.hidden = true; }, 5000);
  }
}

async function guarded(task) {
  try { await task(); }
  catch (error) { notice(error.message || '无法保存设置，请重试。', true); }
}

function applyChanges(changes) {
  Object.assign(state, changes);
  if ('background' in changes) {
    showWallpaper(state.background, message => notice(message, true));
    renderCurrent();
    updateSelectedWallpaper();
  }
  if ('engineId' in changes || 'customEngines' in changes) renderSearch('customEngines' in changes);
  if ('shortcuts' in changes) renderShortcuts();
  if ('settingsWidth' in changes && !resizeDrag) renderSettingsWidth(state.settingsWidth);
  for (const [key, size] of Object.entries(dockSizing)) {
    if (!(key in changes)) continue;
    const slider = $(size.id);
    slider.value = Number.isFinite(state[key]) ? state[key] : defaults[key];
    renderDockSize(size, slider.valueAsNumber);
  }
}

async function save(changes) {
  await chrome.storage.local.set(changes);
  applyChanges(unsynced(changes));
}

function unsynced(changes) {
  return Object.fromEntries(Object.entries(changes).filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(state[key])));
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  const next = Object.fromEntries(Object.entries(changes).filter(([key]) => key in defaults).map(([key, value]) => [key, value.newValue ?? defaults[key]]));
  applyChanges(unsynced(next));
});

function renderDockSize(size, value) {
  $('dock').style.setProperty(`--${size.id}`, size.css(value));
  $(`${size.id}-value`).value = `${value}${size.suffix}`;
}

for (const [key, size] of Object.entries(dockSizing)) {
  const slider = $(size.id);
  slider.addEventListener('input', () => renderDockSize(size, slider.valueAsNumber));
  slider.addEventListener('change', () => guarded(async () => {
    try { await save({ [key]: slider.valueAsNumber }); }
    catch (error) { applyChanges({ [key]: state[key] }); throw error; }
  }));
}

function searchOptions() { return [...engines, ...state.customEngines]; }
function currentEngine() { return searchOptions().find(engine => engine.id === state.engineId) ?? engines[0]; }

function engineMark(engine) {
  const mark = element('span', 'engine-mark');
  mark.dataset.engine = engine.id;
  if (engine.id === 'google') mark.append(icon('google'));
  else if (engine.id === 'bing') mark.textContent = 'b';
  else if (engine.id === 'baidu') mark.textContent = '度';
  else mark.append(icon('globe'));
  return mark;
}

function setEngineMenu(open) {
  if (engineMenu.inert === !open) return;
  engineSelection++;
  engineMenu.inert = !open;
  $('engine-button').setAttribute('aria-expanded', String(open));
}

async function pickSearchEngine(engine) {
  const selection = ++engineSelection;
  await save({ engineId: engine.id });
  if (selection !== engineSelection) return;
  const movement = engineHighlight.getAnimations()[0];
  if (movement) await movement.finished.catch(() => {});
  if (selection !== engineSelection) return;
  setEngineMenu(false);
  $('query').focus();
}

function renderSearch(rebuild) {
  const selected = currentEngine();
  $('engine-icon').replaceChildren(engineMark(selected));
  $('engine-button').title = `搜索引擎 · ${selected.name}`;
  const options = searchOptions();
  if (rebuild) engineOptions.replaceChildren(...options.map(engine => {
    const entry = button('', null, () => guarded(() => pickSearchEngine(engine)));
    entry.append(engineMark(engine), element('span', 'engine-label', engine.name));
    return entry;
  }));
  const index = options.findIndex(engine => engine.id === selected.id);
  engineHighlight.style.setProperty('--engine-index', index);
  Array.from(engineOptions.children).forEach((entry, i) => entry.setAttribute('aria-pressed', String(i === index)));
  if (!rebuild) {
    $('current-engine').value = selected.id;
    return;
  }
  $('current-engine').replaceChildren(...options.map(engine => new Option(engine.name, engine.id, false, engine.id === selected.id)));
  $('custom-engines').replaceChildren(...state.customEngines.map(engine => {
    const row = element('li');
    row.append(element('span', null, engine.name), button('编辑', 'text-button', () => editEngine(engine)), button('删除', 'text-button', () => guarded(async () => {
      await save({ customEngines: state.customEngines.filter(item => item.id !== engine.id), engineId: state.engineId === engine.id ? 'google' : state.engineId });
      if (editingEngine === engine.id) $('engine-form').hidden = true;
    })));
    return row;
  }));
}

function editEngine(engine) {
  editingEngine = engine?.id;
  $('custom-name').value = engine?.name ?? '';
  $('custom-url').value = engine?.url ?? '';
  $('engine-form').hidden = false;
  $('custom-name').focus();
}

$('engine-button').addEventListener('click', () => {
  const open = engineMenu.inert;
  setEngineMenu(open);
  if (open) engineOptions.querySelector('button[aria-pressed="true"]')?.focus();
});
document.addEventListener('click', event => { if (!$('search-area').contains(event.target)) setEngineMenu(false); });
$('query').addEventListener('focus', () => setEngineMenu(false));
$('search-area').addEventListener('focusout', event => {
  if (!$('search-area').contains(event.relatedTarget)) setEngineMenu(false);
});
$('search-area').addEventListener('keydown', event => {
  if (event.key !== 'Escape' || engineMenu.inert) return;
  event.preventDefault();
  setEngineMenu(false);
  $('engine-button').focus();
});
$('search-form').addEventListener('submit', event => {
  event.preventDefault();
  const query = $('query').value.trim();
  if (query) location.assign(currentEngine().url.replace('{query}', encodeURIComponent(query)));
});
$('current-engine').addEventListener('change', () => guarded(() => save({ engineId: $('current-engine').value })));
$('add-engine').addEventListener('click', () => editEngine());
$('cancel-engine').addEventListener('click', () => { $('engine-form').hidden = true; $('add-engine').focus(); });
$('engine-form').addEventListener('submit', event => {
  event.preventDefault();
  guarded(async () => {
    const name = $('custom-name').value.trim();
    if (!name) throw new Error('请填写搜索引擎名称。');
    let url;
    try { url = validateTemplate($('custom-url').value.trim()); }
    catch (error) { throw new Error(error instanceof TypeError ? '请填写有效的 HTTPS 搜索地址。' : error.message); }
    const entry = { id: editingEngine ?? crypto.randomUUID(), name, url };
    const list = editingEngine ? state.customEngines.map(item => item.id === editingEngine ? entry : item) : [...state.customEngines, entry];
    await save({ customEngines: list });
    $('engine-form').hidden = true;
    $('add-engine').focus();
    notice('搜索引擎已保存。');
  });
});

async function loadSiteIcon(site) {
  const defaultIcon = new URL('/favicon.ico', site).href;
  const picture = element('img', 'site-icon');
  picture.alt = '';
  picture.referrerPolicy = 'no-referrer';
  picture.src = defaultIcon;
  try {
    await picture.decode();
    return picture;
  } catch {
    // Some sites only declare an icon in the homepage.
  }

  const candidates = new Set();
  try {
    const response = await fetch(site.origin, {
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      signal: AbortSignal.timeout(3000)
    });
    if (response.ok && response.headers.get('content-type')?.includes('text/html')) {
      const homepage = element('template');
      homepage.innerHTML = await response.text();
      const baseHref = homepage.content.querySelector('base[href]')?.getAttribute('href');
      let base = response.url;
      if (baseHref && URL.canParse(baseHref, base)) base = new URL(baseHref, base).href;
      const links = homepage.content.querySelectorAll('link[rel~="icon" i][href], link[rel~="apple-touch-icon" i][href]');
      for (const link of links) {
        const href = link.getAttribute('href').trim();
        if (!href || !URL.canParse(href, base)) continue;
        const url = new URL(href, base);
        if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password) candidates.add(url.href);
      }
    }
  } catch {
    // Sites that restrict cross-origin reads still support direct image requests.
  }
  candidates.delete(defaultIcon);
  candidates.add(new URL('/favicon.png', site).href);
  candidates.add(new URL('/apple-touch-icon.png', site).href);
  for (const url of candidates) {
    picture.src = url;
    try {
      await picture.decode();
      return picture;
    } catch {
      // Continue to the next candidate.
    }
  }
  return null;
}

function shortcutTile(item, tag, siteIcons) {
  const tile = element(tag, 'tile');
  if (item.image) {
    const picture = element('img');
    picture.src = item.image;
    picture.alt = '';
    tile.append(picture);
  } else if (item.glyph) {
    tile.dataset.icon = item.glyph;
    tile.append(icon(item.glyph));
  } else {
    tile.textContent = [...item.name][0]?.toUpperCase() ?? '';
    if (!URL.canParse(item.url)) return tile;
    const site = new URL(item.url);
    if (site.protocol !== 'https:' && site.protocol !== 'http:') return tile;
    if (!siteIcons.has(site.origin)) siteIcons.set(site.origin, loadSiteIcon(site));
    siteIcons.get(site.origin).then(picture => {
      if (picture) tile.replaceChildren(picture.cloneNode());
    });
  }
  return tile;
}

function renderShortcuts() {
  stopDockDrag();
  closeDockMenu();
  const links = dockLinks();
  const remainingIds = new Set(state.shortcuts.map(item => item.id));
  const removed = links.filter(link => !remainingIds.has(dockEntries.get(link).id));
  const remaining = links.filter(link => remainingIds.has(dockEntries.get(link).id));
  const onlyRemoval = removed.length && remaining.length === state.shortcuts.length &&
    remaining.every((link, index) => JSON.stringify(dockEntries.get(link)) === JSON.stringify(state.shortcuts[index]));
  if (onlyRemoval && !motion.matches) {
    animateShortcutRemoval(removed);
    return;
  }
  const previousIds = new Set(links.map(link => dockEntries.get(link).id));
  const addedIds = new Set(state.shortcuts.filter(item => !previousIds.has(item.id)).map(item => item.id));
  const adding = dock.lastElementChild && addedIds.size && !motion.matches;
  const previous = adding ? shortcutLayout() : undefined;
  if (previous || shortcutExit) stopShortcutLayoutMotion();
  else dock.getAnimations().find(animation => animation.id === 'dock-width')?.cancel();
  for (const animation of shortcutExit ?? []) animation.cancel();
  shortcutExit = undefined;
  paintShortcuts();
  if (previous) animateShortcutLayout(previous, addedIds);
}

function paintShortcuts() {
  const siteIcons = new Map();
  const links = dockLinks();
  if (!dock.lastElementChild || links.length !== state.shortcuts.length ||
      links.some((link, index) => link.inert || JSON.stringify(dockEntries.get(link)) !== JSON.stringify(state.shortcuts[index]))) {
    const items = state.shortcuts.map(item => {
      const link = shortcutTile(item, 'a', siteIcons);
      link.href = item.url;
      link.target = '_blank';
      link.rel = 'noopener';
      link.draggable = false;
      link.title = item.name;
      link.setAttribute('aria-label', item.name);
      dockEntries.set(link, item);
      return link;
    });
    const add = button('添加网站快捷方式', 'tile', () => openShortcutEditor(), 'plus');
    add.dataset.icon = 'add';
    dock.replaceChildren(...items, add);
  }
  shortcutList.replaceChildren(...state.shortcuts.map((item, index) => {
    const row = element('li');
    row.dataset.shortcutId = item.id;
    const up = button(`上移 ${item.name}`, 'icon-button', () => moveShortcut(item.id, -1), 'arrow-up');
    const down = button(`下移 ${item.name}`, 'icon-button', () => moveShortcut(item.id, 1), 'arrow-down');
    up.disabled = index === 0;
    down.disabled = index === state.shortcuts.length - 1;
    row.append(shortcutTile(item, 'span', siteIcons), element('span', null, item.name), up, down,
      button('编辑', 'text-button', () => editShortcut(item)),
      button(`删除 ${item.name}`, 'icon-button', () => removeShortcut(item.id), 'close'));
    return row;
  }));
}

function shortcutLayout() {
  const showRows = settings.open && !$('pane-shortcuts').inert;
  return {
    bounds: dock.getBoundingClientRect(),
    tiles: new Map(Array.from(dock.children).filter(node => !node.inert).map(node => [
      dockEntries.get(node)?.id, { node, position: node.getBoundingClientRect().left }
    ])),
    rows: new Map((showRows ? Array.from(shortcutList.children) : []).filter(row => !row.inert).map(row => [
      row.dataset.shortcutId, { node: row, position: row.getBoundingClientRect().top }
    ]))
  };
}

function stopShortcutLayoutMotion() {
  dock.getAnimations().find(animation => animation.id === 'dock-width')?.cancel();
  for (const node of [...dock.children, ...shortcutList.children]) {
    for (const animation of node.getAnimations()) {
      if (animation.id === 'shortcut-slide' || animation.id === 'shortcut-enter') animation.cancel();
    }
  }
}

function animateShortcutLayout(previous, added = new Set()) {
  if (motion.matches) return;
  const next = shortcutLayout();
  const { bounds: oldDock } = previous;
  const { bounds: newDock } = next;
  const resize = Math.abs(oldDock.width - newDock.width) >= 1;
  const dockShift = resize ? newDock.left - oldDock.left : 0;
  if (resize) {
    dock.animate([{ width: `${oldDock.width}px` }, { width: `${newDock.width}px` }], { ...shortcutSlideTiming, id: 'dock-width' });
  }
  for (const [id, { node, position }] of next.tiles) {
    const old = previous.tiles.get(id);
    if (old) slideShortcut(node, old.position - position + dockShift);
    if (added.has(id)) enterShortcut(node, '.68');
  }
  for (const [id, { node, position }] of next.rows) {
    const old = previous.rows.get(id);
    if (old) slideShortcut(node, 0, old.position - position);
    if (added.has(id)) enterShortcut(node, '.96');
  }
}

function enterShortcut(node, scale) {
  node.animate([{ opacity: 0, scale }, { opacity: 1, scale: '1' }], {
    id: 'shortcut-enter', delay: 50, duration: 170, easing: 'cubic-bezier(.22, .7, .28, 1)', fill: 'backwards'
  });
}

function animateShortcutRemoval(removed) {
  const ids = new Set(removed.map(link => dockEntries.get(link).id));
  const rows = Array.from(shortcutList.children);
  const outgoing = [...removed, ...rows.filter(row => ids.has(row.dataset.shortcutId))];
  const animations = outgoing.map(node => {
    node.inert = true;
    return node.getAnimations().find(animation => animation.id === 'shortcut-exit') ?? node.animate([
      { opacity: getComputedStyle(node).opacity, scale: '1' },
      { opacity: 0, scale: node.parentElement === dock ? '.66' : '.96' }
    ], { id: 'shortcut-exit', duration: 155, easing: 'cubic-bezier(.32, .15, .55, 1)', fill: 'forwards' });
  });
  shortcutExit = animations;
  Promise.allSettled(animations.map(animation => animation.finished)).then(() => {
    if (shortcutExit !== animations) return;
    shortcutExit = undefined;
    const remainingRows = rows.filter(row => !row.inert);
    const previous = shortcutLayout();
    stopShortcutLayoutMotion();
    for (const node of outgoing) node.remove();
    remainingRows.forEach((row, index) => {
      const [up, down] = row.querySelectorAll('button');
      up.disabled = index === 0;
      down.disabled = index === remainingRows.length - 1;
    });
    animateShortcutLayout(previous);
  });
}

function slideShortcut(node, x, y = 0) {
  if (motion.matches || Math.abs(x) + Math.abs(y) < 1) return;
  node.animate([{ transform: `translate(${x}px, ${y}px)` }, { transform: 'none' }], {
    ...shortcutSlideTiming, id: 'shortcut-slide'
  });
}

function openShortcutEditor(item) {
  openSettings('shortcuts');
  editShortcut(item);
}

function removeShortcut(id) {
  guarded(async () => {
    await save({ shortcuts: state.shortcuts.filter(shortcut => shortcut.id !== id) });
    if (editingShortcut === id) $('shortcut-form').hidden = true;
  });
}

function dockLinks() {
  return Array.from(dock.querySelectorAll(':scope > a.tile'));
}

function closeDockMenu(restoreFocus = false) {
  if (dockMenu.hidden) return;
  dockMenu.hidden = true;
  if (restoreFocus) dockMenuOrigin?.focus({ preventScroll: true });
  dockMenuOrigin = undefined;
}

function showDockMenu(x, y, origin) {
  stopDockDrag();
  closeDockMenu();
  // Commit the hidden state before reopening at a different pointer position.
  if (dockMenu.childElementCount) dockMenu.getBoundingClientRect();
  dockMenuOrigin = origin;
  const item = dockEntries.get(origin);
  const action = (label, symbol, run) => {
    const entry = button(label, null, () => {
      closeDockMenu(true);
      run();
    }, symbol);
    entry.removeAttribute('title');
    entry.append(element('span', null, label));
    entry.setAttribute('role', 'menuitem');
    entry.tabIndex = -1;
    return entry;
  };
  if (item) {
    const remove = action('删除快捷方式', 'trash', () => removeShortcut(item.id));
    remove.dataset.remove = '';
    dockMenu.replaceChildren(
      action('在新标签页打开', 'open-tab', () => origin.click()),
      action('编辑快捷方式', 'edit', () => openShortcutEditor(item)),
      remove
    );
  } else {
    dockMenu.replaceChildren(action('添加快捷方式', 'plus', () => openShortcutEditor()));
  }
  dockMenu.hidden = false;
  const width = dockMenu.offsetWidth;
  const height = dockMenu.offsetHeight;
  const left = Math.max(8, Math.min(innerWidth - width - 8, x - width / 2));
  const top = Math.max(8, Math.min(innerHeight - height - 8, y - height / 2));
  dockMenu.style.left = `${left}px`;
  dockMenu.style.top = `${top}px`;
  dockMenu.style.setProperty('--menu-x', `${Math.max(0, Math.min(width, x - left))}px`);
  dockMenu.style.setProperty('--menu-y', `${Math.max(0, Math.min(height, y - top))}px`);
  dockMenu.firstElementChild.focus({ preventScroll: true });
}

dock.addEventListener('contextmenu', event => {
  event.preventDefault();
  showDockMenu(event.clientX, event.clientY, event.target.closest('.tile') ?? dock.lastElementChild);
});
dock.addEventListener('keydown', event => {
  if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
  event.preventDefault();
  const { left, top, width, height } = event.target.getBoundingClientRect();
  showDockMenu(left + width / 2, top + height / 2, event.target);
});
dockMenu.addEventListener('keydown', event => {
  if (event.key === 'Escape' || event.key === 'Tab') {
    if (event.key === 'Escape') event.preventDefault();
    closeDockMenu(true);
    return;
  }
  const items = Array.from(dockMenu.children);
  const index = items.indexOf(document.activeElement);
  const target = { ArrowDown: (index + 1) % items.length, ArrowUp: (index + items.length - 1) % items.length, Home: 0, End: items.length - 1 }[event.key];
  if (!Number.isInteger(target)) return;
  event.preventDefault();
  items[target].focus();
});

function slideDockNeighbors(dragged, next) {
  const links = dockLinks();
  const current = links.indexOf(dragged);
  if (current === next) return;
  const neighbors = links.slice(Math.min(current, next), Math.max(current, next) + 1).filter(link => link !== dragged);
  const before = motion.matches ? [] : neighbors.map(link => ({ link, left: link.getBoundingClientRect().left }));
  for (const link of neighbors) link.getAnimations().find(animation => animation.id === 'shortcut-slide')?.cancel();
  dock.insertBefore(dragged, next > current ? links[next].nextElementSibling : links[next]);
  for (const { link, left } of before) slideShortcut(link, left - link.getBoundingClientRect().left);
}

function positionDockDrag(clientX) {
  const drag = dockDrag;
  drag.clientX = clientX;
  const rect = dock.getBoundingClientRect();
  const links = dockLinks();
  const tileWidth = drag.link.offsetWidth;
  const step = tileWidth + parseFloat(getComputedStyle(dock).columnGap);
  const center = clientX - rect.left - dock.clientLeft + dock.scrollLeft + drag.centerOffset;
  const index = Math.max(0, Math.min(links.length - 1, Math.round((center - links[0].offsetLeft - tileWidth / 2) / step)));
  slideDockNeighbors(drag.link, index);
  drag.offset = center - drag.link.offsetLeft - tileWidth / 2;
  drag.link.style.setProperty('--drag-x', `${drag.offset}px`);
  const edge = 30;
  const delta = clientX < rect.left + edge ? -8 : clientX > rect.right - edge ? 8 : 0;
  if (!delta) {
    cancelAnimationFrame(dockScrollFrame);
    dockScrollFrame = 0;
  } else if (!dockScrollFrame && dock.scrollWidth > dock.clientWidth) {
    dockScrollFrame = requestAnimationFrame(() => {
      dockScrollFrame = 0;
      const previous = dock.scrollLeft;
      dock.scrollLeft += delta;
      if (dockDrag === drag && previous !== dock.scrollLeft) positionDockDrag(drag.clientX);
    });
  }
}

function stopDockDrag(commit = false) {
  if (!dockDrag) return;
  const drag = dockDrag;
  dockDrag = undefined;
  cancelAnimationFrame(dockScrollFrame);
  dockScrollFrame = 0;
  if (!drag.active) return;
  if (dock.hasPointerCapture(drag.pointerId)) dock.releasePointerCapture(drag.pointerId);
  delete dock.dataset.sorting;
  delete drag.link.dataset.grabbed;
  drag.link.style.removeProperty('--drag-x');
  if (!commit) {
    for (const link of drag.original) {
      link.getAnimations().find(animation => animation.id === 'shortcut-slide')?.cancel();
      dock.insertBefore(link, dock.lastElementChild);
    }
    return;
  }
  if (!motion.matches) drag.link.animate([
    { transform: `translateX(${drag.offset}px) scale(1.07)` }, { transform: 'none' }
  ], { duration: 160, easing: 'ease-out' });
  const ordered = dockLinks().map(link => dockEntries.get(link));
  if (ordered.every((item, index) => item.id === state.shortcuts[index]?.id)) return;
  guarded(async () => {
    try { await save({ shortcuts: ordered }); }
    catch (error) { renderShortcuts(); throw error; }
  });
}

dock.addEventListener('dragstart', event => event.preventDefault());
dock.addEventListener('pointerdown', event => {
  const link = event.target.closest('a.tile');
  if (!link || shortcutExit || event.button !== 0 || !event.isPrimary || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
  stopDockDrag();
  const { left, width } = link.getBoundingClientRect();
  dockDrag = {
    link, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY,
    centerOffset: left + width / 2 - event.clientX, original: dockLinks()
  };
});
document.addEventListener('pointermove', event => {
  if (!dockDrag || event.pointerId !== dockDrag.pointerId) return;
  if (!dockDrag.active) {
    const horizontal = Math.abs(event.clientX - dockDrag.startX);
    if (horizontal < 6 || horizontal < Math.abs(event.clientY - dockDrag.startY)) return;
    dockDrag.active = true;
    suppressDockClick = true;
    dock.setPointerCapture(event.pointerId);
    dock.dataset.sorting = '';
    dockDrag.link.dataset.grabbed = '';
  }
  positionDockDrag(event.clientX);
});
document.addEventListener('pointerup', event => {
  if (event.pointerId === dockDrag?.pointerId) stopDockDrag(true);
});
document.addEventListener('pointercancel', event => {
  if (event.pointerId === dockDrag?.pointerId) stopDockDrag();
});
dock.addEventListener('lostpointercapture', event => {
  if (event.target === dock && event.pointerId === dockDrag?.pointerId) stopDockDrag();
});
document.addEventListener('pointerdown', event => {
  suppressDockClick = false;
  if (!dockMenu.contains(event.target)) closeDockMenu();
}, true);
dock.addEventListener('click', event => {
  if (!suppressDockClick || !event.detail) return;
  event.preventDefault();
  event.stopPropagation();
}, true);
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && dockDrag) stopDockDrag();
});
window.addEventListener('resize', () => {
  closeDockMenu();
  stopDockDrag();
});

function moveShortcut(id, direction) {
  guarded(async () => {
    const shortcuts = [...state.shortcuts];
    const first = shortcuts.findIndex(item => item.id === id);
    const second = first + direction;
    if (first < 0 || second < 0 || second >= shortcuts.length) return;
    [shortcuts[first], shortcuts[second]] = [shortcuts[second], shortcuts[first]];
    await save({ shortcuts });
    const row = $('shortcut-list').children[second];
    const arrows = row.querySelectorAll('button');
    const next = arrows[direction < 0 ? 0 : 1];
    (next.disabled ? arrows[direction < 0 ? 1 : 0] : next).focus();
  });
}

function editShortcut(shortcut) {
  editingShortcut = shortcut?.id;
  $('shortcut-name').value = shortcut?.name ?? '';
  $('shortcut-url').value = shortcut?.url ?? '';
  $('shortcut-icon').value = '';
  $('clear-icon').checked = false;
  $('clear-icon-row').hidden = !shortcut?.image;
  $('shortcut-form').hidden = false;
  $('shortcut-name').focus();
}

$('add-shortcut').addEventListener('click', () => editShortcut());
$('cancel-shortcut').addEventListener('click', () => { $('shortcut-form').hidden = true; $('add-shortcut').focus(); });
$('shortcut-form').addEventListener('submit', event => {
  event.preventDefault();
  guarded(async () => {
    const name = $('shortcut-name').value.trim();
    if (!name) throw new Error('请填写网站名称。');
    let url;
    try { url = validateSite($('shortcut-url').value); }
    catch { throw new Error('请填写有效的 HTTP 或 HTTPS 网址。'); }
    const original = state.shortcuts.find(item => item.id === editingShortcut);
    const item = { id: original?.id ?? crypto.randomUUID(), name, url };
    const file = $('shortcut-icon').files[0];
    if (file) item.image = await iconFromFile(file);
    else if (original?.image && !$('clear-icon').checked) item.image = original.image;
    if (original?.glyph && new URL(original.url).origin === new URL(url).origin) item.glyph = original.glyph;
    const shortcuts = original ? state.shortcuts.map(shortcut => shortcut.id === item.id ? item : shortcut) : [...state.shortcuts, item];
    await save({ shortcuts });
    $('shortcut-form').hidden = true;
    $('add-shortcut').focus();
    notice('快捷方式已保存。');
  });
});

async function setBackground(background) {
  const previous = state.background.mediaId;
  await save({ background });
  if (previous && previous !== background.mediaId) {
    const snapshot = await chrome.storage.local.get('background');
    if (snapshot.background?.mediaId !== previous) mediaStore.remove(previous).catch(() => {});
  }
}

async function setMedia(file, kind, title, projectId) {
  await verifyFile(file, kind);
  const mediaId = crypto.randomUUID();
  await mediaStore.write(mediaId, file);
  try { await setBackground({ kind, mediaId, title, projectId }); }
  catch (error) { await mediaStore.remove(mediaId).catch(() => {}); throw error; }
}

function renderCurrent() {
  const current = state.background;
  $('daily-button').setAttribute('aria-pressed', String(current.kind === 'daily'));
  $('image-button').setAttribute('aria-pressed', String(current.kind === 'image'));
  $('video-button').setAttribute('aria-pressed', String(current.kind === 'video' && !current.projectId));
  const label = element('span', null, current.title || '每日一图');
  label.title = label.textContent;
  $('wallpaper-current').replaceChildren(label);
  if (current.kind === 'video' || current.kind === 'live') {
    const paused = current.paused || (motion.matches && !current.forceMotion);
    $('wallpaper-current').append(button(paused ? '播放' : '暂停', 'text-button', () => guarded(() => save({ background: { ...state.background, paused: !paused, forceMotion: paused } }))));
  }
}

async function backgroundOperation(job) {
  if (busy) return;
  busy = true;
  for (const node of all('.source, .library-card')) node.disabled = true;
  try { await job(); }
  catch (error) { notice(error.name === 'QuotaExceededError' ? '磁盘空间不足，原背景仍可使用。' : error.message, true); }
  finally {
    busy = false;
    for (const node of all('.source, .library-card')) node.disabled = false;
  }
}

$('daily-button').addEventListener('click', () => backgroundOperation(async () => { await setBackground({ kind: 'daily' }); notice(''); }));
for (const kind of ['image', 'video']) {
  const input = $(`${kind}-file`);
  $(`${kind}-button`).addEventListener('click', () => input.click());
  input.addEventListener('change', () => {
    const file = input.files[0];
    input.value = '';
    if (!file) return;
    backgroundOperation(async () => { await setMedia(file, kind, file.name); notice('背景已应用。'); });
  });
}

function selectProject(project) {
  backgroundOperation(async () => {
    if (project.kind === 'video') {
      notice('正在读取本机视频…');
      const file = await readEngineVideo(project.id, progress => notice(`正在读取本机视频 · ${progress}%`));
      await setMedia(file, 'video', project.title, project.id);
    } else {
      if (!library.liveSupported) throw new Error('实时壁纸需要支持窗口捕获的 Windows 11。');
      notice('正在打开 Wallpaper Engine 的播放窗口…');
      suspendWallpaper();
      try {
        await callHost('start', { id: project.id });
        await setBackground({ kind: 'live', projectId: project.id, title: project.title });
      } finally { reconnectWallpaper(); }
    }
    notice('背景已应用。');
  });
}

function updateSelectedWallpaper() {
  for (const node of all('.library-card')) node.setAttribute('aria-pressed', String(node.dataset.project === state.background.projectId));
}

function stopLibraryMoves() {
  for (const animation of libraryMoves.values()) animation.cancel();
  libraryMoves.clear();
}

function moveLibraryCards(previous, viewport) {
  // Read all destinations before applying transforms, so later reads see the same grid.
  const targets = previous.map(({ card }) => card.getBoundingClientRect());
  const nearViewport = box => box.bottom > viewport.top - 120 && box.top < viewport.bottom + 120;
  previous.forEach(({ card, box }, index) => {
    const target = targets[index];
    if (!nearViewport(box) && !nearViewport(target)) return;
    const startTop = Math.max(viewport.top - box.height - 100, Math.min(viewport.bottom + 100, box.top));
    const x = box.left - target.left;
    const y = startTop - target.top;
    if (Math.abs(x) + Math.abs(y) + Math.abs(box.width - target.width) + Math.abs(box.height - target.height) < 1) return;
    const animation = card.animate([
      { transform: `translate(${x}px, ${y}px) scale(${box.width / target.width}, ${box.height / target.height})` },
      { transform: 'none' }
    ], { duration: 260, easing: 'cubic-bezier(.2, .72, .28, 1)' });
    libraryMoves.set(card, animation);
    animation.onfinish = () => libraryMoves.delete(card);
  });
}

new ResizeObserver(([entry]) => {
  const width = entry.contentRect.width;
  if (!width) return;
  const style = getComputedStyle(wallpaperGrid);
  const gap = parseFloat(style.columnGap);
  const minCard = parseFloat(style.getPropertyValue('--library-card-min'));
  const columns = Math.max(1, Math.floor((width + gap) / (minCard + gap)));
  if (columns === libraryColumns) return;
  const visible = libraryColumns && settings.open && !wallpaperPane.inert && !settings.hasAttribute('data-closing');
  const previous = visible ? Array.from(wallpaperGrid.querySelectorAll('.library-card'), card => ({
    card, box: card.getBoundingClientRect()
  })) : [];
  const viewport = wallpaperPane.getBoundingClientRect();
  const anchor = wallpaperPane.scrollTop > 0
    ? previous.find(({ box }) => box.bottom > viewport.top && box.top < viewport.bottom)
    : undefined;
  stopLibraryMoves();
  libraryColumns = columns;
  wallpaperGrid.style.setProperty('--library-columns', columns);
  if (anchor) wallpaperPane.scrollTop += anchor.card.getBoundingClientRect().top - anchor.box.top;
  if (!motion.matches && previous.length) moveLibraryCards(previous, viewport);
}).observe(wallpaperPane);

function renderLibrary() {
  stopLibraryMoves();
  const query = $('library-filter').value.trim().toLocaleLowerCase();
  const filtered = library.items.filter(project => (library.kind === 'all' || library.kind === project.kind) && project.title.toLocaleLowerCase().includes(query));
  thumbnails?.disconnect();
  thumbnails = new IntersectionObserver(entries => {
    for (const { isIntersecting, target } of entries) {
      if (!isIntersecting) continue;
      thumbnails.unobserve(target);
      const id = target.dataset.project;
      callHost('thumbnail', { id }).then(data => {
        if (!data || !target.isConnected) return;
        if (!thumbUrls.has(id)) thumbUrls.set(id, URL.createObjectURL(new Blob([base64Bytes(data.content)], { type: data.mime })));
        showThumbnail(target, thumbUrls.get(id));
      }).catch(() => {});
    }
  }, { root: wallpaperPane, rootMargin: '65px' });
  wallpaperGrid.replaceChildren(...filtered.map(project => {
    const card = button('', 'library-card', () => selectProject(project));
    card.disabled = busy;
    card.dataset.project = project.id;
    card.title = project.title;
    const image = element('div', 'library-thumb');
    image.append(icon(project.kind === 'scene' ? 'image' : project.kind === 'video' ? 'video' : 'globe'));
    const caption = element('div', 'library-caption');
    caption.append(element('span', null, project.title), element('small', null, `${kinds[project.kind]} · ${project.source}`));
    card.append(image, caption);
    if (thumbUrls.has(project.id)) showThumbnail(card, thumbUrls.get(project.id));
    else if (project.thumb) thumbnails.observe(card);
    return card;
  }));
  if (library.items.length && !filtered.length) wallpaperGrid.append(element('p', 'hint', '没有符合条件的壁纸。'));
  updateSelectedWallpaper();
}

function showThumbnail(card, url) {
  const picture = element('img');
  picture.alt = '';
  picture.src = url;
  card.firstElementChild.append(picture);
}

async function refreshLibrary() {
  if (library.loading) return;
  library.loading = true;
  $('refresh-library').disabled = true;
  $('library-status').textContent = '正在检测本机安装…';
  try {
    const result = await callHost('catalog');
    library.items = result.projects;
    library.liveSupported = result.liveSupported;
    library.loaded = true;
    $('library-status').textContent = result.installed
      ? library.items.length ? `已安装 · ${library.items.length} 个本机壁纸` : '已安装 · 本机壁纸库为空'
      : '本机未安装 Wallpaper Engine。';
    if (result.installed && !result.liveSupported && library.items.length) $('library-status').textContent += '。场景和网页壁纸需要 Windows 11 窗口捕获。';
  } catch (error) {
    library.items = [];
    library.loaded = false;
    $('library-status').textContent = error.message;
  } finally {
    library.loading = false;
    $('refresh-library').disabled = false;
    $('library-tools').hidden = !library.items.length;
    renderLibrary();
  }
}

$('refresh-library').addEventListener('click', () => { refreshLibrary(); if (state.background.kind === 'live') reconnectWallpaper(); });
$('library-filter').addEventListener('input', renderLibrary);
for (const item of all('[data-kind]')) item.addEventListener('click', () => {
  library.kind = item.dataset.kind;
  for (const option of all('[data-kind]')) option.setAttribute('aria-pressed', String(option === item));
  renderLibrary();
});

function setPane(pane, animate = false) {
  const index = settingsTabs.findIndex(tab => tab.dataset.pane === pane);
  settings.toggleAttribute('data-page-motion', animate);
  settings.style.setProperty('--settings-page', index);
  for (const [position, tab] of settingsTabs.entries()) {
    tab.setAttribute('aria-pressed', String(position === index));
    $(`pane-${tab.dataset.pane}`).inert = position !== index;
  }
  notice('');
  if (pane === 'background' && !library.loaded) refreshLibrary();
}

function positionSettingsSeed() {
  const trigger = $('settings-button').getBoundingClientRect();
  const panel = settings.getBoundingClientRect();
  const x = trigger.left + trigger.width / 2 - panel.left;
  const y = trigger.top + trigger.height / 2 - panel.top;
  settings.style.setProperty('--seed-x', `${x}px`);
  settings.style.setProperty('--seed-y', `${y}px`);
}

function settingsWidthLimits() {
  const style = getComputedStyle(settings);
  const available = Math.floor(document.documentElement.clientWidth - 2 * parseFloat(style.right));
  const min = Math.min(available, parseFloat(style.getPropertyValue('--sheet-min-width')));
  const max = Math.min(available, parseFloat(style.getPropertyValue('--sheet-max-width')));
  return { min, max };
}

function syncSettingsGeometry() {
  if (!settings.open) return;
  positionSettingsSeed();
  const { min, max } = settingsWidthLimits();
  settingsResize.hidden = max <= min;
  settingsResize.setAttribute('aria-valuemin', min);
  settingsResize.setAttribute('aria-valuemax', max);
  settingsResize.setAttribute('aria-valuenow', Math.floor(settings.getBoundingClientRect().width));
}

function renderSettingsWidth(width) {
  settings.style.setProperty('--sheet-width', `${Number.isFinite(width) ? width : defaults.settingsWidth}px`);
  syncSettingsGeometry();
}

function previewSettingsWidth(width) {
  const { min, max } = settingsWidthLimits();
  const next = Math.max(min, Math.min(max, Math.round(width)));
  renderSettingsWidth(next);
  return next;
}

function saveSettingsWidth(width) {
  guarded(async () => {
    try { await save({ settingsWidth: width }); }
    catch (error) {
      if (!resizeDrag) renderSettingsWidth(state.settingsWidth);
      throw error;
    }
  });
}

function stopSettingsResize(commit = false) {
  if (!resizeDrag) return;
  const drag = resizeDrag;
  resizeDrag = undefined;
  delete settings.dataset.resizing;
  if (settingsResize.hasPointerCapture(drag.pointerId)) settingsResize.releasePointerCapture(drag.pointerId);
  if (commit && drag.width != null && drag.width !== drag.initialWidth) saveSettingsWidth(drag.width);
  else renderSettingsWidth(state.settingsWidth);
}

settingsResize.addEventListener('pointerdown', event => {
  if (event.button !== 0 || resizeDrag || settingsAnimation?.playState === 'running') return;
  const { left, width } = settings.getBoundingClientRect();
  resizeDrag = { pointerId: event.pointerId, offset: event.clientX - left, initialWidth: Math.round(width) };
  settingsResize.setPointerCapture(event.pointerId);
  settings.dataset.resizing = '';
  event.preventDefault();
});
settingsResize.addEventListener('pointermove', event => {
  if (event.pointerId !== resizeDrag?.pointerId) return;
  const { right } = settings.getBoundingClientRect();
  resizeDrag.width = previewSettingsWidth(right - event.clientX + resizeDrag.offset);
});
settingsResize.addEventListener('pointerup', event => {
  if (event.pointerId === resizeDrag?.pointerId) stopSettingsResize(true);
});
for (const type of ['pointercancel', 'lostpointercapture']) {
  settingsResize.addEventListener(type, event => {
    if (event.pointerId === resizeDrag?.pointerId) stopSettingsResize();
  });
}
settingsResize.addEventListener('keydown', event => {
  const widths = { Home: () => settingsWidthLimits().min, End: () => settingsWidthLimits().max };
  const steps = { ArrowLeft: 1, ArrowRight: -1 };
  const step = steps[event.key];
  if (step == null && !Object.hasOwn(widths, event.key)) return;
  event.preventDefault();
  if (resizeDrag || settings.hasAttribute('data-closing')) return;
  const current = Math.round(settings.getBoundingClientRect().width);
  const next = step ? current + step * (event.shiftKey ? 40 : 10) : widths[event.key]();
  const width = previewSettingsWidth(next);
  if (width !== current) saveSettingsWidth(width);
  else renderSettingsWidth(state.settingsWidth);
});
window.addEventListener('resize', () => {
  stopSettingsResize();
  syncSettingsGeometry();
});

function openSettings(pane = 'background') {
  setEngineMenu(false);
  closeDockMenu();
  if (!settings.open) {
    settings.showModal();
    syncSettingsGeometry();
    if (!motion.matches) {
      settingsAnimation = settings.animate(
        [{ '--sheet-reveal': '0' }, { '--sheet-reveal': '1' }],
        { duration: 320, easing: 'cubic-bezier(.26, .1, .24, 1)', fill: 'both' }
      );
    }
  }
  setPane(pane);
}

function finishSettingsClose() {
  settings.close();
  settingsAnimation?.cancel();
  settingsAnimation = undefined;
  delete settings.dataset.closing;
  delete settings.dataset.pageMotion;
}

function closeSettings() {
  if (!settings.open || settings.hasAttribute('data-closing')) return;
  stopSettingsResize();
  if (!settingsAnimation || motion.matches || !settingsAnimation.currentTime) {
    finishSettingsClose();
    return;
  }
  settings.dataset.closing = '';
  positionSettingsSeed();
  settingsAnimation.reverse();
  settingsAnimation.finished.then(finishSettingsClose, () => {});
}

$('settings-button').addEventListener('click', () => openSettings());
settings.querySelector('[data-close]').addEventListener('click', closeSettings);
settings.addEventListener('click', event => { if (event.target === settings) closeSettings(); });
settings.addEventListener('cancel', event => { event.preventDefault(); closeSettings(); });
for (const tab of settingsTabs) tab.addEventListener('click', () => setPane(tab.dataset.pane, true));
motion.addEventListener('change', () => {
  if (motion.matches) {
    stopLibraryMoves();
    if (shortcutExit) renderShortcuts();
    stopShortcutLayoutMotion();
    if (settings.hasAttribute('data-closing')) finishSettingsClose();
    else {
      settingsAnimation?.cancel();
      settingsAnimation = undefined;
    }
  }
  renderCurrent();
});

dailyWallpaper();
applyChanges(state);
