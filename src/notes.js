
// ═════════════════════════════════════════════════════════════
// 想法笔记：对回答里划线的一段写下当时的想法，按（多级）文件夹分类
//
// 存在 <chatFolder>/想法笔记.json，结构与收藏夹相同：
//   folders: [{ id, name, parentId|null, createdAt, collapsed? }]
//   items:   [{ id, folderId|null, sessionId, nodeId, msgId, anchor: {text, plain?},
//               content, sessionTitle, nodeTitle, addedAt, updatedAt }]
// folderId 为 null 的笔记显示在「未分类」里。
// ═════════════════════════════════════════════════════════════

class NoteStore extends FavStore {
  path() {
    return `${this.chat.store.folder()}/想法笔记.json`;
  }

  note(id) {
    return this.data ? this.data.items.find((n) => n.id === id) || null : null;
  }

  addNote(fields) {
    const now = Date.now();
    const n = Object.assign({ id: uid(), folderId: null, addedAt: now, updatedAt: now }, fields);
    this.data.items.push(n);
    this.save();
    return n;
  }

  updateNote(id, patch) {
    const n = this.note(id);
    if (!n) return null;
    Object.assign(n, patch, { updatedAt: Date.now() });
    this.save();
    return n;
  }

  /** 删除文件夹时笔记不删，移回「未分类」 */
  removeFolder(id) {
    const ids = new Set(this.subtree(id));
    this.data.folders = this.data.folders.filter((f) => !ids.has(f.id));
    for (const n of this.data.items) if (ids.has(n.folderId)) n.folderId = null;
    this.save();
  }

  /** 某条消息上的所有笔记 */
  notesOn(sessionId, nodeId, msgId) {
    if (!this.data) return [];
    return this.data.items.filter((n) => n.sessionId === sessionId && n.nodeId === nodeId && n.msgId === msgId);
  }

  /** 文件夹视图里要显示的笔记（新的在前）。key: 'all' | 'none' | folderId（含子文件夹） */
  list(key) {
    let arr = this.data.items;
    if (key === 'none') arr = arr.filter((n) => !n.folderId || !this.folder(n.folderId));
    else if (key && key !== 'all') {
      const ids = new Set(this.subtree(key));
      arr = arr.filter((n) => ids.has(n.folderId));
    }
    return arr.slice().sort((a, b) => b.addedAt - a.addedAt);
  }

  async forgetSession() {
    /* 对话删掉后笔记仍然保留（只是不能再跳转） */
  }
}

/** 渲染一段 Markdown（公式、加粗等），返回需要在关闭时卸载的 Component */
function renderMdInto(app, el, md) {
  const comp = new obsidian.Component();
  comp.load();
  obsidian.MarkdownRenderer.render(app, normalizeMath(md || ''), el, '', comp);
  return comp;
}

/**
 * 写 / 编辑笔记的弹窗。
 * opts = { note? } 编辑已有笔记；或 { anchor, ctx: {sessionId,nodeId,msgId,sessionTitle,nodeTitle}, folderId? } 新建
 * 返回保存后的笔记，取消返回 null；删除返回 { deleted: true }
 */
