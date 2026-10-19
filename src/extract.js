'use strict';
// Text extraction from attachment content for search.
const { unzipSync, strFromU8 } = require('fflate');
const iconv = require('iconv-lite');
const { htmlToText, decodeEntities } = require('./pstreader');

const MAX_BYTES = 40 * 1024 * 1024; // larger attachments are not read
const MAX_CHARS = 200000;
const MAX_PDF_PAGES = 150;

const EXTRACTABLE = new Set(['pdf', 'docx', 'docm', 'xlsx', 'xlsm', 'pptx', 'txt', 'csv', 'tsv', 'log', 'xml', 'json', 'htm', 'html', 'ics', 'vcf', 'md', 'rtf', 'odt', 'ods']);

let pdfjsPromise = null;
const pdfjs = () => (pdfjsPromise ||= import('pdfjs-dist/legacy/build/pdf.mjs'));

function decodeText(buf) {
  if (buf[0] === 0xff && buf[1] === 0xfe) return iconv.decode(buf, 'utf16le');
  if (buf[0] === 0xfe && buf[1] === 0xff) return iconv.decode(buf, 'utf16be');
  const s = buf.toString('utf8');
  // many replacement characters probably mean Windows-1252
  const bad = (s.match(/�/g) || []).length;
  return bad > 3 && bad > s.length / 1000 ? iconv.decode(buf, 'win1252') : s;
}

const xmlText = (xml) => decodeEntities(xml.replace(/<\/(w:p|a:p|text:p|si|row)>/g, '\n').replace(/<(w:tab|w:br)\/>/g, ' ').replace(/<[^>]+>/g, ' '))
  .replace(/[ \t]+/g, ' ');

function officeText(buf, ext) {
  const files = unzipSync(new Uint8Array(buf), {
    filter: (f) => f.originalSize < 50 * 1024 * 1024 && (
      /^word\/(document|header\d*|footer\d*|footnotes|endnotes|comments)\.xml$/.test(f.name) ||
      /^xl\/(sharedStrings\.xml|worksheets\/sheet\d+\.xml)$/.test(f.name) ||
      /^ppt\/(slides\/slide\d+|notesSlides\/notesSlide\d+)\.xml$/.test(f.name) ||
      f.name === 'content.xml'),
  });
  const out = [];
  for (const [name, data] of Object.entries(files)) {
    let xml = strFromU8(data);
    if (/^xl\/worksheets/.test(name)) {
      // in sheets only numeric values and inline strings matter (the rest is in sharedStrings)
      xml = (xml.match(/<(v|t)[^>]*>[^<]*<\/\1>/g) || []).join(' ');
    }
    out.push(xmlText(xml));
  }
  return out.join('\n');
}

async function pdfText(buf) {
  const lib = await pdfjs();
  const doc = await lib.getDocument({
    data: new Uint8Array(buf), isEvalSupported: false, disableFontFace: true, useSystemFonts: false, verbosity: 0, stopAtErrors: false,
  }).promise;
  const out = [];
  let len = 0;
  try {
    for (let p = 1; p <= Math.min(doc.numPages, MAX_PDF_PAGES) && len < MAX_CHARS; p++) {
      const page = await doc.getPage(p);
      const tc = await page.getTextContent();
      const s = tc.items.map((it) => (it.str || '') + (it.hasEOL ? '\n' : ' ')).join('');
      out.push(s);
      len += s.length;
      page.cleanup();
    }
  } finally {
    await doc.destroy();
  }
  return out.join('\n');
}

async function extractText(buf, ext) {
  if (!buf || !buf.length || buf.length > MAX_BYTES) return '';
  let text = '';
  switch (ext) {
    case 'pdf': text = await pdfText(buf); break;
    case 'docx': case 'docm': case 'xlsx': case 'xlsm': case 'pptx': case 'odt': case 'ods': text = officeText(buf, ext); break;
    case 'htm': case 'html': text = htmlToText(decodeText(buf)); break;
    case 'xml': text = xmlText(decodeText(buf)); break;
    case 'rtf': text = require('./pstreader').rtfToText(buf.toString('latin1')); break;
    default: text = decodeText(buf);
  }
  return text.replace(/\s+/g, ' ').trim().slice(0, MAX_CHARS);
}

module.exports = { extractText, EXTRACTABLE, MAX_BYTES };
