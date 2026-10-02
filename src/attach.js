
// ═════════════════════════════════════════════════════════════
// 附件：对话里加入图片 / 文件让 AI 分析
//
// 附件原件保存在 <chatFolder>/附件/ 里（随库同步，可在 Obsidian 里直接打开），
// 消息里只记引用：msg.attachments = [{ id, kind: 'image'|'file', name, path, mime, size, text?, pages?, truncated? }]
// 图片按 OpenAI 兼容的多模态格式发送（image_url + base64）；文件（PDF / 文本 / 代码）先提取文字再随问题发送。
// ═════════════════════════════════════════════════════════════

const ATT_TEXT_EXT = new Set(
  'txt md markdown csv tsv json jsonl xml yaml yml toml ini cfg conf log html htm css scss less js mjs cjs ts tsx jsx py ipynb java c h cpp hpp cc cs go rs rb php swift kt kts m r sql sh bat ps1 lua dart scala tex bib vue svelte srt vtt'.split(
    ' '
  )
);
const ATT_IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp']);
const ATT_IMAGE_MAX_SIDE = 1600;

function extOf(name) {
  const m = /\.([^.\/\\]+)$/.exec(String(name || ''));
  return m ? m[1].toLowerCase() : '';
}

function mimeOfExt(ext) {
  return (
    { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', pdf: 'application/pdf' }[ext] ||
    'application/octet-stream'
  );
}

function fmtSize(n) {
  if (!n && n !== 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function attKind(file) {
  const ext = extOf(file.name);
  if ((file.type || '').startsWith('image/') || ATT_IMAGE_EXT.has(ext)) return 'image';
  if (ext === 'pdf' || file.type === 'application/pdf') return 'pdf';
  if ((file.type || '').startsWith('text/') || ATT_TEXT_EXT.has(ext)) return 'text';
  return null;
}

/** 逐级创建库里的文件夹（让 Obsidian 立即索引到） */
async function ensureVaultFolder(app, path) {
  let cur = '';
  for (const part of obsidian.normalizePath(path).split('/')) {
    cur = cur ? `${cur}/${part}` : part;
    const f = app.vault.getAbstractFileByPath(cur);
    if (!f) {
      try {
        await app.vault.createFolder(cur);
      } catch (_) {
        /* 已存在 */
      }
    }
  }
}

/** 把附件原件写进库里，返回路径 */
async function saveAttachmentFile(chat, name, data) {
  const dir = `${chat.store.folder()}/附件`;
  await ensureVaultFolder(chat.app, dir);
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const base = String(name || '附件')
    .replace(/[\\/:*?"<>|#^[\]]/g, ' ')
    .trim()
    .slice(-60) || '附件';
  let path = `${dir}/${stamp}-${base}`;
  for (let k = 2; chat.app.vault.getAbstractFileByPath(path); k++) {
    const e = extOf(base);
    path = `${dir}/${stamp}-${e ? base.slice(0, -(e.length + 1)) : base} ${k}${e ? '.' + e : ''}`;
  }
  await chat.app.vault.createBinary(path, data);
  return path;
}

/** 大图缩小到最长边 1600px，减少请求体积（GIF 保持原样） */
async function shrinkImage(file) {
  const ext = extOf(file.name);
  const raw = await file.arrayBuffer();
  if (ext === 'gif' || !window.createImageBitmap) return { data: raw, ext: ext || 'png', mime: file.type || mimeOfExt(ext) };
  try {
    const bmp = await createImageBitmap(new Blob([raw], { type: file.type || mimeOfExt(ext) }));
    const scale = Math.min(1, ATT_IMAGE_MAX_SIDE / Math.max(bmp.width, bmp.height));
    if (scale >= 1 && raw.byteLength < 1.5 * 1024 * 1024 && ext !== 'bmp') {
      bmp.close && bmp.close();
      return { data: raw, ext: ext || 'png', mime: file.type || mimeOfExt(ext) };
    }
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(bmp.width * scale));
    c.height = Math.max(1, Math.round(bmp.height * scale));
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close && bmp.close();
    const keepPng = ext === 'png' && raw.byteLength < 3 * 1024 * 1024;
    const blob = await new Promise((r) => c.toBlob(r, keepPng ? 'image/png' : 'image/jpeg', 0.88));
    if (!blob) throw new Error('toBlob failed');
    return { data: await blob.arrayBuffer(), ext: keepPng ? 'png' : 'jpg', mime: keepPng ? 'image/png' : 'image/jpeg' };
  } catch (_) {
    return { data: raw, ext: ext || 'png', mime: file.type || mimeOfExt(ext) };
  }
}

/** 用 Obsidian 自带的 pdf.js 提取 PDF 文字 */
async function extractPdfText(data) {
  const pdfjs = await obsidian.loadPdfJs();
  const doc = await pdfjs.getDocument({ data: new Uint8Array(data) }).promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    let line = '';
    let lastY = null;
    const out = [];
    for (const it of tc.items) {
      const y = it.transform ? it.transform[5] : null;
      if (lastY !== null && y !== null && Math.abs(y - lastY) > 2) {
        out.push(line);
        line = '';
      }
      line += it.str;
      if (it.hasEOL) {
        out.push(line);
        line = '';
      }
      lastY = y;
    }
    if (line) out.push(line);
    pages.push(`--- 第 ${i} 页 ---\n${out.join('\n').replace(/\n{3,}/g, '\n\n').trim()}`);
  }
  return { text: pages.join('\n\n'), pages: doc.numPages };
}

/**
 * 处理一个用户选的 / 粘贴的 / 拖进来的文件，返回附件对象（失败时抛出带中文说明的错误）
 */
async function processUpload(chat, file) {
  const kind = attKind(file);
  const max = Math.max(2000, parseInt(chat.plugin.settings.attachMaxChars, 10) || 40000);
  const limit = (t) => (t.length > max ? { text: t.slice(0, max) + '\n…（内容太长，后面已截断）', truncated: true } : { text: t });
  if (kind === 'image') {
    if (file.size > 30 * 1024 * 1024) throw new Error('图片太大（超过 30MB）');
    const img = await shrinkImage(file);
    let name = file.name || `图片.${img.ext}`;
    if (!extOf(name) || extOf(name) !== img.ext) name = name.replace(/\.[^.]+$/, '') + '.' + img.ext;
    if (/^image\.(png|jpe?g)$/i.test(name)) name = `粘贴的图片.${img.ext}`;
    const path = await saveAttachmentFile(chat, name, img.data);
    return { id: uid(), kind: 'image', name, path, mime: img.mime, size: img.data.byteLength };
  }
  if (kind === 'pdf') {
    if (file.size > 60 * 1024 * 1024) throw new Error('PDF 太大（超过 60MB）');
    const raw = await file.arrayBuffer();
    const path = await saveAttachmentFile(chat, file.name || '文件.pdf', raw.slice(0));
    let r;
    try {
      r = await extractPdfText(raw);
    } catch (e) {
      throw new Error('PDF 文字提取失败：' + ((e && e.message) || e));
    }
    if (!r.text.replace(/---.*?---/g, '').trim()) throw new Error('这个 PDF 里没有可提取的文字（可能是扫描件，可以截图后作为图片发送）');
    return Object.assign({ id: uid(), kind: 'file', name: file.name, path, mime: 'application/pdf', size: file.size, pages: r.pages }, limit(r.text));
  }
  if (kind === 'text') {
    if (file.size > 20 * 1024 * 1024) throw new Error('文件太大（超过 20MB）');
    const raw = await file.arrayBuffer();
    const path = await saveAttachmentFile(chat, file.name || '文件.txt', raw.slice(0));
    const text = new TextDecoder('utf-8').decode(raw);
    return Object.assign({ id: uid(), kind: 'file', name: file.name, path, mime: file.type || 'text/plain', size: file.size }, limit(text));
  }
  throw new Error(`暂不支持「${file.name}」这种文件（支持图片、PDF、文本 / Markdown / 代码 / CSV 等）`);
}

/** 文件类附件变成随问题发送的文字 */
function attachmentsAsText(atts) {
  let out = '';
  for (const a of atts || []) {
    if (a.kind !== 'file') continue;
    out += `\n\n【附件：${a.name}${a.pages ? `，共 ${a.pages} 页` : ''}】\n${a.text || '（未能读取文字内容）'}`;
  }
  return out;
}

/** 把消息里标记的图片读出来，换成多模态格式 */
async function materializeImages(app, messages) {
  const out = [];
  for (const m of messages) {
    if (!m._images || !m._images.length) {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    const parts = [{ type: 'text', text: m.content }];
    for (const img of m._images) {
      try {
        const data = await app.vault.adapter.readBinary(img.path);
        parts.push({ type: 'image_url', image_url: { url: `data:${img.mime || mimeOfExt(extOf(img.path))};base64,${obsidian.arrayBufferToBase64(data)}` } });
      } catch (_) {
        parts[0].text += `\n（图片「${img.name}」已找不到）`;
      }
    }
    out.push({ role: m.role, content: parts });
  }
  return out;
}

module.exports._attach = { attKind, extOf, attachmentsAsText, materializeImages };
