'use strict';
// PST Explorer — proceso principal de la app de escritorio (Electron).
// La interfaz y el motor son los mismos de la versión web: server.js corre en un
// utilityProcess (para que el trabajo pesado no congele la ventana) y la ventana
// carga http://localhost:<puerto>/ con un token de sesión.
const {
  app, BrowserWindow, utilityProcess, dialog, ipcMain, Tray, Menu, Notification,
  powerSaveBlocker, shell, session, nativeImage,
} = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const migrate = require('./migrate');

const ROOT = path.join(__dirname, '..');
const ICON = path.join(__dirname, 'icons', process.platform === 'win32' ? 'icon.ico' : 'icon.png');
const TOKEN = crypto.randomBytes(24).toString('hex');

app.setName('PST Explorer');
app.setAppUserModelId('com.flpvergara.pstexplorer');
// Para pruebas: otra carpeta de datos de la app y una biblioteca anterior concreta
if (process.env.PSTX_USERDATA) app.setPath('userData', path.resolve(process.env.PSTX_USERDATA));
const LEGACY_HINT = process.env.PSTX_LEGACY ? [path.resolve(process.env.PSTX_LEGACY)] : null;
const DATA = path.join(app.getPath('userData'), 'data');
const LOG_DIR = path.join(app.getPath('userData'), 'logs');

let win = null;
let server = null;
let port = null;
let tray = null;
let status = {};
let quitting = false;
let blocker = null;
let hiddenNotice = false;
let updateReady = false;

// ventana padre de los diálogos, si existe (si no, el diálogo se abre suelto)
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
    dialog.showErrorBox('PST Explorer', `No se pudo importar la biblioteca anterior:\n\n${e.message}\n\nLa app empezará con una biblioteca vacía; la carpeta original no se modificó.`);
  }
  createTray();
  startServer();
  setupIpc();
  setupUpdates();
}

// ---------------------------------------------------------------- servidor

function startServer() {
  const log = fs.createWriteStream(path.join(LOG_DIR, 'servidor.log'), { flags: 'a' });
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
    dialog.showErrorBox('PST Explorer', `El motor de la aplicación se detuvo (código ${code}).\nRevisa el registro en:\n${LOG_DIR}`);
    app.exit(1);
  });
}

async function onServerMessage(m) {
  if (!m) return;
  if (m.type === 'ready') {
    port = m.port;
    // el token viaja como cookie: la ventana, los iframes, la impresión y las descargas lo envían solos
    await session.defaultSession.cookies.set({ url: `http://localhost:${port}`, name: 'pstx', value: TOKEN, httpOnly: true, sameSite: 'strict' });
    createWindow();
  } else if (m.type === 'status') {
    const wasBusy = busy();
    status = m;
    updateTray();
    if (status.indexing && blocker == null) blocker = powerSaveBlocker.start('prevent-app-suspension');
    if (!status.indexing && blocker != null) { powerSaveBlocker.stop(blocker); blocker = null; }
    if (wasBusy && !busy() && !status.paused) {
      notify('Indexado terminado', 'Todos los archivos de la biblioteca están listos para buscar.');
      // si la ventana estaba oculta solo para seguir indexando, ya se puede cerrar
      if (!win || win.isDestroyed() || !win.isVisible()) quit();
      else if (updateReady) offerUpdate();
    }
  } else if (m.type === 'fatal') {
    dialog.showErrorBox('PST Explorer', `No se pudo iniciar el motor: ${m.error}`);
  }
}

// ---------------------------------------------------------------- ventana

const STATE_FILE = () => path.join(app.getPath('userData'), 'ventana.json');

