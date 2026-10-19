'use strict';
// Textos del motor (server.js, src/*) y de la app de escritorio (electron/*) en
// inglés y español. La interfaz web tiene los suyos en public/i18n.js.
// El idioma elegido se guarda en <datos>/settings.json (ver loadSettings).
const fs = require('fs');
const path = require('path');

const LANGS = ['en', 'es'];
const DEFAULT_LANG = 'en';
const LOCALE = { en: 'en-US', es: 'es-CL' };

const S = {
  en: {
    // errores del motor
    'err.notActive': 'The file is not active in the library',
    'err.badRef': 'Invalid reference',
    'err.msgNotFound': 'Message not found',
    'err.attNotFound': 'Attachment not found',
    'err.attNotMsg': 'The attachment is not a message',
    'err.notMsg': 'The item is not a message',
    'err.noFolder': 'The folder does not exist',
    'err.notFound': 'Not found',
    'err.windowsOnly': 'Only available on Windows',
    'err.dialog': 'Could not open the dialog: {msg}',
    'err.notInLibrary': 'The file is no longer in the library',
    'err.unavailable': 'The file is not available: {path}. If it is on an external drive, connect it (or add it again from its new location).',
    'err.locked': 'The file is locked (is Outlook using it?)',
    'err.indexerCrashed': 'The indexer stopped too many times. The file may be badly damaged.',
    'err.badLang': 'Unknown language',
    'mig.notIdentical': 'the copy is not identical to the original',
    'mig.integrity': 'the index failed the integrity check',
    'mig.count': '{expected} emails were expected and there are {found}',
    // motivos al agregar archivos
    'add.notFound': 'file not found',
    'add.notFile': 'not a file',
    'add.already': 'already in the library',
    'add.notPst': 'not a valid PST/OST file',
    'add.locked': 'the file is locked (is Outlook using it?)',
    // diálogos de Windows (versión web)
    'pick.folderTitle': 'Folder that contains the PST/OST files',
    'pick.filesTitle': 'Add Outlook data files',
    'pick.filter': 'Outlook files',
    'pick.all': 'All files',
    // explorador de carpetas
    'browse.documents': 'Documents',
    'browse.downloads': 'Downloads',
    'browse.desktop': 'Desktop',
    // nombres de archivos exportados
    'file.unnamed': 'unnamed',
    'file.noSubject': '(no subject)',
    'file.mail': 'email',
    'file.attachmentsOf': 'Attachments - {name}',
    'file.attachmentsDated': 'Attachments {date}',
    'file.mailsDated': 'Emails {date}',
    // CSV
    'csv.headers': ['Date', 'From', 'Sender email', 'To', 'CC', 'Subject', 'PST file', 'Folder', 'Attachments (count)', 'Attachments', 'Size (KB)', 'Type', 'ID'],
    // impresión
    'print.from': 'From:',
    'print.date': 'Date:',
    'print.to': 'To:',
    'print.cc': 'CC:',
    'print.bcc': 'BCC:',
    'print.atts': 'Attachments:',
    'print.source': 'Source:',
    'print.onBehalf': 'on behalf of {name}',
    'print.title': { one: 'Email', other: '{n} emails' },
    'print.button': 'Print / Save as PDF',
    'print.remoteBlocked': 'remote images blocked',
    'print.none': 'There are no emails to print.',
    'print.fromIndex': 'Showing the beginning of the text stored in the index.',
    // escritorio: motor, ventana, bandeja
    'app.importFailed': 'Could not import the previous library:\n\n{msg}\n\nThe app will start with an empty library; the original folder was not modified.',
    'app.engineStopped': 'The application engine stopped (code {code}).\nCheck the log in:\n{dir}',
    'app.engineFailed': 'Could not start the engine: {msg}',
    'app.indexDone': 'Indexing finished',
    'app.indexDoneBody': 'All files in the library are ready to search.',
    'app.stillWorking': 'PST Explorer is still working',
    'app.stillWorkingBody': 'Indexing continues in the background. Open or quit it from the icon next to the clock.',
    'app.save': 'Save',
    'app.downloadDone': 'Download complete',
    'tray.paused': 'indexing paused',
    'tray.indexing': 'Indexing {name} · {pct}%',
    'tray.attachments': 'Reading attachments of {name} · {pct}%',
    'tray.consolidating': 'finding duplicate emails',
    'tray.open': 'Open PST Explorer',
    'tray.pause': 'Pause indexing',
    'tray.resume': 'Resume indexing',
    'tray.quit': 'Quit',
    // escritorio: diálogos
    'dlg.addFiles': 'Add Outlook data files',
    'dlg.outlookFiles': 'Outlook files',
    'dlg.allFiles': 'All files',
    'dlg.pickFolder': 'Folder that contains the PST/OST files',
    'dlg.oldGone': 'The old folder no longer exists.',
    'dlg.deleteOld': 'Delete old folder',
    'dlg.cancel': 'Cancel',
    'dlg.deleteOldTitle': 'Delete old library',
    'dlg.deleteOldMsg': 'Delete the folder of the previous version?',
    'dlg.deleteOldDetail': '{dir}\n\nThe library has already been copied and verified in this app. PST files are not touched; only the old indexes are deleted.',
    'dlg.import': 'Import',
    'dlg.chooseOther': 'Choose another folder…',
    'dlg.startEmpty': 'Start with an empty library',
    'dlg.legacyFound': 'A library from a previous version was found',
    'dlg.legacyDetail': '{dir}\n\n{files} · {messages} indexed emails · {gb} GB\n\nIt will be copied to this app and verified; the original folder is not modified. No re-indexing needed.',
    'dlg.files': { one: '{n} file', other: '{n} files' },
    'dlg.legacyPick': '"data" folder of the previous version',
    'dlg.notLibrary': 'That folder does not contain a PST Explorer library (library.json or the index folder is missing).',
    'dlg.retry': 'Retry',
    'dlg.closeOld': 'Close the previous version first',
    'dlg.closeOldDetail': 'The previous version of PST Explorer is open (the black window). Close it and press Retry.',
    'dlg.importing': 'Importing the previous library…',
    'dlg.preparing': 'Preparing',
    'dlg.copying': 'Copying',
    'dlg.verifying': 'Verifying the copy',
    'dlg.checking': 'Checking indexes',
    'dlg.ok': 'OK',
    'dlg.imported': 'Library imported and verified',
    'dlg.importedDetail': '{files} · {messages} emails. No re-indexing needed.\n\nThe original folder is still intact in:\n{dir}\nOnce you have checked that everything is fine, you can delete it from the Library.',
    // escritorio: menú
    'menu.file': 'File',
    'menu.openData': 'Open data folder',
    'menu.openLog': 'Open error log',
    'menu.quit': 'Quit',
    'menu.view': 'View',
    'menu.reload': 'Reload',
    'menu.resetZoom': 'Actual size',
    'menu.zoomIn': 'Zoom in',
    'menu.zoomOut': 'Zoom out',
    'menu.fullscreen': 'Full screen',
    'menu.devtools': 'Developer tools',
    'menu.language': 'Language',
    'menu.help': 'Help',
    'menu.updates': 'Check for updates',
    'menu.site': 'Project website',
    'menu.about': 'About PST Explorer {v}',
    'menu.aboutDetail': 'Local viewer and search for PST/OST files.\nMIT License.',
    // escritorio: actualizaciones
    'upd.latest': 'You have the latest version.',
    'upd.failed': 'Could not check for updates.',
    'upd.restart': 'Restart and update',
    'upd.later': 'Later',
    'upd.ready': 'A new version of PST Explorer is ready to install.',
    'upd.readyDetail': 'Your indexes and your library are kept. If you choose "Later", it will be installed when you close the app.',
  },
  es: {
    'err.notActive': 'El archivo no está activo en la biblioteca',
    'err.badRef': 'Referencia inválida',
    'err.msgNotFound': 'Mensaje no encontrado',
    'err.attNotFound': 'Adjunto no encontrado',
    'err.attNotMsg': 'El adjunto no es un mensaje',
    'err.notMsg': 'El elemento no es un mensaje',
    'err.noFolder': 'La carpeta no existe',
    'err.notFound': 'No existe',
    'err.windowsOnly': 'Solo disponible en Windows',
    'err.dialog': 'No se pudo abrir el diálogo: {msg}',
    'err.notInLibrary': 'El archivo ya no está en la biblioteca',
    'err.unavailable': 'El archivo no está disponible: {path}. Si está en un disco externo, conéctalo (o vuelve a agregarlo desde su nueva ubicación).',
    'err.locked': 'El archivo está bloqueado (¿Outlook lo tiene abierto?)',
    'err.indexerCrashed': 'El indexador se detuvo demasiadas veces. Puede que el archivo esté muy dañado.',
    'err.badLang': 'Idioma desconocido',
    'mig.notIdentical': 'la copia no es idéntica al original',
    'mig.integrity': 'el índice no pasó la comprobación de integridad',
    'mig.count': 'se esperaban {expected} correos y hay {found}',
    'add.notFound': 'no se encontró el archivo',
    'add.notFile': 'no es un archivo',
    'add.already': 'ya está en la biblioteca',
    'add.notPst': 'no es un archivo PST/OST válido',
    'add.locked': 'el archivo está bloqueado (¿Outlook lo tiene abierto?)',
    'pick.folderTitle': 'Carpeta que contiene los archivos PST/OST',
    'pick.filesTitle': 'Agregar archivos de datos de Outlook',
    'pick.filter': 'Archivos de Outlook',
    'pick.all': 'Todos los archivos',
    'browse.documents': 'Documentos',
    'browse.downloads': 'Descargas',
    'browse.desktop': 'Escritorio',
    'file.unnamed': 'sin_nombre',
    'file.noSubject': '(sin asunto)',
    'file.mail': 'correo',
    'file.attachmentsOf': 'Adjuntos - {name}',
    'file.attachmentsDated': 'Adjuntos {date}',
    'file.mailsDated': 'Correos {date}',
    'csv.headers': ['Fecha', 'De', 'Correo remitente', 'Para', 'CC', 'Asunto', 'Archivo PST', 'Carpeta', 'N.º de adjuntos', 'Adjuntos', 'Tamaño (KB)', 'Tipo', 'ID'],
    'print.from': 'De:',
    'print.date': 'Fecha:',
    'print.to': 'Para:',
    'print.cc': 'CC:',
    'print.bcc': 'CCO:',
    'print.atts': 'Adjuntos:',
    'print.source': 'Origen:',
    'print.onBehalf': 'en nombre de {name}',
    'print.title': { one: 'Correo', other: '{n} correos' },
    'print.button': 'Imprimir / Guardar como PDF',
    'print.remoteBlocked': 'imágenes remotas bloqueadas',
    'print.none': 'No hay correos para imprimir.',
    'print.fromIndex': 'Se muestra el inicio del texto guardado en el índice.',
    'app.importFailed': 'No se pudo importar la biblioteca anterior:\n\n{msg}\n\nLa app empezará con una biblioteca vacía; la carpeta original no se modificó.',
    'app.engineStopped': 'El motor de la aplicación se detuvo (código {code}).\nRevisa el registro en:\n{dir}',
    'app.engineFailed': 'No se pudo iniciar el motor: {msg}',
    'app.indexDone': 'Indexado terminado',
    'app.indexDoneBody': 'Todos los archivos de la biblioteca están listos para buscar.',
    'app.stillWorking': 'PST Explorer sigue trabajando',
    'app.stillWorkingBody': 'El indexado continúa en segundo plano. Ábrelo o ciérralo desde el ícono junto al reloj.',
    'app.save': 'Guardar',
    'app.downloadDone': 'Descarga completa',
    'tray.paused': 'indexado en pausa',
    'tray.indexing': 'Indexando {name} · {pct} %',
    'tray.attachments': 'Leyendo adjuntos de {name} · {pct} %',
    'tray.consolidating': 'detectando correos repetidos',
    'tray.open': 'Abrir PST Explorer',
    'tray.pause': 'Pausar indexado',
    'tray.resume': 'Reanudar indexado',
    'tray.quit': 'Salir',
    'dlg.addFiles': 'Agregar archivos de datos de Outlook',
    'dlg.outlookFiles': 'Archivos de Outlook',
    'dlg.allFiles': 'Todos los archivos',
    'dlg.pickFolder': 'Carpeta que contiene los archivos PST/OST',
    'dlg.oldGone': 'La carpeta antigua ya no existe.',
    'dlg.deleteOld': 'Borrar carpeta antigua',
    'dlg.cancel': 'Cancelar',
    'dlg.deleteOldTitle': 'Borrar biblioteca antigua',
    'dlg.deleteOldMsg': '¿Borrar la carpeta de la versión anterior?',
    'dlg.deleteOldDetail': '{dir}\n\nLa biblioteca ya está copiada y verificada en esta app. Los archivos PST no se tocan; solo se borran los índices antiguos.',
    'dlg.import': 'Importar',
    'dlg.chooseOther': 'Elegir otra carpeta…',
    'dlg.startEmpty': 'Empezar con una biblioteca vacía',
    'dlg.legacyFound': 'Se encontró una biblioteca de una versión anterior',
    'dlg.legacyDetail': '{dir}\n\n{files} · {messages} correos indexados · {gb} GB\n\nSe copiará a esta app y se verificará; la carpeta original no se modifica. Así no hay que volver a indexar.',
    'dlg.files': { one: '{n} archivo', other: '{n} archivos' },
    'dlg.legacyPick': 'Carpeta «data» de la versión anterior',
    'dlg.notLibrary': 'Esa carpeta no contiene una biblioteca de PST Explorer (falta library.json o la carpeta index).',
    'dlg.retry': 'Reintentar',
    'dlg.closeOld': 'Cierra primero la versión anterior',
    'dlg.closeOldDetail': 'La versión anterior de PST Explorer está abierta (la ventana negra). Ciérrala y pulsa Reintentar.',
    'dlg.importing': 'Importando la biblioteca anterior…',
    'dlg.preparing': 'Preparando',
    'dlg.copying': 'Copiando',
    'dlg.verifying': 'Verificando la copia',
    'dlg.checking': 'Comprobando índices',
    'dlg.ok': 'Aceptar',
    'dlg.imported': 'Biblioteca importada y verificada',
    'dlg.importedDetail': '{files} · {messages} correos. No hace falta volver a indexar.\n\nLa carpeta original sigue intacta en:\n{dir}\nCuando compruebes que todo está bien, puedes borrarla desde la Biblioteca.',
    'menu.file': 'Archivo',
    'menu.openData': 'Abrir carpeta de datos',
    'menu.openLog': 'Abrir registro de errores',
    'menu.quit': 'Salir',
    'menu.view': 'Ver',
    'menu.reload': 'Recargar',
    'menu.resetZoom': 'Tamaño normal',
    'menu.zoomIn': 'Acercar',
    'menu.zoomOut': 'Alejar',
    'menu.fullscreen': 'Pantalla completa',
    'menu.devtools': 'Herramientas de desarrollo',
    'menu.language': 'Idioma',
    'menu.help': 'Ayuda',
    'menu.updates': 'Buscar actualizaciones',
    'menu.site': 'Sitio del proyecto',
    'menu.about': 'Acerca de PST Explorer {v}',
    'menu.aboutDetail': 'Visor y buscador local de archivos PST/OST.\nLicencia MIT.',
    'upd.latest': 'Tienes la versión más reciente.',
    'upd.failed': 'No se pudo buscar actualizaciones.',
    'upd.restart': 'Reiniciar y actualizar',
    'upd.later': 'Más tarde',
    'upd.ready': 'Hay una versión nueva de PST Explorer lista para instalar.',
    'upd.readyDetail': 'Tus índices y tu biblioteca se conservan. Si eliges «Más tarde», se instalará al cerrar la app.',
  },
};

