
// ═════════════════════════════════════════════════════════════
// 收藏夹：多级文件夹，收藏「一轮问答」或「整个对话」，可整夹导出为 Canvas
//
// 存在 <chatFolder>/收藏夹.json：
//   { version, folders: [{ id, name, parentId|null, createdAt, collapsed? }],
//     items:   [{ id, folderId, type: 'qa'|'session', sessionId, nodeId?, msgId?, title, addedAt }] }
// ═════════════════════════════════════════════════════════════

class FavStore {
  constructor(chat) {
    this.chat = chat;
    this.data = null;
    this.timer = null;
  }

  get adapter() {
    return this.chat.app.vault.adapter;
  }

  path() {
    return `${this.chat.store.folder()}/收藏夹.json`;
  }

  async load() {
    if (this.data) return this.data;
    let d = null;
    try {
      if (await this.adapter.exists(this.path())) d = JSON.parse(await this.adapter.read(this.path()));
    } catch (e) {
      console.error('Canvas Mindflow: 读取收藏夹失败', e);
    }
    if (!d || typeof d !== 'object') d = {};
    if (!Array.isArray(d.folders)) d.folders = [];
    if (!Array.isArray(d.items)) d.items = [];
    d.version = 1;
    this.data = d;
    return d;
  }

  save(immediate) {
    clearTimeout(this.timer);
    const write = async () => {
      this.timer = null;
      try {
        await this.chat.store.ensureDir(this.chat.store.folder());
        await this.adapter.write(this.path(), JSON.stringify(this.data, null, 1));
      } catch (e) {
        console.error('Canvas Mindflow: 保存收藏夹失败', e);
      }
    };
    if (immediate) return write();
    this.timer = setTimeout(write, 300);
  }

  async flush() {
    if (this.timer) await this.save(true);
  }

  folder(id) {
    return this.data ? this.data.folders.find((f) => f.id === id) || null : null;
  }

  children(parentId) {
    return this.data.folders.filter((f) => (f.parentId || null) === (parentId || null)).sort((a, b) => a.createdAt - b.createdAt);
  }

  itemsIn(folderId) {
    return this.data.items.filter((i) => i.folderId === folderId).sort((a, b) => a.addedAt - b.addedAt);
  }

  /** 这个收藏夹及其所有子收藏夹的 id */
  subtree(id) {
    const out = [id];
    for (let k = 0; k < out.length; k++) for (const c of this.children(out[k])) out.push(c.id);
    return out;
  }

  /** 收藏夹及子收藏夹里的条目总数 */
  count(id) {
    const ids = new Set(this.subtree(id));
    return this.data.items.filter((i) => ids.has(i.folderId)).length;
  }

  pathName(id) {
    const names = [];
    for (let f = this.folder(id); f; f = this.folder(f.parentId)) names.unshift(f.name);
    return names.join(' / ');
  }

  addFolder(name, parentId) {
    const f = { id: uid(), name: name.trim() || '未命名收藏夹', parentId: parentId || null, createdAt: Date.now() };
    this.data.folders.push(f);
    if (parentId) {
      const p = this.folder(parentId);
      if (p) p.collapsed = false;
    }
    this.save();
    return f;
  }

  renameFolder(id, name) {
    const f = this.folder(id);
    if (!f || !name.trim()) return;
    f.name = name.trim();
    this.save();
  }

  removeFolder(id) {
    const ids = new Set(this.subtree(id));
    this.data.folders = this.data.folders.filter((f) => !ids.has(f.id));
    this.data.items = this.data.items.filter((i) => !ids.has(i.folderId));
    this.save();
  }

  /** 移动收藏夹（不能移到自己或自己的子收藏夹里） */
  moveFolder(id, parentId) {
    if (parentId && this.subtree(id).includes(parentId)) return false;
    const f = this.folder(id);
    if (!f) return false;
    f.parentId = parentId || null;
    this.save();
    return true;
  }