function createWindow() {
  let st = { width: 1400, height: 880 };
  try { st = { ...st, ...JSON.parse(fs.readFileSync(STATE_FILE(), 'utf8')) }; } catch { /* primera vez */ }
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
      plugins: true, // visor de PDF integrado
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

  // Al cerrar mientras se indexa, seguir en la bandeja
  win.on('close', (e) => {
    if (quitting) return;
    if (busy()) {
      e.preventDefault();
      win.hide();
      if (!hiddenNotice) {
        hiddenNotice = true;
        notify('PST Explorer sigue trabajando', 'El indexado continúa en segundo plano. Ábrelo o ciérralo desde el ícono junto al reloj.');
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
    // impresión y adjuntos en el navegador: ventanas internas
    if (ours(url)) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 1000, height: 800, icon: ICON, autoHideMenuBar: true,
          webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, plugins: true },
        },
      };
    }
    // enlaces de los correos: navegador predeterminado (solo esquemas seguros)
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
  if (!port) return; // el motor aún no está listo: la ventana se abrirá sola
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

// Descargas (ZIP, .eml, adjuntos, CSV): diálogo «Guardar como»
app.whenReady().then(() => {
  session.defaultSession.on('will-download', (_e, item) => {
    item.setSaveDialogOptions({ title: 'Guardar', defaultPath: path.join(app.getPath('downloads'), item.getFilename()) });
    item.on('updated', () => {
      const total = item.getTotalBytes();
      if (win && total) win.setProgressBar(item.getReceivedBytes() / total);
    });
    item.once('done', (_ev, state) => {
      if (win) win.setProgressBar(-1);
      if (state === 'completed') notify('Descarga completa', path.basename(item.getSavePath()), () => shell.showItemInFolder(item.getSavePath()));
    });
  });
});

// ---------------------------------------------------------------- bandeja y notificaciones

function createTray() {
  tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 }));
  tray.setToolTip('PST Explorer');
  tray.on('click', showWindow);
  updateTray();
}

function updateTray() {
  if (!tray) return;
  let tip = 'PST Explorer';
  if (status.paused && status.pending) tip += ' · indexado en pausa';
  else if (status.job) tip += ` · ${status.job.phase === 'messages' ? 'Indexando' : 'Leyendo adjuntos de'} ${status.job.name.replace(/\.(pst|ost)$/i, '')} · ${status.job.pct} %`;
  else if (status.consolidating) tip += ' · detectando correos repetidos';
  tray.setToolTip(tip);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Abrir PST Explorer', click: showWindow },
    { type: 'separator' },
    { label: status.paused ? 'Reanudar indexado' : 'Pausar indexado', enabled: !!(status.pending || status.indexing || status.paused), click: () => server && server.postMessage({ type: 'pause', paused: !status.paused }) },
    { type: 'separator' },
    { label: 'Salir', click: quit },
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
      title: 'Agregar archivos de datos de Outlook',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Archivos de Outlook', extensions: ['pst', 'ost'] }, { name: 'Todos los archivos', extensions: ['*'] }],
    });
    return r.canceled ? [] : r.filePaths;
  });
  ipcMain.handle('pick-folder', async () => {
    const r = await dialog.showOpenDialog(...parentWin(), { title: 'Carpeta que contiene los archivos PST/OST', properties: ['openDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle('open-data-folder', () => shell.openPath(DATA));
  ipcMain.handle('delete-old-library', async () => {
    const file = path.join(DATA, 'migration.json');
    let info;
    try { info = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { ok: false }; }
    if (!info.from || info.oldDeleted || !migrate.isLibraryDir(info.from)) return { ok: false, error: 'La carpeta antigua ya no existe.' };
    const r = await dialog.showMessageBox(...parentWin(), {
      type: 'warning',
      buttons: ['Borrar carpeta antigua', 'Cancelar'],
      defaultId: 1,
      cancelId: 1,
      title: 'Borrar biblioteca antigua',
      message: '¿Borrar la carpeta de la versión anterior?',
      detail: `${info.from}\n\nLa biblioteca ya está copiada y verificada en esta app. Los archivos PST no se tocan; solo se borran los índices antiguos.`,
    });
    if (r.response !== 0) return { ok: false, canceled: true };
    // solo se borra lo que forma la biblioteca, no la carpeta padre
    fs.rmSync(path.join(info.from, 'index'), { recursive: true, force: true });
    for (const n of ['library.json', 'library.json.tmp', 'library.db', 'library.db-wal', 'library.db-shm', 'recent.json']) fs.rmSync(path.join(info.from, n), { force: true });
    try { fs.rmdirSync(info.from); } catch { /* quedan otros archivos: se deja la carpeta */ }
    info.oldDeleted = true;
    fs.writeFileSync(file, JSON.stringify(info, null, 2));
    return { ok: true };
  });
}

// ---------------------------------------------------------------- migración

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
      buttons: ['Importar', 'Elegir otra carpeta…', 'Empezar con una biblioteca vacía'],
      defaultId: 0,
      cancelId: 2,
      message: 'Se encontró una biblioteca de una versión anterior',
      detail: `${s.dir}\n\n${s.files} archivo(s) · ${s.messages.toLocaleString('es-CL')} correos indexados · ${(s.bytes / 1024 ** 3).toFixed(1).replace('.', ',')} GB\n\nSe copiará a esta app y se verificará; la carpeta original no se modifica. Así no hay que volver a indexar.`,
    });
    if (r.response === 0) src = s.dir;
    if (r.response === 1) src = await pickLegacyFolder();
  } else {
    // nada encontrado: no molestar; desde el menú Archivo se puede importar después
    return;
  }
  if (src) await runImport(src);
}