function openNoteEditor(app, notes, opts) {
  return new Promise((resolve) => {
    const m = new obsidian.Modal(app);
    m.modalEl.addClass('cmf-note-modal');
    const editing = opts.note || null;
    const anchor = editing ? editing.anchor : opts.anchor;
    let result = null;
    const comps = [];
    m.titleEl.setText(editing ? '编辑笔记' : '记笔记');

    const quote = m.contentEl.createDiv({ cls: 'cmf-note-quote markdown-rendered' });
    comps.push(renderMdInto(app, quote, anchor.text));
    const src = editing || opts.ctx || {};
    if (src.sessionTitle || src.nodeTitle) {
      const from = m.contentEl.createDiv({ cls: 'cmf-note-from' });
      from.setText(`来自：${[src.sessionTitle, src.nodeTitle && src.nodeTitle !== src.sessionTitle ? src.nodeTitle : null].filter(Boolean).join(' › ')}`);
    }

    const ta = m.contentEl.createEl('textarea', {
      cls: 'cmf-note-input',
      attr: { placeholder: '看到这句话时，你在想什么？（支持 Markdown 和 $公式$）', rows: '6' },
    });
    ta.value = editing ? editing.content || '' : '';

    // 预览：输入时实时渲染
    const prevWrap = m.contentEl.createDiv({ cls: 'cmf-note-preview-wrap' });
    const prevLabel = prevWrap.createDiv({ cls: 'cmf-note-label', text: '预览' });
    const prev = prevWrap.createDiv({ cls: 'cmf-note-preview markdown-rendered' });
    let prevComp = null;
    let prevTimer = null;
    const updatePreview = () => {
      if (prevComp) prevComp.unload();
      prev.empty();
      const v = ta.value.trim();
      prevWrap.toggleClass('is-empty', !v);
      prevLabel.toggleClass('is-hidden', !v);
      if (v) prevComp = renderMdInto(app, prev, v);
    };
    ta.addEventListener('input', () => {
      clearTimeout(prevTimer);
      prevTimer = setTimeout(updatePreview, 250);
    });

    // 文件夹
    let folderId = editing ? editing.folderId || null : opts.folderId || null;
    if (folderId && !notes.folder(folderId)) folderId = null;
    const frow = m.contentEl.createDiv({ cls: 'cmf-note-folder-row' });
    frow.createSpan({ cls: 'cmf-note-label', text: '文件夹' });
    const sel = frow.createEl('select', { cls: 'dropdown' });
    const fillSelect = () => {
      sel.empty();
      sel.createEl('option', { text: '未分类', attr: { value: '' } });
      const walk = (pid, depth) => {
        for (const f of notes.children(pid)) {
          sel.createEl('option', { text: `${'　'.repeat(depth)}${f.name}`, attr: { value: f.id } });
          walk(f.id, depth + 1);
        }
      };
      walk(null, 0);
      sel.value = folderId || '';
    };
    sel.addEventListener('change', () => (folderId = sel.value || null));
    const nf = frow.createEl('button', { cls: 'cmf-note-newfolder', attr: { 'aria-label': '新建文件夹（建在当前选中的文件夹里）' } });
    obsidian.setIcon(nf.createSpan(), 'folder-plus');
    nf.createSpan({ text: '新建文件夹' });
    nf.addEventListener('click', async () => {
      const name = await promptText(app, folderId ? `在「${notes.folder(folderId).name}」里新建文件夹` : '新建笔记文件夹', '文件夹名称');
      if (!name) return;
      folderId = notes.addFolder(name, folderId).id;
      fillSelect();
    });
    fillSelect();

    const row = m.contentEl.createDiv({ cls: 'modal-button-container' });
    if (editing) {
      const del = row.createEl('button', { text: '删除笔记', cls: 'mod-warning cmf-note-del' });
      del.addEventListener('click', async () => {
        if (!(await confirmModal(app, '删除笔记', '删除这条笔记？此操作不可撤销。', '删除'))) return;
        notes.data.items = notes.data.items.filter((n) => n.id !== editing.id);
        notes.save();
        result = { deleted: true, id: editing.id };
        m.close();
      });
    }
    row.createEl('button', { text: '取消' }).addEventListener('click', () => m.close());
    const ok = row.createEl('button', { text: '保存', cls: 'mod-cta' });
    const save = () => {
      const content = ta.value.trim();
      if (editing) result = notes.updateNote(editing.id, { content, folderId });
      else {
        const c = opts.ctx;
        result = notes.addNote({
          folderId,
          sessionId: c.sessionId,
          nodeId: c.nodeId,
          msgId: c.msgId,
          sessionTitle: c.sessionTitle,
          nodeTitle: c.nodeTitle,
          anchor: Object.assign({}, anchor),
          content,
        });
      }
      m.close();
    };
    ok.addEventListener('click', save);
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.isComposing) {
        e.preventDefault();
        save();
      }
    });
    m.contentEl.createDiv({ cls: 'cmf-note-hint', text: 'Ctrl/Cmd + Enter 保存' });

    m.onClose = () => {
      for (const c of comps) c.unload();
      if (prevComp) prevComp.unload();
      resolve(result);
    };
    updatePreview();
    m.open();
    setTimeout(() => ta.focus(), 30);
  });
}

module.exports._notes = { NoteStore };