  /** 加入条目；同一收藏夹里重复收藏同一内容时返回已有条目 */
  addItem(folderId, item) {
    const dup = this.data.items.find(
      (i) => i.folderId === folderId && i.type === item.type && i.sessionId === item.sessionId && (i.msgId || null) === (item.msgId || null)
    );
    if (dup) return { item: dup, existed: true };
    const it = Object.assign({ id: uid(), folderId, addedAt: Date.now() }, item);
    this.data.items.push(it);
    this.save();
    return { item: it, existed: false };
  }

  removeItem(id) {
    this.data.items = this.data.items.filter((i) => i.id !== id);
    this.save();
  }

  moveItem(id, folderId) {
    const it = this.data.items.find((i) => i.id === id);
    if (!it) return;
    it.folderId = folderId;
    this.save();
  }

  /** 对话被删除后，移除指向它的收藏 */
  async forgetSession(sessionId) {
    await this.load();
    const n = this.data.items.length;
    this.data.items = this.data.items.filter((i) => i.sessionId !== sessionId);
    if (this.data.items.length !== n) this.save();
  }
}

// ── 小弹窗 ─────────────────────────────────────────────────
function promptText(app, title, placeholder, value) {
  return new Promise((resolve) => {
    const m = new obsidian.Modal(app);
    let result = null;
    m.titleEl.setText(title);
    const input = m.contentEl.createEl('input', { cls: 'cmf-prompt-input', attr: { type: 'text', placeholder: placeholder || '' } });
    input.value = value || '';
    const row = m.contentEl.createDiv({ cls: 'modal-button-container' });
    row.createEl('button', { text: '取消' }).addEventListener('click', () => m.close());
    const ok = row.createEl('button', { text: '确定', cls: 'mod-cta' });
    const done = () => {
      if (!input.value.trim()) return input.focus();
      result = input.value.trim();
      m.close();
    };
    ok.addEventListener('click', done);
    input.addEventListener('keydown', (e) => {
      if (e.isComposing) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        done();
      }
    });
    m.onClose = () => resolve(result);
    m.open();
    setTimeout(() => {
      input.focus();
      input.select();
    }, 30);
  });
}

/** 选择收藏夹（可以在里面新建），返回 folderId 或 null */
function pickFolder(app, fav, opts = {}) {
  return new Promise((resolve) => {
    const m = new obsidian.Modal(app);
    let result = null;
    let selected = opts.selected && fav.folder(opts.selected) ? opts.selected : null;
    m.titleEl.setText(opts.title || '加入收藏夹');
    m.modalEl.addClass('cmf-picker-modal');
    if (opts.subtitle) m.contentEl.createDiv({ cls: 'cmf-picker-sub', text: opts.subtitle });
    const list = m.contentEl.createDiv({ cls: 'cmf-picker-list' });
    const exclude = opts.exclude ? new Set(fav.subtree(opts.exclude)) : new Set();
    const render = () => {
      list.empty();
      if (opts.allowRoot) {
        const r = list.createDiv({ cls: 'cmf-picker-row' + (selected === '' ? ' is-selected' : '') });
        obsidian.setIcon(r.createSpan({ cls: 'cmf-picker-icon' }), 'home');
        r.createSpan({ text: opts.rootLabel || '（顶层）' });
        r.addEventListener('click', () => {
          selected = '';
          render();
        });
      }
      const walk = (parentId, depth) => {
        for (const f of fav.children(parentId)) {
          if (exclude.has(f.id)) continue;
          const r = list.createDiv({ cls: 'cmf-picker-row' + (selected === f.id ? ' is-selected' : '') });
          r.style.paddingLeft = `${8 + depth * 18}px`;
          obsidian.setIcon(r.createSpan({ cls: 'cmf-picker-icon' }), 'folder');
          r.createSpan({ text: f.name });
          r.createSpan({ cls: 'cmf-picker-count', text: String(fav.count(f.id) || '') });
          r.addEventListener('click', () => {
            selected = f.id;
            render();
          });
          r.addEventListener('dblclick', () => {
            selected = f.id;
            finish();
          });
          walk(f.id, depth + 1);
        }
      };
      walk(null, 0);
      if (!list.childElementCount) list.createDiv({ cls: 'cmf-picker-empty', text: '还没有收藏夹，先新建一个' });
      ok.toggleAttribute('disabled', selected === null);
    };
    const row = m.contentEl.createDiv({ cls: 'modal-button-container cmf-picker-buttons' });
    const add = row.createEl('button', { cls: 'cmf-picker-new' });
    obsidian.setIcon(add.createSpan(), 'folder-plus');
    add.createSpan({ text: '新建收藏夹' });
    add.addEventListener('click', async () => {
      const parent = selected || null;
      const name = await promptText(app, parent ? `在「${fav.folder(parent).name}」里新建收藏夹` : '新建收藏夹', '收藏夹名称');
      if (!name) return;
      selected = fav.addFolder(name, parent).id;
      render();
    });
    row.createEl('button', { text: '取消' }).addEventListener('click', () => m.close());
    const ok = row.createEl('button', { text: opts.okText || '加入', cls: 'mod-cta' });
    const finish = () => {
      if (selected === null) return;
      result = selected;
      m.close();
    };
    ok.addEventListener('click', finish);
    m.onClose = () => resolve(result);
    render();
    m.open();
  });
}

