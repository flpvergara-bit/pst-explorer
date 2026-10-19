'use strict';
// PST Explorer — main process of the desktop app (Electron).
// The UI and the engine are the same as the web version: server.js runs in a
// utilityProcess (so heavy work does not freeze the window) and the window
// loads http://localhost:<port>/ with a session token.
const {
  app, BrowserWindow, utilityProcess, dialog, ipcMain, Tray, Menu, Notification,
  powerSaveBlocker, shell, session, nativeImage,
} = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const migrate = require('./migrate');
const I = require('../src/i18n');
const { t } = I;

const ROOT = path.join(__dirname, '..');
const ICON = path.join(__dirname, 'icons', process.platform === 'win32' ? 'icon.ico' : 'icon.png');
const TOKEN = crypto.randomBytes(24).toString('hex');

app.setName('PST Explorer');
app.setAppUserModelId('com.flpvergara.pstexplorer');
// For testing: another app data folder and a specific previous library
if (process.env.PSTX_USERDATA) app.setPath('userData', path.resolve(process.env.PSTX_USERDATA));
const LEGACY_HINT = process.env.PSTX_LEGACY ? [path.resolve(process.env.PSTX_LEGACY)] : null;
const DATA = path.join(app.getPath('userData'), 'data');
const LOG_DIR = path.join(app.getPath('userData'), 'logs');
// language of menus and dialogs: the same one the user chose in the UI (settings.json)
I.setLang(I.loadSettings(DATA).lang);

let win = null;
let server = null;
let port = null;
let tray = null;
let status = {};
let quitting = false;
let blocker = null;
let hiddenNotice = false;
let updateReady = false;

// parent window for dialogs, if any (otherwise the dialog opens on its own)
const parentWin = () => (win && !win.isDestroyed() ? [win] : []);
const pstArgs = (argv) => argv.filter((a) => /\.(pst|ost)$/i.test(a) && fs.existsSync(a));
const busy = () => !status.paused && (status.indexing || status.consolidating || status.pending);
const appUrl = () => `http://localhost:${port}/`;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    const files = pstArgs(argv.slice(1));
    if (files.length && server) server.postMessage({ type: 'add', paths: files });
    showWindow();
  });
  app.whenReady().then(start);
}

async function start() {
  Menu.setApplicationMenu(buildMenu());
  fs.mkdirSync(LOG_DIR, { recursive: true });
  try {
    await importLegacyIfNeeded();
  } catch (e) {
    dialog.showErrorBox('PST Explorer', t('app.importFailed', { msg: e.message }));
  }
  createTray();
  startServer();
  setupIpc();
  setupUpdates();
}

// ---------------------------------------------------------------- server

function startServer() {
  const log = fs.createWriteStream(path.join(LOG_DIR, 'server.log'), { flags: 'a' });
  log.write(`\n=== ${new Date().toISOString()} v${app.getVersion()} ===\n`);
  server = utilityProcess.fork(path.join(ROOT, 'server.js'), pstArgs(process.argv.slice(1)), {
    serviceName: 'PST Explorer (motor)',
    stdio: 'pipe',
    env: { ...process.env, PORT: '0', PSTX_DATA: DATA, PSTX_TOKEN: TOKEN },
  });
  server.stdout.pipe(log);
  server.stderr.pipe(log);
  server.on('message', onServerMessage);
  server.on('exit', (code) => {
    server = null;
    if (quitting) return;
    dialog.showErrorBox('PST Explorer', t('app.engineStopped', { code, dir: LOG_DIR }));
    app.exit(1);
  });
}