let current = DEFAULT_LANG;
const norm = (l) => (LANGS.includes(l) ? l : DEFAULT_LANG);
const plural = {};

// t('clave', { n: 3, name: 'x' }) — {var} se reemplaza; si el texto es { one, other } se elige por n
function t(key, vars = {}, lang = current) {
  lang = norm(lang);
  let s = S[lang][key];
  if (s === undefined) s = S[DEFAULT_LANG][key];
  if (s === undefined) return key;
  if (s && typeof s === 'object' && !Array.isArray(s)) {
    plural[lang] = plural[lang] || new Intl.PluralRules(LOCALE[lang]);
    s = s[plural[lang].select(Number(vars.n) || 0)] || s.other;
  }
  if (typeof s !== 'string') return s;
  return s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] === undefined ? m : (k === 'n' ? fmtNum(vars[k], lang) : String(vars[k]))));
}

const fmtNum = (n, lang = current) => Number(n || 0).toLocaleString(LOCALE[norm(lang)]);

// Error con texto traducido y código HTTP
const err = (status, key, vars) => Object.assign(new Error(t(key, vars)), { status });

const setLang = (l) => { current = norm(l); return current; };
const getLang = () => current;
const locale = (lang = current) => LOCALE[norm(lang)];

// Preferencias guardadas junto a la biblioteca (sobreviven a las actualizaciones)
function settingsPath(dataDir) { return path.join(dataDir, 'settings.json'); }
function loadSettings(dataDir) {
  let s = {};
  try { s = JSON.parse(fs.readFileSync(settingsPath(dataDir), 'utf8')) || {}; } catch { /* sin preferencias: valores por defecto */ }
  s.lang = norm(s.lang);
  return s;
}
function saveSettings(dataDir, s) {
  fs.mkdirSync(dataDir, { recursive: true });
  const p = settingsPath(dataDir);
  fs.writeFileSync(p + '.tmp', JSON.stringify(s, null, 2));
  fs.renameSync(p + '.tmp', p);
}

module.exports = { t, err, fmtNum, setLang, getLang, locale, loadSettings, saveSettings, LANGS, DEFAULT_LANG };