/** 选择一个已有对话 */
function pickSession(app, sessions) {
  return new Promise((resolve) => {
    const m = new obsidian.Modal(app);
    let result = null;
    m.titleEl.setText('加入已有对话');
    m.modalEl.addClass('cmf-picker-modal');
    const input = m.contentEl.createEl('input', { cls: 'cmf-prompt-input', attr: { type: 'text', placeholder: '搜索对话标题…' } });
    const list = m.contentEl.createDiv({ cls: 'cmf-picker-list' });
    const render = () => {
      list.empty();
      const q = input.value.trim().toLowerCase();
      const hits = sessions.filter((s) => !q || (s.title || '').toLowerCase().includes(q));
      if (!hits.length) list.createDiv({ cls: 'cmf-picker-empty', text: '没有匹配的对话' });
      for (const s of hits) {
        const r = list.createDiv({ cls: 'cmf-picker-row is-session' });
        obsidian.setIcon(r.createSpan({ cls: 'cmf-picker-icon' }), 'messages-square');
        const t = r.createDiv({ cls: 'cmf-picker-main' });
        t.createDiv({ text: s.title || '未命名对话' });
        t.createDiv({ cls: 'cmf-picker-sub', text: `${fmtTime(s.updatedAt)} · ${Object.keys(s.nodes).length} 个窗口` });
        r.addEventListener('click', () => {
          result = s;
          m.close();
        });
      }
    };
    input.addEventListener('input', render);
    m.onClose = () => resolve(result);
    render();
    m.open();
    setTimeout(() => input.focus(), 30);
  });
}

// ── 收藏夹 → Canvas ─────────────────────────────────────────
/** 估算问答卡片高度（Canvas 卡片内部可滚动，这里只求大致合适） */
function estimateCardHeight(md, width) {
  const perLine = Math.max(10, Math.floor((width - 48) / 15));
  let lines = 0;
  for (const l of String(md).split('\n')) lines += Math.max(1, Math.ceil(l.length / perLine));
  return Math.max(220, Math.min(720, 90 + lines * 22));
}