async function onServerMessage(m) {
  if (!m) return;
  if (m.type === 'ready') {
    port = m.port;
    // the token travels as a cookie: the window, iframes, printing and downloads send it automatically
    await session.defaultSession.cookies.set({ url: `http://localhost:${port}`, name: 'pstx', value: TOKEN, httpOnly: true, sameSite: 'strict' });
    createWindow();
  } else if (m.type === 'status') {
    const wasBusy = busy();
    status = m;
    updateTray();
    if (status.indexing && blocker == null) blocker = powerSaveBlocker.start('prevent-app-suspension');
    if (!status.indexing && blocker != null) { powerSaveBlocker.stop(blocker); blocker = null; }
    if (wasBusy && !busy() && !status.paused) {
      notify(t('app.indexDone'), t('app.indexDoneBody'));
      // if the window was hidden only to keep indexing, it can close now
      if (!win || win.isDestroyed() || !win.isVisible()) quit();
      else if (updateReady) offerUpdate();
    }
  } else if (m.type === 'fatal') {
    dialog.showErrorBox('PST Explorer', t('app.engineFailed', { msg: m.error }));
  } else if (m.type === 'lang') {
    // the user changed the language in the UI: rebuild menus and tray
    I.setLang(m.lang);
    Menu.setApplicationMenu(buildMenu());
    updateTray();
  }
}

// ---------------------------------------------------------------- window

const STATE_FILE = () => path.join(app.getPath('userData'), 'window.json');
// name used by versions up to 1.3.0, read once so the saved window size is kept
const OLD_STATE_FILE = () => path.join(app.getPath('userData'), 'ventana.json');

function createWindow() {
  let st = { width: 1400, height: 880 };
  for (const f of [STATE_FILE(), OLD_STATE_FILE()]) {
    try { st = { ...st, ...JSON.parse(fs.readFileSync(f, 'utf8')) }; break; } catch { /* first run */ }
  }
  win = new BrowserWindow({
    ...st,
    minWidth: 900,
    minHeight: 560,
    show: false,
    title: 'PST Explorer',
    icon: ICON,
    backgroundColor: '#ffffff',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      plugins: true, // built-in PDF viewer
      spellcheck: false,
    },
  });
  if (st.maximized) win.maximize();
  win.on('closed', () => { win = null; });
  win.once('ready-to-show', () => win.show());
  win.loadURL(appUrl());

  const save = () => {
    if (!win || win.isMinimized()) return;
    const b = win.getNormalBounds();
    try { fs.writeFileSync(STATE_FILE(), JSON.stringify({ ...b, maximized: win.isMaximized() })); } catch { /* */ }
  };
  win.on('resized', save);
  win.on('moved', save);
  win.on('maximize', save);
  win.on('unmaximize', save);

  // Closing while indexing keeps the app running in the tray
  win.on('close', (e) => {
    if (quitting) return;
    if (busy()) {
      e.preventDefault();
      win.hide();
      if (!hiddenNotice) {
        hiddenNotice = true;
        notify(t('app.stillWorking'), t('app.stillWorkingBody'));
      }
    } else {
      quit();
    }
  });

  setupWebContents(win.webContents);
}

function setupWebContents(wc) {
  const ours = (url) => url.startsWith(`http://localhost:${port}/`) || url.startsWith(`http://127.0.0.1:${port}/`);
  wc.setWindowOpenHandler(({ url }) => {
    // printing and attachments viewed in the browser: internal windows
    if (ours(url)) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 1000, height: 800, icon: ICON, autoHideMenuBar: true,
          webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, plugins: true },
        },
      };
    }
    // links inside emails: default browser (safe schemes only)
    if (/^(https?|mailto):/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  wc.on('will-navigate', (e, url) => {
    if (!ours(url)) {
      e.preventDefault();
      if (/^(https?|mailto):/i.test(url)) shell.openExternal(url);
    }
  });
  wc.on('did-create-window', (child) => setupWebContents(child.webContents));
}