async function pickLegacyFolder() {
  const r = await dialog.showOpenDialog({ title: 'Carpeta «data» de la versión anterior', properties: ['openDirectory'] });
  if (r.canceled) return null;
  const dir = migrate.isLibraryDir(r.filePaths[0]) ? r.filePaths[0] : path.join(r.filePaths[0], 'data');
  if (!migrate.isLibraryDir(dir)) {
    dialog.showErrorBox('PST Explorer', 'Esa carpeta no contiene una biblioteca de PST Explorer (falta library.json o la carpeta index).');
    return null;
  }
  return dir;
}

async function runImport(src) {
  // la versión anterior no debe estar abierta (sus índices podrían estar a medio escribir)
  for (;;) {
    let running = false;
    try { running = (await fetch('http://localhost:8765/api/state', { signal: AbortSignal.timeout(1500) })).ok; } catch { /* no responde */ }
    if (!running) break;
    const r = await dialog.showMessageBox({
      type: 'warning', title: 'PST Explorer', buttons: ['Reintentar', 'Cancelar'], defaultId: 0, cancelId: 1,
      message: 'Cierra primero la versión anterior',
      detail: 'La versión anterior de PST Explorer está abierta (la ventana negra). Ciérrala y pulsa Reintentar.',
    });
    if (r.response !== 0) return;
  }
  const pw = new BrowserWindow({
    width: 520, height: 210, resizable: false, minimizable: false, maximizable: false, title: 'PST Explorer', icon: ICON,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  pw.setMenu(null);
  await pw.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html><html><body style="font:14px Segoe UI,sans-serif;margin:24px;color:#1f2328">
    <h3 style="margin:0 0 12px">Importando la biblioteca anterior…</h3>
    <div id="t" style="color:#57606a;margin-bottom:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">Preparando</div>
    <div style="height:8px;background:#eef1f4;border-radius:4px;overflow:hidden"><div id="b" style="height:100%;width:0;background:#1f6feb"></div></div>
    <script>window.set=(p,t)=>{document.getElementById('b').style.width=p+'%';document.getElementById('t').textContent=t}</script></body></html>`));
  let last = 0;
  try {
    const info = await migrate.copyAndVerify(src, DATA, (p) => {
      const now = Date.now();
      if (now - last < 150) return;
      last = now;
      const pct = p.total ? Math.min(100, (p.done / p.total) * 100) : 0;
      const label = p.phase === 'copy' ? 'Copiando' : p.phase === 'verify' ? 'Verificando la copia' : 'Comprobando índices';
      pw.setProgressBar(pct / 100);
      pw.webContents.executeJavaScript(`set(${pct.toFixed(1)}, ${JSON.stringify(`${label} · ${pct.toFixed(0)} % · ${p.text}`)})`).catch(() => {});
    });
    pw.destroy();
    await dialog.showMessageBox({
      type: 'info', title: 'PST Explorer', buttons: ['Aceptar'],
      message: 'Biblioteca importada y verificada',
      detail: `${info.files} archivo(s) · ${info.messages.toLocaleString('es-CL')} correos. No hace falta volver a indexar.\n\nLa carpeta original sigue intacta en:\n${src}\nCuando compruebes que todo está bien, puedes borrarla desde Biblioteca.`,
    });
  } catch (e) {
    pw.destroy();
    throw e;
  }
}

// ---------------------------------------------------------------- menú

function buildMenu() {
  const t = [
    {
      label: 'Archivo',
      submenu: [
        { label: 'Abrir carpeta de datos', click: () => shell.openPath(DATA) },
        { label: 'Abrir registro de errores', click: () => shell.openPath(LOG_DIR) },
        { type: 'separator' },
        { label: 'Salir', accelerator: 'Alt+F4', click: quit },
      ],
    },
    {
      label: 'Ver',
      submenu: [
        { role: 'reload', label: 'Recargar' },
        { type: 'separator' },
        { role: 'resetZoom', label: 'Tamaño normal' },
        { role: 'zoomIn', label: 'Acercar' },
        { role: 'zoomOut', label: 'Alejar' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'Pantalla completa' },
        ...(app.isPackaged ? [] : [{ role: 'toggleDevTools', label: 'Herramientas de desarrollo' }]),
      ],
    },
    {
      label: 'Ayuda',
      submenu: [
        { label: 'Buscar actualizaciones', enabled: app.isPackaged, click: () => checkUpdates(true) },
        { label: 'Sitio del proyecto', click: () => shell.openExternal('https://github.com/flpvergara-bit/pst-explorer') },
        { type: 'separator' },
        { label: `Acerca de PST Explorer ${app.getVersion()}`, click: () => dialog.showMessageBox(...parentWin(), { type: 'info', title: 'PST Explorer', message: `PST Explorer ${app.getVersion()}`, detail: 'Visor y buscador local de archivos PST/OST.\nLicencia MIT.' }) },
      ],
    },
  ];
  return Menu.buildFromTemplate(t);
}

// ---------------------------------------------------------------- actualizaciones

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
  updater.on('error', () => { /* sin conexión o sin versiones: se reintenta más tarde */ });
  checkUpdates(false);
  setInterval(() => checkUpdates(false), 6 * 3600 * 1000).unref();
}

async function checkUpdates(manual) {
  if (!updater) return;
  try {
    const r = await updater.checkForUpdates();
    if (manual && (!r || !r.updateInfo || r.updateInfo.version === app.getVersion())) {
      dialog.showMessageBox(...parentWin(), { type: 'info', title: 'PST Explorer', message: 'Tienes la versión más reciente.' });
    }
  } catch (e) {
    if (manual) dialog.showMessageBox(...parentWin(), { type: 'warning', title: 'PST Explorer', message: 'No se pudo buscar actualizaciones.', detail: e.message });
  }
}

async function offerUpdate() {
  const r = await dialog.showMessageBox(...parentWin(), {
    type: 'info', title: 'PST Explorer', buttons: ['Reiniciar y actualizar', 'Más tarde'], defaultId: 0, cancelId: 1,
    message: 'Hay una versión nueva de PST Explorer lista para instalar.',
    detail: 'Tus índices y tu biblioteca se conservan. Si eliges «Más tarde», se instalará al cerrar la app.',
  });
  if (r.response === 0) {
    quitting = true;
    if (server) server.postMessage({ type: 'shutdown' });
    setTimeout(() => updater.quitAndInstall(), 800);
  }
}