/** 生成一个收藏夹（含子收藏夹）的 Canvas 数据，坐标以 (0,0) 为左上角 */
async function buildFolderCanvas(chat, fav, folderId) {
  const PAD = 40;
  const GAP = 60;
  const MAX_ROW = 2400;
  const QA_W = 460;

  const shift = (part, dx, dy) => {
    for (const n of part.nodes) {
      n.x += dx;
      n.y += dy;
    }
  };

  const qaCard = async (it) => {
    const s = await chat.store.get(it.sessionId);
    const node = s && s.nodes[it.nodeId];
    const i = node ? node.messages.findIndex((m) => m.id === it.msgId) : -1;
    const link = `obsidian://${URI_ACTION}?session=${encodeURIComponent(it.sessionId)}&node=${encodeURIComponent(it.nodeId)}&msg=${encodeURIComponent(it.msgId)}`;
    let text;
    if (i < 0) {
      text = `### ${it.title || '问答'}\n\n*（这条回答已被删除）*`;
    } else {
      const ans = node.messages[i];
      const q = i > 0 && node.messages[i - 1].role === 'user' ? node.messages[i - 1].content : node.title;
      const parts = [`### [${String(q || it.title).replace(/[[\]\n]/g, ' ').slice(0, 120)}](${link})`];
      if (node.anchor && node.anchor.text) parts.push(`==${truncate(node.anchor.text.replace(/\n+/g, ' '), 60)}==`);
      parts.push(normalizeMath(ans.content || ''));
      text = parts.join('\n\n');
    }
    const h = estimateCardHeight(text, QA_W);
    return { nodes: [{ id: it.id, type: 'text', text, x: 0, y: 0, width: QA_W, height: h, color: '5' }], edges: [], w: QA_W, h };
  };

  const sessionBlock = async (it) => {
    const s = await chat.store.get(it.sessionId);
    if (!s) {
      const text = `### ${it.title || '对话'}\n\n*（这个对话已被删除）*`;
      return { nodes: [{ id: it.id, type: 'text', text, x: 0, y: 0, width: 380, height: 160 }], edges: [], w: 380, h: 160 };
    }
    return chat.layoutSession(s, 0, 0, `${it.id}-`);
  };

  const build = async (fid) => {
    const f = fav.folder(fid);
    const blocks = [];
    for (const it of fav.itemsIn(fid)) blocks.push(it.type === 'qa' ? await qaCard(it) : await sessionBlock(it));
    for (const c of fav.children(fid)) blocks.push(await build(c.id));
    const nodes = [];
    const edges = [];
    let x = PAD;
    let y = PAD;
    let rowH = 0;
    let maxX = PAD + 320;
    for (const b of blocks) {
      if (x > PAD && x + b.w > MAX_ROW) {
        x = PAD;
        y += rowH + GAP;
        rowH = 0;
      }
      shift(b, x, y);
      nodes.push(...b.nodes);
      edges.push(...b.edges);
      x += b.w + GAP;
      rowH = Math.max(rowH, b.h);
      maxX = Math.max(maxX, x - GAP);
    }
    if (!blocks.length) {
      nodes.push({ id: `${fid}-empty`, type: 'text', text: '*（空收藏夹）*', x: PAD, y: PAD, width: 260, height: 60 });
      rowH = 60;
    }
    const w = maxX + PAD;
    const h = y + rowH + PAD;
    // 分组放在最前面，才会画在卡片下面
    nodes.unshift({ id: `grp-${fid}`, type: 'group', label: f ? f.name : '收藏夹', x: 0, y: 0, width: w, height: h });
    return { nodes, edges, w, h };
  };

  const ids = folderId ? [folderId] : fav.children(null).map((f) => f.id);
  const nodes = [];
  const edges = [];
  let y = 0;
  for (const id of ids) {
    const part = await build(id);
    shift(part, 0, y);
    nodes.push(...part.nodes);
    edges.push(...part.edges);
    y += part.h + 120;
  }
  return { nodes, edges };
}

module.exports._fav = { FavStore, buildFolderCanvas, estimateCardHeight };
module.exports._layoutSession = MindflowChat.prototype.layoutSession;