function showWindow() {
  if (!port) return; // the engine is not ready yet: the window will open by itself
  if (!win || win.isDestroyed()) { createWindow(); return; }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function quit() {
  if (quitting && !server) return;
  quitting = true;
  if (server) {
    server.postMessage({ type: 'shutdown' });
    setTimeout(() => { if (server) server.kill(); app.quit(); }, 1500);
  } else {
    app.quit();
  }
}

app.on('before-quit', () => { quitting = true; });
app.on('window-all-closed', () => { if (quitting || !busy()) quit(); });

// Downloads (ZIP, .eml, attachments, CSV): "Save as" dialog
app.whenReady().then(() => {
  session.defaultSession.on('will-download', (_e, item) => {
    item.setSaveDialogOptions({ title: t('app.save'), defaultPath: path.join(app.getPath('downloads'), item.getFilename()) });
    item.on('updated', () => {
      const total = item.getTotalBytes();
      if (win && total) win.setProgressBar(item.getReceivedBytes() / total);
    });
    item.once('done', (_ev, state) => {
      if (win) win.setProgressBar(-1);
      if (state === 'completed') notify(t('app.downloadDone'), path.basename(item.getSavePath()), () => shell.showItemInFolder(item.getSavePath()));
    });
  });
});

// ---------------------------------------------------------------- tray and notifications

function createTray() {
  tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 }));
  tray.setToolTip('PST Explorer');
  tray.on('click', showWindow);
  updateTray();
}

function updateTray() {
  if (!tray) return;
  let tip = 'PST Explorer';
  if (status.paused && status.pending) tip += ' · ' + t('tray.paused');
  else if (status.job) tip += ' · ' + t(status.job.phase === 'messages' ? 'tray.indexing' : 'tray.attachments', { name: status.job.name.replace(/\.(pst|ost)$/i, ''), pct: status.job.pct });
  else if (status.consolidating) tip += ' · ' + t('tray.consolidating');
  tray.setToolTip(tip);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: t('tray.open'), click: showWindow },
    { type: 'separator' },
    { label: t(status.paused ? 'tray.resume' : 'tray.pause'), enabled: !!(status.pending || status.indexing || status.paused), click: () => server && server.postMessage({ type: 'pause', paused: !status.paused }) },
    { type: 'separator' },
    { label: t('tray.quit'), click: quit },
  ]));
}

function notify(title, body, onClick) {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body, icon: ICON });
  n.on('click', onClick || showWindow);
  n.show();
}

// ---------------------------------------------------------------- IPC (preload)

function setupIpc() {
  ipcMain.handle('pick-files', async () => {
    const r = await dialog.showOpenDialog(...parentWin(), {
      title: t('dlg.addFiles'),
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: t('dlg.outlookFiles'), extensions: ['pst', 'ost'] }, { name: t('dlg.allFiles'), extensions: ['*'] }],
    });
    return r.canceled ? [] : r.filePaths;
  });
  ipcMain.handle('pick-folder', async () => {
    const r = await dialog.showOpenDialog(...parentWin(), { title: t('dlg.pickFolder'), properties: ['openDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle('open-data-folder', () => shell.openPath(DATA));
  ipcMain.handle('delete-old-library', async () => {
    const file = path.join(DATA, 'migration.json');
    let info;
    try { info = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { ok: false }; }
    if (!info.from || info.oldDeleted || !migrate.isLibraryDir(info.from)) return { ok: false, error: t('dlg.oldGone') };
    const r = await dialog.showMessageBox(...parentWin(), {
      type: 'warning',
      buttons: [t('dlg.deleteOld'), t('dlg.cancel')],
      defaultId: 1,
      cancelId: 1,
      title: t('dlg.deleteOldTitle'),
      message: t('dlg.deleteOldMsg'),
      detail: t('dlg.deleteOldDetail', { dir: info.from }),
    });
    if (r.response !== 0) return { ok: false, canceled: true };
    // only what makes up the library is deleted, not the parent folder
    fs.rmSync(path.join(info.from, 'index'), { recursive: true, force: true });
    for (const n of ['library.json', 'library.json.tmp', 'library.db', 'library.db-wal', 'library.db-shm', 'recent.json']) fs.rmSync(path.join(info.from, n), { force: true });
    try { fs.rmdirSync(info.from); } catch { /* other files remain: keep the folder */ }
    info.oldDeleted = true;
    fs.writeFileSync(file, JSON.stringify(info, null, 2));
    return { ok: true };
  });
}

// ---------------------------------------------------------------- migration

async function importLegacyIfNeeded() {
  if (fs.existsSync(path.join(DATA, 'library.json'))) return;
  const candidates = (LEGACY_HINT ? LEGACY_HINT.filter(migrate.isLibraryDir) : migrate.findLegacy([path.join(ROOT, 'data')]))
    .filter((d) => path.resolve(d) !== path.resolve(DATA));
  let src = null;
  if (candidates.length) {
    const s = migrate.summarize(candidates[0]);
    const r = await dialog.showMessageBox({
      type: 'question',
      title: 'PST Explorer',
      buttons: [t('dlg.import'), t('dlg.chooseOther'), t('dlg.startEmpty')],
      defaultId: 0,
      cancelId: 2,
      message: t('dlg.legacyFound'),
      detail: t('dlg.legacyDetail', {
        dir: s.dir, files: t('dlg.files', { n: s.files }), messages: I.fmtNum(s.messages),
        gb: (s.bytes / 1024 ** 3).toLocaleString(I.locale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 }),
      }),
    });
    if (r.response === 0) src = s.dir;
    if (r.response === 1) src = await pickLegacyFolder();
  } else {
    // nothing found: do not bother the user; it can be imported later from the File menu
    return;
  }
  if (src) await runImport(src);
}

async function pickLegacyFolder() {
  const r = await dialog.showOpenDialog({ title: t('dlg.legacyPick'), properties: ['openDirectory'] });
  if (r.canceled) return null;
  const dir = migrate.isLibraryDir(r.filePaths[0]) ? r.filePaths[0] : path.join(r.filePaths[0], 'data');
  if (!migrate.isLibraryDir(dir)) {
    dialog.showErrorBox('PST Explorer', t('dlg.notLibrary'));
    return null;
  }
  return dir;
}

async function runImport(src) {
  // the previous version must not be open (its indexes could be half-written)
  for (;;) {
    let running = false;
    try { running = (await fetch('http://localhost:8765/api/state', { signal: AbortSignal.timeout(1500) })).ok; } catch { /* not responding */ }
    if (!running) break;
    const r = await dialog.showMessageBox({
      type: 'warning', title: 'PST Explorer', buttons: [t('dlg.retry'), t('dlg.cancel')], defaultId: 0, cancelId: 1,
      message: t('dlg.closeOld'),
      detail: t('dlg.closeOldDetail'),
    });
    if (r.response !== 0) return;
  }
  const pw = new BrowserWindow({
    width: 520, height: 210, resizable: false, minimizable: false, maximizable: false, title: 'PST Explorer', icon: ICON,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  pw.setMenu(null);
  await pw.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html><html lang="${I.getLang()}"><body style="font:14px Segoe UI,sans-serif;margin:24px;color:#1f2328">
    <h3 style="margin:0 0 12px">${t('dlg.importing')}</h3>
    <div id="t" style="color:#57606a;margin-bottom:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${t('dlg.preparing')}</div>
    <div style="height:8px;background:#eef1f4;border-radius:4px;overflow:hidden"><div id="b" style="height:100%;width:0;background:#1f6feb"></div></div>
    <script>window.set=(p,t)=>{document.getElementById('b').style.width=p+'%';document.getElementById('t').textContent=t}</script></body></html>`));
  let last = 0;
  try {
    const info = await migrate.copyAndVerify(src, DATA, (p) => {
      const now = Date.now();
      if (now - last < 150) return;
      last = now;
      const pct = p.total ? Math.min(100, (p.done / p.total) * 100) : 0;
      const label = t(p.phase === 'copy' ? 'dlg.copying' : p.phase === 'verify' ? 'dlg.verifying' : 'dlg.checking');
      pw.setProgressBar(pct / 100);
      pw.webContents.executeJavaScript(`set(${pct.toFixed(1)}, ${JSON.stringify(`${label} · ${pct.toFixed(0)} % · ${p.text}`)})`).catch(() => {});
    });
    pw.destroy();
    await dialog.showMessageBox({
      type: 'info', title: 'PST Explorer', buttons: [t('dlg.ok')],
      message: t('dlg.imported'),
      detail: t('dlg.importedDetail', { files: t('dlg.files', { n: info.files }), messages: I.fmtNum(info.messages), dir: src }),
    });
  } catch (e) {
    pw.destroy();
    throw e;
  }
}

// ---------------------------------------------------------------- menu

// language names in their own language (not translated)
const LANG_NAMES = { en: 'English', es: 'Español' };

function buildMenu() {
  const tpl = [
    {
      label: t('menu.file'),
      submenu: [
        { label: t('menu.openData'), click: () => shell.openPath(DATA) },
        { label: t('menu.openLog'), click: () => shell.openPath(LOG_DIR) },
        { type: 'separator' },
        { label: t('menu.quit'), accelerator: 'Alt+F4', click: quit },
      ],
    },
    {
      label: t('menu.view'),
      submenu: [
        { role: 'reload', label: t('menu.reload') },
        { type: 'separator' },
        { role: 'resetZoom', label: t('menu.resetZoom') },
        { role: 'zoomIn', label: t('menu.zoomIn') },
        { role: 'zoomOut', label: t('menu.zoomOut') },
        { type: 'separator' },
        { role: 'togglefullscreen', label: t('menu.fullscreen') },
        { type: 'separator' },
        {
          label: t('menu.language'),
          submenu: I.LANGS.map((l) => ({ label: LANG_NAMES[l], type: 'radio', checked: I.getLang() === l, click: () => changeLanguage(l) })),
        },
        ...(app.isPackaged ? [] : [{ role: 'toggleDevTools', label: t('menu.devtools') }]),
      ],
    },
    {
      label: t('menu.help'),
      submenu: [
        { label: t('menu.updates'), enabled: app.isPackaged, click: () => checkUpdates(true) },
        { label: t('menu.site'), click: () => shell.openExternal('https://github.com/flpvergara-bit/pst-explorer') },
        { type: 'separator' },
        { label: t('menu.about', { v: app.getVersion() }), click: () => dialog.showMessageBox(...parentWin(), { type: 'info', title: 'PST Explorer', message: `PST Explorer ${app.getVersion()}`, detail: t('menu.aboutDetail') }) },
      ],
    },
  ];
  return Menu.buildFromTemplate(tpl);
}

// Language chosen from the menu: the engine saves it (settings.json) and the window reloads
function changeLanguage(lang) {
  I.setLang(lang);
  Menu.setApplicationMenu(buildMenu());
  updateTray();
  if (server) server.postMessage({ type: 'lang', lang });
  else I.saveSettings(DATA, { ...I.loadSettings(DATA), lang });
  if (win && !win.isDestroyed()) setTimeout(() => win.webContents.reload(), 200);
}

// ---------------------------------------------------------------- updates

let updater = null;
function setupUpdates() {
  if (!app.isPackaged) return;
  try {
    ({ autoUpdater: updater } = require('electron-updater'));
  } catch { return; }
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;
  updater.on('update-downloaded', () => {
    updateReady = true;
    if (!busy()) offerUpdate();
  });
  updater.on('error', () => { /* offline or no releases: retried later */ });
  checkUpdates(false);
  setInterval(() => checkUpdates(false), 6 * 3600 * 1000).unref();
}

async function checkUpdates(manual) {
  if (!updater) return;
  try {
    const r = await updater.checkForUpdates();
    if (manual && (!r || !r.updateInfo || r.updateInfo.version === app.getVersion())) {
      dialog.showMessageBox(...parentWin(), { type: 'info', title: 'PST Explorer', message: t('upd.latest') });
    }
  } catch (e) {
    if (manual) dialog.showMessageBox(...parentWin(), { type: 'warning', title: 'PST Explorer', message: t('upd.failed'), detail: e.message });
  }
}

async function offerUpdate() {
  const r = await dialog.showMessageBox(...parentWin(), {
    type: 'info', title: 'PST Explorer', buttons: [t('upd.restart'), t('upd.later')], defaultId: 0, cancelId: 1,
    message: t('upd.ready'),
    detail: t('upd.readyDetail'),
  });
  if (r.response === 0) {
    quitting = true;
    if (server) server.postMessage({ type: 'shutdown' });
    setTimeout(() => updater.quitAndInstall(), 800);
  }
}
