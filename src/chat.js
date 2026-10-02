
// ═════════════════════════════════════════════════════════════
// 对话视图：主窗口 + 右侧追问卡片 / 问答树 + Canvas 总览图
//
// 数据模型（每个会话一个 JSON 文件，放在 <chatFolder>/对话数据/）
//   session = { id, title, createdAt, updatedAt, rootId, nodes: { [id]: node } }
//   node    = { id, parentId, anchor: {text, msgId} | null, title, createdAt,
//               messages: [{ id, role: 'user'|'assistant', content, createdAt, pending? }] }
// 一个 node 就是一个「对话窗口」，可以多轮对话；划线追问 = 新建子 node。
// ═════════════════════════════════════════════════════════════

const CHAT_VIEW = 'canvas-mindflow-chat';
const URI_ACTION = 'canvas-mindflow';

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function fmtTime(ts) {
  const d = new Date(ts);
  const now = new Date();
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (d.toDateString() === now.toDateString()) return `今天 ${hm}`;
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
}

/** 把 \[…\] / \(…\) 公式写法转换成 Obsidian 能渲染的 $$…$$ / $…$ */
function normalizeMath(md) {
  return String(md || '')
    .replace(/\\\[([\s\S]+?)\\\]/g, (m, x) => `$$${x.trim()}$$`)
    .replace(/\\\(([\s\S]+?)\\\)/g, (m, x) => `$${x.trim()}$`);
}

function plainExcerpt(md, n) {
  const lines = String(md || '')
    .replace(/```[\s\S]*?```/g, '')
    .split('\n')
    .filter((l) => !/^\s*\|/.test(l) && !/^\s*\$\$/.test(l));
  const t = lines.join(' ').replace(/[#>*_`]/g, '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

// ── 会话树工具 ─────────────────────────────────────────────
function chainOf(s, nodeId) {
  const out = [];
  let n = s && s.nodes[nodeId];
  const seen = new Set();
  while (n && !seen.has(n.id)) {
    seen.add(n.id);
    out.unshift(n);
    n = n.parentId ? s.nodes[n.parentId] : null;
  }
  return out;
}

function childrenOf(s, id) {
  return Object.values(s.nodes)
    .filter((n) => n.parentId === id)
    .sort((a, b) => a.createdAt - b.createdAt);
}

function subtreeIds(s, id) {
  const out = [id];
  for (const c of childrenOf(s, id)) out.push(...subtreeIds(s, c.id));
  return out;
}

function lastAnswer(node) {
  for (let i = node.messages.length - 1; i >= 0; i--) {
    if (node.messages[i].role === 'assistant') return node.messages[i];
  }
  return null;
}

/** 组装发给 AI 的消息：祖先窗口的对话（远的截断）+ 当前窗口的对话 */
function buildThreadMessages(settings, s, nodeId, uptoMsgId) {
  const chain = chainOf(s, nodeId);
  const msgs = [];
  if (settings.systemPrompt && settings.systemPrompt.trim()) msgs.push({ role: 'system', content: settings.systemPrompt.trim() });
  chain.forEach((node, idx) => {
    const dist = chain.length - 1 - idx;
    let firstUser = true;
    for (const m of node.messages) {
      if (uptoMsgId && node.id === nodeId && m.id === uptoMsgId) break;
      if (m.pending || !m.content) continue;
      let c = m.content;
      let images = null;
      if (m.role === 'user') {
        if (firstUser && node.anchor && node.anchor.text) {
          c = `关于你上面回答中的这段内容：\n「${node.anchor.text}」\n\n${c}`;
        }
        firstUser = false;
        if (m.attachments && m.attachments.length) {
          c += attachmentsAsText(m.attachments);
          const imgs = m.attachments.filter((a) => a.kind === 'image');
          // 只给当前窗口里的图片发原图，上层窗口的图片用文字代替，避免请求过大
          if (imgs.length) {
            if (node.id === nodeId) images = imgs.map((a) => ({ path: a.path, mime: a.mime, name: a.name }));
            else c += `\n（这条提问附带了 ${imgs.length} 张图片：${imgs.map((a) => a.name).join('、')}）`;
          }
        }
      } else if (dist > settings.fullContextDepth && c.length > settings.truncateChars) {
        c = c.slice(0, settings.truncateChars) + '\n…（较早的回答，已截断）';
      }
      const o = { role: m.role, content: c };
      if (images) o._images = images;
      msgs.push(o);
    }
  });
  const merged = mergeSameRole(msgs);
  const firstNonSys = merged.findIndex((m) => m.role !== 'system');
  if (firstNonSys >= 0 && merged[firstNonSys].role === 'assistant') {
    merged.splice(firstNonSys, 0, { role: 'user', content: '（继续之前的讨论）' });
  }
  return merged;
}

/**
 * 在渲染好的 DOM 里找到一段文字（忽略空白差异），用 <mark> 包起来。
 * 返回生成的 mark 元素数组；找不到返回 []。
 */
function highlightInEl(root, text, childId, cls = 'cmf-anchor') {
  const target = String(text || '').replace(/\s+/g, '');
  if (!target) return [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) =>
      n.parentElement && n.parentElement.closest(`mark.${cls}, mjx-container, .math, button`)
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT,
  });
  const chars = [];
  let joined = '';
  let tn;
  while ((tn = walker.nextNode())) {
    const t = tn.nodeValue;
    for (let i = 0; i < t.length; i++) {
      if (!/\s/.test(t[i])) {
        joined += t[i];
        chars.push([tn, i]);
      }
    }
  }
  const idx = joined.indexOf(target);
  if (idx < 0) return [];
  const start = chars[idx];
  const end = chars[idx + target.length - 1];
  const nodes = [];
  let inRange = false;
  let last = null;
  for (const [n] of chars) {
    if (n === last) continue;
    last = n;
    if (n === start[0]) inRange = true;
    if (inRange) nodes.push(n);
    if (n === end[0]) break;
  }
  const marks = [];
  for (const n of nodes) {
    const s0 = n === start[0] ? start[1] : 0;
    const e0 = n === end[0] ? end[1] + 1 : n.nodeValue.length;
    if (e0 <= s0) continue;
    try {
      const range = document.createRange();
      range.setStart(n, s0);
      range.setEnd(n, e0);
      const mark = document.createElement('mark');
      mark.className = cls;
      mark.dataset[cls === 'cmf-note' ? 'note' : 'child'] = childId;
      range.surroundContents(mark);
      marks.push(mark);
    } catch (_) {
      /* 跨元素边界时放弃这一段 */
    }
  }
  return marks;
}

/**
 * 高亮一处划线原文：文字部分用 <mark>，其中（以及首尾紧挨着）的公式整体加高亮类。
 * anchor = { text: 含 $LaTeX$ 的原文, plain?: 去掉公式的纯文本 }
 * 返回所有被高亮的元素（用于绑定点击）。
 */
function highlightAnchor(root, anchor, childId, kind = 'anchor') {
  const full = String(anchor.text || '');
  const plain = anchor.plain != null ? anchor.plain : full;
  const texes = extractMath(full).map((x) => x.tex);
  const cls = kind === 'note' ? 'cmf-note' : 'cmf-anchor';
  const mathCls = `${cls}-math`;
  const textMarks = plain.replace(/\s+/g, '') ? highlightInEl(root, plain, childId, cls) : [];
  const out = [];
  const markMath = (el) => {
    if (el.classList.contains(mathCls)) return;
    el.classList.add(mathCls);
    el.dataset[kind === 'note' ? 'note' : 'child'] = childId;
    if (!(kind === 'note' && el.classList.contains('cmf-anchor-math'))) paintMath(el, kind);
    out.push(el);
  };
  const mathEls = Array.from(root.querySelectorAll('.math'));
  if (texes.length && mathEls.length) {
    if (textMarks.length) {
      const first = textMarks[0];
      const last = textMarks[textMarks.length - 1];
      const range = document.createRange();
      range.setStartBefore(first);
      range.setEndAfter(last);
      // 选区以公式开头 / 结尾时，把紧挨着的那个公式也包进来
      if (/^\s*\$/.test(full)) {
        const before = mathEls.filter(
          (el) => first.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_PRECEDING && el.dataset.tex === texes[0]
        );
        if (before.length) range.setStartBefore(before[before.length - 1]);
      }
      if (/\$\s*$/.test(full)) {
        const after = mathEls.find(
          (el) => last.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING && el.dataset.tex === texes[texes.length - 1]
        );
        if (after) range.setEndAfter(after);
      }
      for (const el of mathEls) if (range.intersectsNode(el)) markMath(el);
    } else {
      // 只划了公式：按 LaTeX 源码找到对应的公式
      for (let i = 0; i < mathEls.length; i++) {
        if (mathEls[i].dataset.tex !== texes[0]) continue;
        for (let k = 0; k < texes.length && i + k < mathEls.length; k++) {
          if (mathEls[i + k].dataset.tex === texes[k]) markMath(mathEls[i + k]);
        }
        break;
      }
    }
  }
  return textMarks.concat(out);
}

/**
 * 给公式上色。MathJax 的外层 span / mjx-container 是行内元素且 line-height 为 0，
 * 背景画不出来；真正有尺寸的是里面 inline-block 的 <mjx-math>，所以直接给它写行内样式（!important）。
 * kind: 'sel' 选中中 | 'anchor' 已划线 | null 清除
 */
const MATH_PAINT = {
  sel: 'var(--text-selection, rgba(80, 140, 255, 0.35))',
  anchor: 'rgba(var(--color-yellow-rgb, 230, 200, 60), 0.4)',
  note: 'rgba(var(--color-blue-rgb, 80, 140, 230), 0.22)',
};
function paintMath(el, kind) {
  const targets = el.querySelectorAll('mjx-math');
  const list = targets.length ? Array.from(targets) : [el];
  for (const t of list) {
    if (!kind) {
      if (t.dataset.cmfPaint) {
        // 已划线的公式取消选中后恢复黄色
        const back = el.classList.contains('cmf-anchor-math') ? 'anchor' : el.classList.contains('cmf-note-math') ? 'note' : null;
        delete t.dataset.cmfPaint;
        for (const k of ['background-color', 'border-radius', 'box-shadow']) t.style.removeProperty(k);
        if (back) paintMath(el, back);
      }
      continue;
    }
    const c = MATH_PAINT[kind];
    t.dataset.cmfPaint = kind;
    t.style.setProperty('background-color', c, 'important');
    t.style.setProperty('border-radius', '3px', 'important');
    t.style.setProperty('box-shadow', `0 0 0 2px ${c}`, 'important');
  }
}

/** 拖选时给选区里的公式加上选中底色（公式的符号是样式画的，浏览器自带的选中色盖不到） */
function markSelectedMath(scope, range) {
  if (!scope) return;
  const now = new Set();
  if (range && !range.collapsed) {
    scope.querySelectorAll('.math').forEach((el) => {
      try {
        if (range.intersectsNode(el)) now.add(el);
      } catch (_) {}
    });
  }
  scope.querySelectorAll('.math.cmf-math-selected').forEach((el) => {
    if (now.has(el)) return;
    el.classList.remove('cmf-math-selected');
    paintMath(el, null);
  });
  for (const el of now) {
    if (el.classList.contains('cmf-math-selected')) continue;
    el.classList.add('cmf-math-selected');
    paintMath(el, 'sel');
  }
}

/** 弹出追问框后输入框会抢走焦点、选区消失；用 CSS Highlight 把选中的文字继续标出来 */
function setPendingHighlight(range) {
  try {
    if (!window.CSS || !CSS.highlights) return;
    if (range) CSS.highlights.set('cmf-pending', new Highlight(range.cloneRange()));
    else CSS.highlights.delete('cmf-pending');
  } catch (_) {}
}

/** 复制到剪贴板；安卓 WebView 不支持 navigator.clipboard 时退回 execCommand */
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (_) {
    const ta = document.body.createEl('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch (e) {}
    ta.remove();
    return ok;
  }
}

function confirmModal(app, title, message, okText) {
  return new Promise((resolve) => {
    const m = new obsidian.Modal(app);
    let ok = false;
    m.titleEl.setText(title);
    m.contentEl.createEl('p', { text: message });
    const row = m.contentEl.createDiv({ cls: 'modal-button-container' });
    row.createEl('button', { text: '取消' }).addEventListener('click', () => m.close());
    const b = row.createEl('button', { text: okText || '确定', cls: 'mod-warning' });
    b.addEventListener('click', () => {
      ok = true;
      m.close();
    });
    m.onClose = () => resolve(ok);
    m.open();
  });
}

// ── 存储 ───────────────────────────────────────────────────
class ChatStore {
  constructor(plugin) {
    this.plugin = plugin;
    this.cache = new Map();
    this.timers = new Map();
  }

  get adapter() {
    return this.plugin.app.vault.adapter;
  }

  folder() {
    return obsidian.normalizePath((this.plugin.settings.chatFolder || 'Mindflow').trim() || 'Mindflow');
  }

  dir() {
    return `${this.folder()}/对话数据`;
  }

  path(id) {
    return `${this.dir()}/${id}.json`;
  }

  async ensureDir(p) {
    let cur = '';
    for (const part of p.split('/')) {
      cur = cur ? `${cur}/${part}` : part;
      if (!(await this.adapter.exists(cur))) await this.adapter.mkdir(cur);
    }
  }

  async list() {
    const dir = this.dir();
    if (!(await this.adapter.exists(dir))) return [];
    const r = await this.adapter.list(dir);
    for (const f of r.files) {
      if (!f.endsWith('.json')) continue;
      const id = f.split('/').pop().replace(/\.json$/, '');
      if (this.cache.has(id)) continue;
      try {
        const s = JSON.parse(await this.adapter.read(f));
        if (s && s.id && s.nodes) this.cache.set(s.id, s);
      } catch (_) {}
    }
    return Array.from(this.cache.values()).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async get(id) {
    if (!id) return null;
    if (this.cache.has(id)) return this.cache.get(id);
    try {
      const s = JSON.parse(await this.adapter.read(this.path(id)));
      this.cache.set(s.id, s);
      return s;
    } catch (_) {
      return null;
    }
  }

  create(question) {
    const now = Date.now();
    const root = { id: uid(), parentId: null, anchor: null, title: truncate(question, 40), createdAt: now, messages: [] };
    const s = { id: uid(), version: 1, title: root.title, createdAt: now, updatedAt: now, rootId: root.id, nodes: { [root.id]: root } };
    this.cache.set(s.id, s);
    return s;
  }

  save(s, immediate) {
    s.updatedAt = Date.now();
    clearTimeout(this.timers.get(s.id));
    const write = async () => {
      this.timers.delete(s.id);
      try {
        await this.ensureDir(this.dir());
        await this.adapter.write(this.path(s.id), JSON.stringify(s, null, 1));
      } catch (e) {
        console.error('Canvas Mindflow: 保存对话失败', e);
      }
    };
    if (immediate) return write();
    this.timers.set(s.id, setTimeout(write, 400));
  }

  async flush() {
    for (const [id, t] of this.timers) {
      clearTimeout(t);
      const s = this.cache.get(id);
      if (s) await this.save(s, true);
    }
  }

  async remove(id) {
    clearTimeout(this.timers.get(id));
    this.cache.delete(id);
    try {
      if (await this.adapter.exists(this.path(id))) await this.adapter.remove(this.path(id));
    } catch (_) {}
  }
}

// ── 功能入口：存储、流式生成、总览图、视图注册 ──────────────
class MindflowChat {
  constructor(plugin) {
    this.plugin = plugin;
    this.app = plugin.app;
    this.store = new ChatStore(plugin);
    this.fav = new FavStore(this);
    this.notes = new NoteStore(this);
    this.running = new Map(); // `${sessionId}:${msgId}` -> AbortController
    this.listeners = new Set();
  }

  load() {
    const p = this.plugin;
    p.registerView(CHAT_VIEW, (leaf) => new MindflowChatView(leaf, this));
    p.addRibbonIcon('messages-square', 'Mindflow 对话', () => this.openView());
    p.addCommand({ id: 'chat-open', name: '打开对话视图', callback: () => this.openView() });
    p.addCommand({ id: 'chat-new', name: '新建对话', callback: () => this.openView(null, null, true) });
    p.addCommand({
      id: 'chat-overview',
      name: '为当前对话生成 Canvas 总览图',
      checkCallback: (checking) => {
        const v = this.activeView();
        if (!v || !v.session) return false;
        if (!checking) this.generateOverview(v.session);
        return true;
      },
    });
    try {
      p.registerObsidianProtocolHandler(URI_ACTION, (params) => this.openView(params.session, params.node, false, params.msg));
    } catch (e) {
      console.warn('Canvas Mindflow: 当前平台不支持 obsidian:// 链接跳转', e);
    }
  }

  unload() {
    for (const c of this.running.values()) c.abort();
    this.store.flush();
    this.fav.flush();
    this.notes.flush();
  }

  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(evt) {
    for (const fn of this.listeners) {
      try {
        fn(evt);
      } catch (e) {
        console.error(e);
      }
    }
  }

  activeView() {
    const leaf = this.app.workspace.activeLeaf;
    return leaf && leaf.view instanceof MindflowChatView ? leaf.view : null;
  }

  async openView(sessionId, nodeId, fresh, msgId) {
    let leaf = this.app.workspace.getLeavesOfType(CHAT_VIEW)[0];
    if (!leaf) {
      leaf = this.app.workspace.getLeaf('tab');
      await leaf.setViewState({ type: CHAT_VIEW, active: true, state: {} });
    }
    this.app.workspace.revealLeaf(leaf);
    const view = leaf.view;
    if (!(view instanceof MindflowChatView)) return;
    if (fresh) view.newChat();
    else if (sessionId) {
      if (msgId) view.pendingFocusMsg = msgId;
      await view.openSession(sessionId, nodeId);
    }
    else if (!view.session) {
      const list = await this.store.list();
      if (list.length) await view.openSession(list[0].id);
      else view.newChat();
    }
  }

  isRunning(s, msgId) {
    return this.running.has(`${s.id}:${msgId}`);
  }

  isNodeRunning(s, node) {
    return node.messages.some((m) => this.isRunning(s, m.id));
  }

  stop(s, node) {
    for (const m of node.messages) {
      const c = this.running.get(`${s.id}:${m.id}`);
      if (c) c.abort();
    }
  }

  /** 在某个窗口里提问：加入用户消息 + 空的 AI 消息，然后流式生成 */
  async ask(s, nodeId, question, attachments) {
    const node = s.nodes[nodeId];
    if (!node) return;
    const settings = this.plugin.settings;
    if (!settings.apiKey.trim()) {
      new Notice('Canvas Mindflow：请先在设置里填写 API Key');
      return;
    }
    const now = Date.now();
    const atts = attachments && attachments.length ? attachments : null;
    if (!question && atts) question = atts.some((a) => a.kind === 'image') ? '请分析这张图片。' : '请分析这个文件。';
    const um = { id: uid(), role: 'user', content: question, createdAt: now };
    if (atts) um.attachments = atts;
    node.messages.push(um);
    if (!node.title) node.title = truncate(question, 40);
    const msg = { id: uid(), role: 'assistant', content: '', createdAt: now + 1, pending: true };
    node.messages.push(msg);
    this.store.save(s);
    this.emit({ type: 'structure', sessionId: s.id, nodeId });

    await this.runAssistant(s, nodeId, msg, buildThreadMessages(settings, s, nodeId));
  }

  /** 流式生成一条 AI 消息 */
  async runAssistant(s, nodeId, msg, messages) {
    let settings = this.plugin.settings;
    const hasImages = messages.some((m) => m._images && m._images.length);
    if (hasImages && (settings.visionModel || '').trim()) settings = Object.assign({}, settings, { model: settings.visionModel.trim() });
    msg.model = settings.model;
    try {
      messages = await materializeImages(this.app, messages);
    } catch (e) {
      console.error('Canvas Mindflow: 读取图片失败', e);
    }
    const key = `${s.id}:${msg.id}`;
    const ctrl = new AbortController();
    this.running.set(key, ctrl);
    let last = 0;
    let timer = null;
    const flush = () => {
      timer = null;
      last = Date.now();
      this.emit({ type: 'delta', sessionId: s.id, nodeId, msgId: msg.id });
    };
    try {
      await streamChat(
        settings,
        messages,
        (d) => {
          msg.content += d;
          const wait = 120 - (Date.now() - last);
          if (wait <= 0) flush();
          else if (!timer) timer = setTimeout(flush, wait);
        },
        ctrl.signal
      );
      if (!msg.content.trim()) msg.content = '（AI 返回为空）';
    } catch (e) {
      if (e && e.name === 'AbortError') msg.content += '\n\n*（已停止生成）*';
      else {
        msg.content = (msg.content ? msg.content + '\n\n' : '') + `❌ 请求失败：${(e && e.message) || e}`;
        if (hasImages)
          msg.content += `\n\n> 这次提问带了图片。如果当前模型（${settings.model}）不支持图片，请在设置 →「图片识别模型」里填一个支持图片的模型。`;
      }
    } finally {
      if (timer) clearTimeout(timer);
      this.running.delete(key);
      delete msg.pending;
      msg.doneAt = Date.now();
      this.store.save(s);
      this.emit({ type: 'done', sessionId: s.id, nodeId, msgId: msg.id });
    }
  }

  /** 重新回答：清空这条回答，用它之前的对话重新生成 */
  async regenerate(s, nodeId, msgId) {
    const node = s.nodes[nodeId];
    const msg = node && node.messages.find((m) => m.id === msgId);
    if (!msg || msg.role !== 'assistant' || this.isRunning(s, msgId)) return;
    if (!this.plugin.settings.apiKey.trim()) {
      new Notice('Canvas Mindflow：请先在设置里填写 API Key');
      return;
    }
    msg.content = '';
    msg.pending = true;
    msg.createdAt = Date.now();
    delete msg.editedAt;
    delete msg.originalContent;
    this.emit({ type: 'delta', sessionId: s.id, nodeId, msgId });
    await this.runAssistant(s, nodeId, msg, buildThreadMessages(this.plugin.settings, s, nodeId, msgId));
  }

  /** 修改一条消息的内容（例如在 AI 回答里补充自己的理解）；之后的追问会以修改后的内容为上下文 */
  editMessage(s, nodeId, msgId, content) {
    const node = s.nodes[nodeId];
    const msg = node && node.messages.find((m) => m.id === msgId);
    if (!msg || msg.pending) return;
    if (msg.content === content) return;
    if (msg.originalContent === undefined) msg.originalContent = msg.content;
    msg.content = content;
    msg.editedAt = Date.now();
    this.store.save(s);
    this.emit({ type: 'done', sessionId: s.id, nodeId, msgId });
  }

  /** 删除一轮问答（这条回答和它前面的提问）；基于它的追问保留 */
  deleteRound(s, nodeId, msgId) {
    const node = s.nodes[nodeId];
    if (!node) return;
    const i = node.messages.findIndex((m) => m.id === msgId);
    if (i < 0) return;
    const c = this.running.get(`${s.id}:${msgId}`);
    if (c) c.abort();
    const start = i > 0 && node.messages[i - 1].role === 'user' ? i - 1 : i;
    node.messages.splice(start, i - start + 1);
    this.store.save(s);
    this.emit({ type: 'structure', sessionId: s.id, nodeId: '__round__' });
  }

  /** 把一条回答保存为 Markdown 笔记 */
  async saveAsNote(s, nodeId, msgId) {
    const node = s.nodes[nodeId];
    const i = node ? node.messages.findIndex((m) => m.id === msgId) : -1;
    if (i < 0) return;
    const msg = node.messages[i];
    const q = i > 0 && node.messages[i - 1].role === 'user' ? node.messages[i - 1].content : node.title;
    const folder = obsidian.normalizePath(this.plugin.settings.noteFolder || `${this.store.folder()}/笔记`);
    await this.store.ensureDir(folder);
    const base = (truncate(q || node.title || '回答', 40) || '回答').replace(/[\\/:*?"<>|#^[\]]/g, ' ').trim();
    let path = `${folder}/${base}.md`;
    for (let k = 2; this.app.vault.getAbstractFileByPath(path); k++) path = `${folder}/${base} ${k}.md`;
    const chain = chainOf(s, nodeId)
      .map((n) => n.title)
      .join(' → ');
    const lines = [
      '---',
      `source: Mindflow 对话`,
      `created: ${new Date().toISOString().slice(0, 10)}`,
      msg.model ? `model: ${msg.model}` : null,
      '---',
      '',
      `> 来自对话：${chain}`,
      node.anchor && node.anchor.text ? `> 原文：==${node.anchor.text}==` : null,
      '',
      `## ${q}`,
      '',
      normalizeMath(msg.content),
      '',
      `[回到对话](obsidian://${URI_ACTION}?session=${encodeURIComponent(s.id)}&node=${encodeURIComponent(nodeId)})`,
    ].filter((l) => l !== null);
    const file = await this.app.vault.create(path, lines.join('\n'));
    new Notice(`已保存为笔记：${path}`);
    await this.app.workspace.getLeaf('tab').openFile(file);
  }

  /** 设置变化后刷新所有对话视图的布局 */
  applyLayoutSettings() {
    for (const leaf of this.app.workspace.getLeavesOfType(CHAT_VIEW)) {
      if (leaf.view instanceof MindflowChatView) leaf.view.applyLayout();
    }
  }

  /** 划线追问：新建子窗口并提问，返回子窗口 id */
  branch(s, parentId, anchor, question, attachments) {
    const q = (question || '').trim() || this.plugin.settings.defaultFollowUp || '请详细解释这段内容。';
    const child = {
      id: uid(),
      parentId,
      anchor,
      title: (question || '').trim() ? truncate(question, 40) : `「${truncate(anchor.text, 18)}」是什么意思？`,
      createdAt: Date.now(),
      messages: [],
    };
    s.nodes[child.id] = child;
    this.store.save(s);
    this.ask(s, child.id, q, attachments);
    return child.id;
  }

  async deleteNode(s, nodeId) {
    for (const id of subtreeIds(s, nodeId)) {
      const n = s.nodes[id];
      if (n) this.stop(s, n);
      delete s.nodes[id];
    }
    this.store.save(s);
    this.emit({ type: 'structure', sessionId: s.id, nodeId });
  }

  // ── Canvas 总览图 ──────────────────────────────────────
  /** 把一个对话的问答树排成 Canvas 节点（左上角在 ox, oy），返回 { nodes, edges, w, h } */
  layoutSession(s, ox = 0, oy = 0, idPrefix = '') {
    const W = 380;
    const H = 260;
    const GX = 140;
    const GY = 50;
    const pos = {};
    let row = 0;
    const place = (id, depth) => {
      const kids = childrenOf(s, id);
      let y;
      if (!kids.length) {
        y = row * (H + GY);
        row++;
      } else {
        const ys = kids.map((k) => place(k.id, depth + 1));
        y = (Math.min(...ys) + Math.max(...ys)) / 2;
      }
      pos[id] = { x: depth * (W + GX), y };
      return y;
    };
    if (s.nodes[s.rootId]) place(s.rootId, 0);

    const nodes = [];
    const edges = [];
    let w = 0;
    let h = 0;
    for (const n of Object.values(s.nodes)) {
      if (!pos[n.id]) continue;
      const ans = lastAnswer(n);
      const link = `obsidian://${URI_ACTION}?session=${encodeURIComponent(s.id)}&node=${encodeURIComponent(n.id)}`;
      const parts = [`### [${(n.title || '未命名问题').replace(/[[\]]/g, '')}](${link})`];
      if (n.anchor && n.anchor.text) parts.push(`==${truncate(n.anchor.text, 40)}==`);
      if (ans && ans.content) parts.push(plainExcerpt(ans.content, 260));
      parts.push(`[打开对话 →](${link})`);
      const nw = n.id === s.rootId ? W + 20 : W;
      const node = {
        id: idPrefix + n.id,
        type: 'text',
        text: parts.join('\n\n'),
        x: Math.round(ox + pos[n.id].x),
        y: Math.round(oy + pos[n.id].y),
        width: nw,
        height: H,
      };
      if (n.id === s.rootId) node.color = '6';
      nodes.push(node);
      w = Math.max(w, pos[n.id].x + nw);
      h = Math.max(h, pos[n.id].y + H);
      if (n.parentId && pos[n.parentId]) {
        edges.push({ id: uid(), fromNode: idPrefix + n.parentId, fromSide: 'right', toNode: idPrefix + n.id, toSide: 'left', toEnd: 'arrow' });
      }
    }
    return { nodes, edges, w, h };
  }

  /** 写入（或覆盖）一个 .canvas 文件并打开 */
  async writeCanvas(dir, name, data) {
    await this.store.ensureDir(dir);
    const safe = (name || '未命名').replace(/[\\/:*?"<>|#^[\]]/g, ' ').trim().slice(0, 60) || '未命名';
    const path = `${dir}/${safe}.canvas`;
    const content = JSON.stringify(data, null, 1);
    const existing = this.app.vault.getAbstractFileByPath(path);
    let file;
    if (existing) {
      await this.app.vault.modify(existing, content);
      file = existing;
    } else {
      file = await this.app.vault.create(path, content);
    }
    await this.app.workspace.getLeaf('tab').openFile(file, { active: true });
    return path;
  }

  // ── 收藏夹 ─────────────────────────────────────────────
  /** 选一个收藏夹并加入条目。item = { type: 'qa'|'session', sessionId, nodeId?, msgId?, title } */
  async addToFavorites(item) {
    const fav = this.fav;
    await fav.load();
    const folderId = await pickFolder(this.app, fav, {
      title: item.type === 'qa' ? '收藏这轮问答' : '收藏这个对话',
      subtitle: `「${truncate(item.title || '', 40)}」`,
      selected: this.lastFavFolder,
    });
    if (!folderId) return;
    this.lastFavFolder = folderId;
    const r = fav.addItem(folderId, item);
    new Notice(r.existed ? `已经在「${fav.pathName(folderId)}」里了` : `已加入收藏夹「${fav.pathName(folderId)}」`);
    this.emit({ type: 'fav' });
  }

  /** 把一个收藏夹（含子收藏夹）放进 Canvas；folderId 为空 = 全部收藏夹 */
  async exportFolderCanvas(folderId) {
    const fav = this.fav;
    await fav.load();
    await this.store.flush();
    const data = await buildFolderCanvas(this, fav, folderId);
    const name = folderId ? `收藏夹 - ${fav.pathName(folderId).replace(/ \/ /g, '-')}` : '收藏夹 - 全部';
    const path = await this.writeCanvas(`${this.store.folder()}/总览图`, name, data);
    new Notice(`已生成 Canvas：${path}`);
    return path;
  }

  async generateOverview(s) {
    await this.store.save(s, true);
    const { nodes, edges } = this.layoutSession(s);
    const path = await this.writeCanvas(`${this.store.folder()}/总览图`, `${(s.title || '对话').slice(0, 40)} - 总览`, { nodes, edges });
    new Notice(`已生成总览图：${path}`);
    return path;
  }
}

// ── 视图 ───────────────────────────────────────────────────
class MindflowChatView extends obsidian.ItemView {
  constructor(leaf, chat) {
    super(leaf);
    this.chat = chat;
    this.plugin = chat.plugin;
    this.session = null;
    this.nodeId = null;
    this.sideTab = 'follow';
    this.expanded = new Set();
    this.mdComps = [];
    this.msgEls = new Map();
    this.cardEls = new Map();
    this.renderTimers = new Map();
  }

  getViewType() {
    return CHAT_VIEW;
  }

  getDisplayText() {
    return this.session ? `追问 · ${this.session.title}` : 'Mindflow 对话';
  }

  getIcon() {
    return 'messages-square';
  }

  getState() {
    return Object.assign(super.getState(), { sessionId: this.session && this.session.id, nodeId: this.nodeId, navMode: this.navMode || 'history' });
  }

  async setState(state, result) {
    if (state && (state.navMode === 'fav' || state.navMode === 'history') && state.navMode !== this.navMode) {
      this.navMode = state.navMode;
      this.renderNav();
    }
    if (state && state.sessionId && (!this.session || state.sessionId !== this.session.id)) {
      await this.openSession(state.sessionId, state.nodeId);
    }
    return super.setState(state, result);
  }

  get node() {
    return this.session && this.nodeId ? this.session.nodes[this.nodeId] : null;
  }

  get settings() {
    return this.plugin.settings;
  }

  // ── 布局：两侧栏宽度 / 展开收起 / 字号 ─────────────────
  /** 手机或窗口宽度 < 700 时切换为单栏 + 抽屉 */
  /** 手机：避开 Obsidian 底部悬浮工具栏（.mobile-navbar），把输入框等往上让 */
  updateBottomGap() {
    const root = this.contentEl;
    let gap = 0;
    const nav = document.querySelector('.mobile-navbar');
    if (nav) {
      const r = nav.getBoundingClientRect();
      const v = root.getBoundingClientRect();
      const visible = r.height > 0 && getComputedStyle(nav).display !== 'none' && getComputedStyle(nav).visibility !== 'hidden';
      if (visible && r.top < v.bottom && r.bottom > v.top) gap = Math.ceil(v.bottom - r.top) + 6;
    }
    if (gap !== this.bottomGap) {
      this.bottomGap = gap;
      root.style.setProperty('--cmf-bottom-gap', `${gap}px`);
    }
  }

  updateCompact() {
    const root = this.contentEl;
    this.updateBottomGap();
    const compact = !!(obsidian.Platform && obsidian.Platform.isMobile) || (root.clientWidth > 0 && root.clientWidth < 700);
    if (compact === this.compact) return;
    this.compact = compact;
    root.toggleClass('is-compact', compact);
    this.drawer = null;
    this.applyLayout();
  }

  openDrawer(which) {
    if (!this.compact) return;
    this.drawer = which;
    this.applyLayout();
  }

  closeDrawers() {
    if (!this.drawer) return;
    this.drawer = null;
    this.applyLayout();
  }

  applyLayout() {
    const st = this.settings;
    if (!this.navEl) return;
    this.contentEl.style.setProperty('--cmf-font-size', `${st.chatFontSize || 15}px`);
    if (this.compact) {
      this.navEl.style.width = '';
      this.sideEl.style.width = '';
      this.navEl.removeClass('is-collapsed');
      this.sideEl.removeClass('is-collapsed');
      this.navEl.toggleClass('is-open', this.drawer === 'nav');
      this.sideEl.toggleClass('is-open', this.drawer === 'side');
      this.backdrop.toggleClass('is-open', !!this.drawer);
      if (this.navToggleEl) this.navToggleEl.toggleClass('is-active', this.drawer === 'nav');
      if (this.sideToggleEl) this.sideToggleEl.toggleClass('is-active', this.drawer === 'side');
      return;
    }
    this.navEl.removeClass('is-open');
    this.sideEl.removeClass('is-open');
    this.backdrop.removeClass('is-open');
    this.navEl.style.width = `${st.chatNavWidth}px`;
    this.sideEl.style.width = `${st.chatSideWidth}px`;
    this.navEl.toggleClass('is-collapsed', !!st.chatNavCollapsed);
    this.sideEl.toggleClass('is-collapsed', !!st.chatSideCollapsed);
    this.navResizer.toggleClass('is-hidden', !!st.chatNavCollapsed);
    this.sideResizer.toggleClass('is-hidden', !!st.chatSideCollapsed);
    if (this.navToggleEl) this.navToggleEl.toggleClass('is-active', !st.chatNavCollapsed);
    if (this.sideToggleEl) this.sideToggleEl.toggleClass('is-active', !st.chatSideCollapsed);
  }

  async togglePanel(which) {
    if (this.compact) {
      this.drawer = this.drawer === which ? null : which;
      this.applyLayout();
      return;
    }
    const key = which === 'nav' ? 'chatNavCollapsed' : 'chatSideCollapsed';
    this.settings[key] = !this.settings[key];
    await this.plugin.saveSettings();
    this.chat.applyLayoutSettings();
  }

  bindResizer(handle, key, dir, min, max) {
    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const startX = e.clientX;
      const startW = this.settings[key];
      handle.setPointerCapture(e.pointerId);
      handle.addClass('is-dragging');
      this.contentEl.addClass('is-resizing');
      const move = (ev) => {
        const w = Math.max(min, Math.min(max, startW + dir * (ev.clientX - startX)));
        this.settings[key] = Math.round(w);
        this.applyLayout();
      };
      const up = async () => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        handle.removeEventListener('pointercancel', up);
        handle.removeClass('is-dragging');
        this.contentEl.removeClass('is-resizing');
        await this.plugin.saveSettings();
        this.chat.applyLayoutSettings();
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
      handle.addEventListener('pointercancel', up);
    });
    handle.addEventListener('dblclick', async () => {
      this.settings[key] = DEFAULT_SETTINGS[key];
      await this.plugin.saveSettings();
      this.chat.applyLayoutSettings();
    });
  }

  openSettings() {
    const setting = this.app.setting;
    if (setting && setting.open) {
      setting.open();
      if (setting.openTabById) setting.openTabById(this.plugin.manifest.id);
    }
  }

  async onOpen() {
    const root = this.contentEl;
    root.empty();
    root.addClass('cmf-chat');
    this.navEl = root.createDiv({ cls: 'cmf-nav' });
    this.navResizer = root.createDiv({ cls: 'cmf-resizer', attr: { 'aria-label': '拖动调整左侧栏宽度' } });
    this.mainEl = root.createDiv({ cls: 'cmf-main' });
    this.sideResizer = root.createDiv({ cls: 'cmf-resizer', attr: { 'aria-label': '拖动调整右侧栏宽度' } });
    this.sideEl = root.createDiv({ cls: 'cmf-side' });
    this.backdrop = root.createDiv({ cls: 'cmf-backdrop' });
    this.backdrop.addEventListener('click', () => this.closeDrawers());
    this.drawer = null; // 窄屏 / 手机：当前滑出的抽屉 'nav' | 'side'
    this.compact = false;
    this.updateCompact();
    if (window.ResizeObserver) {
      const ro = new ResizeObserver(() => this.updateCompact());
      ro.observe(root);
      this.register(() => ro.disconnect());
    }
    this.registerDomEvent(document, 'selectionchange', () => this.onSelectionChange());
    // Ctrl+C / 系统复制：带上公式的 LaTeX 源码（默认复制会把公式丢掉）
    this.registerDomEvent(document, 'copy', (e) => {
      const r = this.readSelection();
      if (!r || !e.clipboardData) return;
      e.clipboardData.setData('text/plain', r.anchor.text);
      e.preventDefault();
    });
    this.registerDomEvent(window, 'resize', () => this.updateBottomGap());
    if (window.visualViewport) this.registerDomEvent(window.visualViewport, 'resize', () => this.updateBottomGap());
    // 工具栏会随滚动 / 键盘显示隐藏，手机上定时校正一次
    if (obsidian.Platform && obsidian.Platform.isMobile) this.registerInterval(window.setInterval(() => this.updateBottomGap(), 800));
    this.bindResizer(this.navResizer, 'chatNavWidth', 1, 140, 480);
    this.bindResizer(this.sideResizer, 'chatSideWidth', -1, 220, 720);
    this.applyLayout();
    this.unsub = this.chat.on((e) => this.onChatEvent(e));
    this.register(() => this.unsub && this.unsub());
    this.registerDomEvent(document, 'pointerdown', (e) => {
      // 右键时先别关追问框：右键菜单要用到弹窗里那段选区
      if (this.popEl && !this.popEl.contains(e.target) && e.button !== 2) this.closePop();
    });
    try {
      await this.chat.notes.load();
    } catch (_) {}
    await this.renderNav();
    this.renderMain();
    this.renderSide();
  }

  async onClose() {
    this.closePop();
    this.unloadMd();
  }

  // ── 打开 / 切换 ────────────────────────────────────────
  async openSession(sessionId, nodeId) {
    const s = await this.chat.store.get(sessionId);
    if (!s) {
      new Notice('没有找到这个对话');
      return;
    }
    this.session = s;
    this.mode = 'chat';
    this.nodeId = nodeId && s.nodes[nodeId] ? nodeId : s.rootId;
    this.expanded.clear();
    this.refreshAll('top');
  }

  openNode(nodeId) {
    if (!this.session || !this.session.nodes[nodeId]) return;
    const wasNotes = this.mode === 'notes';
    this.mode = 'chat';
    if (wasNotes) this.renderNav();
    this.nodeId = nodeId;
    this.expanded.clear();
    this.sideTab = 'follow';
    this.closePop();
    this.closeDrawers();
    this.replyAnchor = null;
    this.setPending(null);
    this.renderMain('top');
    this.renderSide();
    this.app.workspace.requestSaveLayout();
  }

  newChat() {
    this.mode = 'chat';
    this.closeDrawers();
    this.session = null;
    this.nodeId = null;
    this.refreshAll();
    setTimeout(() => this.inputEl && this.inputEl.focus(), 50);
  }

  refreshAll(scrollMode) {
    this.renderNav();
    this.renderMain(scrollMode);
    this.renderSide();
    this.leaf.updateHeader && this.leaf.updateHeader();
    this.app.workspace.requestSaveLayout();
  }

  onChatEvent(e) {
    if (e.type === 'fav') {
      if (this.mode !== 'notes') this.renderNav();
      return;
    }
    if (e.type === 'notes') {
      if (this.mode === 'notes') {
        this.renderNav();
        this.renderMain();
      } else if (this.session && e.sessionId === this.session.id && e.nodeId === this.nodeId) this.renderMain(true);
      return;
    }
    if (this.mode === 'notes') {
      if (e.type === 'done' || e.type === 'structure') this.renderNav();
      return;
    }
    if (!this.session || e.sessionId !== this.session.id) {
      if (e.type === 'done' || e.type === 'structure') this.renderNav();
      return;
    }
    const node = this.node;
    if (!node) return;
    const isMain = e.nodeId === this.nodeId;
    const isChild = this.session.nodes[e.nodeId] && this.session.nodes[e.nodeId].parentId === this.nodeId;
    if (e.type === 'structure') {
      if (!this.session.nodes[this.nodeId]) this.nodeId = this.session.rootId;
      this.renderMain(e.nodeId !== this.nodeId);
      this.renderSide();
      this.renderNav();
      return;
    }
    if (isMain) this.updateMessage(e.msgId, e.type === 'done');
    if (isChild || this.sideTab === 'tree') this.scheduleSide();
    if (e.type === 'done') {
      this.renderNav();
      if (isMain) this.renderComposerState();
    }
  }

  // ── 左侧导航 ───────────────────────────────────────────
  async renderNav() {
    const el = this.navEl;
    if (!el) return;
    const tok = (this.navTok = (this.navTok || 0) + 1);
    el.empty();
    const btn = (icon, text, onClick, cls) => {
      const b = el.createDiv({ cls: 'cmf-nav-btn' + (cls ? ' ' + cls : '') });
      obsidian.setIcon(b.createSpan({ cls: 'cmf-nav-icon' }), icon);
      b.createSpan({ text, cls: 'cmf-nav-text' });
      b.setAttr('aria-label', text);
      b.addEventListener('click', onClick);
      return b;
    };
    btn('square-pen', '新建对话', () => this.newChat());
    const cur = this.mode === 'notes' ? 'notes' : this.navMode === 'fav' ? 'fav' : 'history';
    btn('history', '历史', () => this.switchNav('history'), cur === 'history' ? 'is-active' : '');
    btn('star', '收藏夹', () => this.switchNav('fav'), cur === 'fav' ? 'is-active is-fav' : '');
    btn('notebook-pen', '笔记', () => this.switchNav('notes'), cur === 'notes' ? 'is-active' : '');
    btn('layout-dashboard', '生成总览图', () => {
      if (this.session) this.chat.generateOverview(this.session);
      else new Notice('先开始一个对话');
    });
    btn('settings', '设置', () => this.openSettings());
    if (this.mode === 'notes') return this.renderNoteNav(el, tok);
    if (this.navMode === 'fav') return this.renderFavs(el, tok);
    el.createDiv({ cls: 'cmf-nav-label', text: '历史' });
    const listEl = el.createDiv({ cls: 'cmf-hist' });
    const list = await this.chat.store.list();
    const fav = this.chat.fav;
    await fav.load();
    if (tok !== this.navTok) return;
    const starred = new Set(fav.data.items.map((i) => i.sessionId));
    if (!list.length) listEl.createDiv({ cls: 'cmf-hist-empty', text: '还没有对话' });
    for (const s of list) {
      const item = listEl.createDiv({ cls: 'cmf-hist-item' + (this.session && this.session.id === s.id ? ' is-active' : '') });
      item.createDiv({ cls: 'cmf-hist-title', text: s.title || '未命名对话' });
      const meta = item.createDiv({ cls: 'cmf-hist-time' });
      if (starred.has(s.id)) {
        const st = meta.createSpan({ cls: 'cmf-hist-star', attr: { 'aria-label': '已收藏' } });
        obsidian.setIcon(st, 'star');
      }
      meta.createSpan({ text: `${fmtTime(s.updatedAt)} · ${Object.keys(s.nodes).length} 个窗口` });
      item.addEventListener('click', () => {
        this.closeDrawers();
        this.openSession(s.id);
      });
      item.addEventListener('contextmenu', (evt) => {
        const menu = new obsidian.Menu();
        menu.addItem((i) =>
          i
            .setTitle('加入收藏夹…')
            .setIcon('star')
            .onClick(() => this.chat.addToFavorites({ type: 'session', sessionId: s.id, title: s.title || '未命名对话' }))
        );
        menu.addItem((i) => i.setTitle('生成总览图').setIcon('layout-dashboard').onClick(() => this.chat.generateOverview(s)));
        menu.addItem((i) =>
          i
            .setTitle('删除对话')
            .setIcon('trash')
            .onClick(async () => {
              if (!(await confirmModal(this.app, '删除对话', `确认删除「${s.title}」及其所有追问？此操作不可撤销。`, '删除'))) return;
              await this.chat.store.remove(s.id);
              await this.chat.fav.forgetSession(s.id);
              if (this.session && this.session.id === s.id) this.newChat();
              else this.renderNav();
            })
        );
        menu.showAtMouseEvent(evt);
      });
    }
  }

  // ── 主窗口 ─────────────────────────────────────────────
  unloadMd() {
    for (const c of this.mdComps) c.unload();
    this.mdComps = [];
    for (const c of this.notesComps || []) c.unload();
    this.notesComps = [];
  }

  async renderMarkdown(el, md) {
    if (el._cmfComp) {
      el._cmfComp.unload();
      this.mdComps = this.mdComps.filter((c) => c !== el._cmfComp);
    }
    const comp = new obsidian.Component();
    el._cmfComp = comp;
    comp.load();
    this.mdComps.push(comp);
    el.empty();
    const norm = normalizeMath(md);
    await obsidian.MarkdownRenderer.render(this.app, norm, el, '', comp);
    // 公式渲染（MathJax）可能稍后才完成，给公式元素标上 LaTeX 源码，划线时用
    annotateMath(el, norm);
    // 公式稍后才画好时，把已划线 / 选中的公式重新上色
    const repaint = () => {
      annotateMath(el, norm);
      el.querySelectorAll('.math.cmf-note-math').forEach((m) => paintMath(m, 'note'));
      el.querySelectorAll('.math.cmf-anchor-math').forEach((m) => paintMath(m, 'anchor'));
      el.querySelectorAll('.math.cmf-math-selected').forEach((m) => paintMath(m, 'sel'));
    };
    setTimeout(repaint, 300);
    setTimeout(repaint, 1200);
    return comp;
  }

  renderMain(keepScroll) {
    const el = this.mainEl;
    if (!el) return;
    const prevScroll = keepScroll === 'top' ? 0 : keepScroll && this.msgsEl ? this.msgsEl.scrollTop : null;
    this.unloadMd();
    this.msgEls.clear();
    el.empty();
    if (this.mode === 'notes') return this.renderNotesPage(el);
    const node = this.node;

    const head = el.createDiv({ cls: 'cmf-head' });
    const navToggle = head.createDiv({ cls: 'cmf-icon-btn cmf-panel-toggle', attr: { 'aria-label': '展开 / 收起左侧栏' } });
    obsidian.setIcon(navToggle, 'panel-left');
    navToggle.addEventListener('click', () => this.togglePanel('nav'));
    this.navToggleEl = navToggle;
    if (node && node.parentId) {
      const back = head.createDiv({ cls: 'cmf-icon-btn', attr: { 'aria-label': '返回上一层' } });
      obsidian.setIcon(back, 'chevron-left');
      back.addEventListener('click', () => this.openNode(node.parentId));
    }
    const titleEl = head.createDiv({ cls: 'cmf-head-title' });
    if (node) {
      const chain = chainOf(this.session, node.id);
      if (chain.length > 1) titleEl.createDiv({ cls: 'cmf-head-path', text: chain.slice(0, -1).map((n) => truncate(n.title, 12)).join(' › ') });
      titleEl.createDiv({ cls: 'cmf-head-main', text: node.title || '未命名问题' });
    } else {
      titleEl.createDiv({ cls: 'cmf-head-main', text: '新对话' });
    }
    const sideToggle = head.createDiv({ cls: 'cmf-icon-btn cmf-panel-toggle', attr: { 'aria-label': '展开 / 收起右侧栏' } });
    obsidian.setIcon(sideToggle, 'panel-right');
    sideToggle.addEventListener('click', () => this.togglePanel('side'));
    this.sideToggleEl = sideToggle;
    this.applyLayout();

    this.msgsEl = el.createDiv({ cls: 'cmf-msgs' });
    if (!node) {
      const empty = this.msgsEl.createDiv({ cls: 'cmf-empty' });
      empty.createDiv({ cls: 'cmf-empty-title', text: '从一个问题开始' });
      empty.createDiv({ cls: 'cmf-empty-sub', text: '读回答时，划选看不懂的句子就能追问；追问会出现在右侧，并可以无限展开下去。' });
    } else {
      if (node.anchor && node.anchor.text) {
        const a = this.msgsEl.createDiv({ cls: 'cmf-anchor-quote' });
        a.createSpan({ cls: 'cmf-anchor-label', text: '追问自' });
        const q = a.createDiv({ cls: 'cmf-anchor-text markdown-rendered' });
        q.setAttr('aria-label', '回到上一层');
        this.renderMarkdown(q, node.anchor.text.length > 400 ? node.anchor.text.slice(0, 400) + '…' : node.anchor.text);
        q.addEventListener('click', () => this.openNode(node.parentId));
      }
      for (const m of node.messages) this.renderMessage(m);
    }
    this.msgsEl.addEventListener('mouseup', (e) => {
      if (e.button !== 0 || this.compact) return;
      if (e.target instanceof Element && e.target.closest('.is-editing')) return;
      setTimeout(() => this.onSelect(), 10);
    });
    this.msgsEl.addEventListener('scroll', () => {
      if (!this.compact) this.closePop();
    });

    const compWrap = el.createDiv({ cls: 'cmf-composer-wrap' });
    this.replyEl = compWrap.createDiv({ cls: 'cmf-reply' });
    this.attTrayEl = compWrap.createDiv({ cls: 'cmf-att-tray' });
    const comp = compWrap.createDiv({ cls: 'cmf-composer' });
    const attBtn = comp.createDiv({ cls: 'cmf-attach-btn', attr: { 'aria-label': '添加图片或文件（也可以直接粘贴 / 拖进来）' } });
    obsidian.setIcon(attBtn, 'paperclip');
    const fileInput = comp.createEl('input', {
      attr: { type: 'file', multiple: '', accept: 'image/*,.pdf,.txt,.md,.markdown,.csv,.tsv,.json,.xml,.yaml,.yml,.html,.css,.js,.ts,.py,.java,.c,.cpp,.h,.go,.rs,.sql,.tex,.log,.ipynb,.sh,text/*' },
    });
    fileInput.style.display = 'none';
    attBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
      const files = Array.from(fileInput.files || []);
      fileInput.value = '';
      this.addFiles(files);
    });
    this.inputEl = comp.createEl('textarea', {
      cls: 'cmf-input',
      attr: {
        rows: '1',
        placeholder: node
          ? '继续追问…（也可以在回答里划线追问）'
          : `输入你的问题，${this.settings.chatSendKey === 'mod-enter' ? 'Ctrl/Cmd+Enter' : 'Enter'} 发送`,
      },
    });
    this.sendBtn = comp.createDiv({ cls: 'cmf-send' });
    this.inputEl.addEventListener('input', () => this.autoGrow());
    this.inputEl.addEventListener('paste', (e) => {
      const files = e.clipboardData ? Array.from(e.clipboardData.files || []) : [];
      if (!files.length) return;
      e.preventDefault();
      this.addFiles(files);
    });
    el.addEventListener('dragover', (e) => {
      if (!e.dataTransfer || !Array.from(e.dataTransfer.types || []).includes('Files')) return;
      e.preventDefault();
      el.addClass('is-dragover');
    });
    el.addEventListener('dragleave', (e) => {
      if (e.target === el || !el.contains(e.relatedTarget)) el.removeClass('is-dragover');
    });
    el.addEventListener('drop', (e) => {
      el.removeClass('is-dragover');
      const files = e.dataTransfer ? Array.from(e.dataTransfer.files || []) : [];
      if (!files.length) return;
      e.preventDefault();
      this.addFiles(files);
    });
    this.inputEl.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.isComposing) return;
      const modEnter = this.settings.chatSendKey === 'mod-enter';
      const send = modEnter ? e.ctrlKey || e.metaKey : !e.shiftKey && !e.ctrlKey && !e.metaKey;
      if (send) {
        e.preventDefault();
        this.submit();
      }
    });
    this.sendBtn.addEventListener('click', () => {
      if (this.session && this.node && this.chat.isNodeRunning(this.session, this.node)) this.chat.stop(this.session, this.node);
      else this.submit();
    });
    this.renderComposerState();
    this.renderReply();
    this.renderAttTray();
    if (this.pendingFocusMsg) {
      this.applyPendingFocus();
    } else if (prevScroll !== null) {
      const m = this.msgsEl;
      m.scrollTop = prevScroll;
      setTimeout(() => (m.scrollTop = prevScroll), 60);
      setTimeout(() => (m.scrollTop = prevScroll), 300);
    } else this.scrollToBottom(true);
  }

  renderComposerState() {
    if (!this.sendBtn) return;
    const running = this.session && this.node && this.chat.isNodeRunning(this.session, this.node);
    this.sendBtn.empty();
    obsidian.setIcon(this.sendBtn, running ? 'square' : 'arrow-up');
    this.sendBtn.setAttr('aria-label', running ? '停止生成' : '发送');
    this.sendBtn.toggleClass('is-running', !!running);
  }

  autoGrow() {
    const t = this.inputEl;
    t.style.height = 'auto';
    t.style.height = Math.min(t.scrollHeight, 200) + 'px';
  }

  renderMessage(m) {
    const wrap = this.msgsEl.createDiv({ cls: `cmf-msg cmf-msg-${m.role}` });
    wrap.dataset.msg = m.id;
    if (m.role === 'assistant') wrap.createDiv({ cls: 'cmf-ai-badge', text: 'AI' });
    const col = wrap.createDiv({ cls: 'cmf-msg-col' });
    if (m.role === 'user' && m.attachments && m.attachments.length) this.renderMsgAtts(col, m);
    const body = col.createDiv({ cls: 'cmf-msg-body markdown-rendered' });
    body.dataset.msg = m.id;
    body._cmfActions = col.createDiv({ cls: 'cmf-msg-actions' });
    this.msgEls.set(m.id, body);
    wrap.addEventListener('contextmenu', (evt) => this.showMsgMenu(evt, m, body));
    this.fillMessage(m, body);
  }

  /** 消息右键菜单 */
  showMsgMenu(evt, m, body) {
    if (m.pending || body.hasClass('is-editing')) return;
    evt.preventDefault();
    evt.stopPropagation();
    // 划线后追问框会抢走焦点、选区消失，这时用追问框里记着的那段
    const popSel = this.popEl && this.popAnchor ? { anchor: this.popAnchor, rect: this.popRect } : null;
    const sel = this.readSelection() || popSel;
    this.closePop();
    const s = this.session;
    const nodeId = this.nodeId;
    const selInThis = sel && sel.anchor.msgId === m.id ? sel : null;
    const menu = new obsidian.Menu();
    if (selInThis) {
      menu.addItem((i) =>
        i
          .setTitle('追问选中内容')
          .setIcon('message-square-plus')
          .onClick(() => (this.compact ? this.startReply(selInThis.anchor) : this.openPop(selInThis.rect, selInThis.anchor)))
      );
      for (const q of this.presetQuestions()) {
        menu.addItem((i) => i.setTitle(`追问：${truncate(q, 24)}`).setIcon('zap').onClick(() => this.doBranch(selInThis.anchor, q)));
      }
      menu.addSeparator();
      menu.addItem((i) => i.setTitle('记笔记…').setIcon('notebook-pen').onClick(() => this.takeNote(selInThis.anchor)));
      menu.addItem((i) =>
        i
          .setTitle('复制选中内容')
          .setIcon('clipboard-copy')
          .onClick(async () => new Notice((await copyText(selInThis.anchor.text)) ? '已复制' : '复制失败'))
      );
      menu.addSeparator();
    }
    if (m.role === 'assistant') {
      menu.addItem((i) => i.setTitle('编辑回答').setIcon('pencil').onClick(() => this.startEdit(m, body)));
      if (m.originalContent !== undefined && m.originalContent !== m.content) {
        menu.addItem((i) =>
          i
            .setTitle('恢复 AI 原始回答')
            .setIcon('undo-2')
            .onClick(async () => {
              if (await confirmModal(this.app, '恢复原始回答', '放弃你对这条回答的修改，恢复成 AI 最初的回答？', '恢复'))
                this.chat.editMessage(s, nodeId, m.id, m.originalContent);
            })
        );
      }
      menu.addItem((i) =>
        i.setTitle('复制回答（Markdown）').setIcon('copy').onClick(async () => new Notice((await copyText(normalizeMath(m.content))) ? '已复制' : '复制失败'))
      );
      menu.addItem((i) =>
        i
          .setTitle('重新回答')
          .setIcon('refresh-cw')
          .onClick(async () => {
            const msg =
              m.originalContent !== undefined
                ? '重新回答会覆盖你修改过的内容。继续吗？'
                : '用这条之前的对话重新生成这条回答？';
            if (await confirmModal(this.app, '重新回答', msg, '重新回答')) this.chat.regenerate(s, nodeId, m.id);
          })
      );
      menu.addItem((i) => i.setTitle('保存为笔记').setIcon('file-plus').onClick(() => this.chat.saveAsNote(s, nodeId, m.id)));
      menu.addItem((i) => i.setTitle('加入收藏夹…').setIcon('star').onClick(() => this.favoriteRound(m.id)));
      menu.addSeparator();
      menu.addItem((i) =>
        i
          .setTitle('删除这一轮问答')
          .setIcon('trash-2')
          .onClick(async () => {
            if (await confirmModal(this.app, '删除这一轮', '删除这条回答和它前面的提问？基于它的追问卡片会保留。', '删除'))
              this.chat.deleteRound(s, nodeId, m.id);
          })
      );
    } else {
      menu.addItem((i) => i.setTitle('复制问题').setIcon('copy').onClick(async () => new Notice((await copyText(m.content)) ? '已复制' : '复制失败')));
      menu.addItem((i) =>
        i
          .setTitle('编辑后重新发送')
          .setIcon('pencil')
          .onClick(() => {
            this.inputEl.value = m.content;
            this.autoGrow();
            if (m.attachments && m.attachments.length) {
              this.clearAtts();
              this.pendingAtts = m.attachments.map((a) => ({ key: uid(), name: a.name, kind: a.kind === 'image' ? 'image' : 'text', att: a }));
              this.renderAttTray();
            }
            this.inputEl.focus();
          })
      );
      const node = this.node;
      const k = node ? node.messages.findIndex((x) => x.id === m.id) : -1;
      const next = k >= 0 ? node.messages[k + 1] : null;
      if (next && next.role === 'assistant' && !next.pending) {
        menu.addItem((i) => i.setTitle('加入收藏夹…').setIcon('star').onClick(() => this.favoriteRound(next.id)));
      }
    }
    menu.showAtMouseEvent(evt);
  }

  /** 原地编辑一条 AI 回答（Markdown 源码） */
  startEdit(m, body) {
    if (m.pending || body.hasClass('is-editing')) return;
    const s = this.session;
    const nodeId = this.nodeId;
    body.addClass('is-editing');
    if (body._cmfActions) body._cmfActions.empty();
    body.empty();
    const ta = body.createEl('textarea', { cls: 'cmf-edit-input' });
    ta.value = m.content || '';
    const fit = () => {
      ta.style.height = 'auto';
      ta.style.height = Math.min(ta.scrollHeight + 4, Math.max(240, window.innerHeight * 0.6)) + 'px';
    };
    const bar = body.createDiv({ cls: 'cmf-edit-bar' });
    bar.createSpan({ cls: 'cmf-edit-hint', text: this.compact ? '支持 Markdown' : '支持 Markdown · Ctrl/Cmd+Enter 保存 · Esc 取消' });
    const cancel = bar.createEl('button', { text: '取消' });
    const save = bar.createEl('button', { cls: 'mod-cta', text: '保存' });
    const finish = (commit) => {
      body.removeClass('is-editing');
      if (commit && ta.value !== m.content) {
        this.chat.editMessage(s, nodeId, m.id, ta.value);
        new Notice('已保存修改');
      } else {
        this.fillMessage(m, body);
      }
    };
    ta.addEventListener('input', fit);
    ta.addEventListener('keydown', (e) => {
      if (e.isComposing) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        finish(false);
      } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        finish(true);
      }
    });
    cancel.addEventListener('click', () => finish(false));
    save.addEventListener('click', () => finish(true));
    setTimeout(() => {
      fit();
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
    }, 20);
  }

  /** 每条消息下方的操作栏 */
  renderActions(m, bar) {
    if (!bar) return;
    bar.empty();
    if (m.pending) return;
    const s = this.session;
    const nodeId = this.nodeId;
    const act = (icon, label, fn, cls) => {
      const b = bar.createDiv({ cls: 'cmf-act' + (cls ? ' ' + cls : ''), attr: { 'aria-label': label } });
      obsidian.setIcon(b, icon);
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        fn(b);
      });
      return b;
    };
    const copy = async (b) => {
      const ok = await copyText(m.role === 'assistant' ? normalizeMath(m.content) : m.content);
      if (!ok) {
        new Notice('复制失败');
        return;
      }
      obsidian.setIcon(b, 'check');
      setTimeout(() => obsidian.setIcon(b, 'copy'), 1200);
      new Notice('已复制');
    };
    if (m.role === 'user') {
      act('copy', '复制', copy);
      act('pencil', '编辑后重新发送（放回输入框）', () => {
        this.inputEl.value = m.content;
        this.autoGrow();
        if (m.attachments && m.attachments.length) {
          this.clearAtts();
          this.pendingAtts = m.attachments.map((a) => ({ key: uid(), name: a.name, kind: a.kind === 'image' ? 'image' : 'text', att: a }));
          this.renderAttTray();
        }
        this.inputEl.focus();
      });
      return;
    }
    act('copy', '复制（Markdown）', copy);
    act('pencil', '编辑回答（加入自己的理解）', () => this.startEdit(m, bar.parentElement.querySelector('.cmf-msg-body')));
    act('refresh-cw', '重新回答', async () => {
      const kids = childrenOf(s, nodeId).filter((c) => c.anchor && c.anchor.msgId === m.id);
      if (kids.length) {
        const ok = await confirmModal(
          this.app,
          '重新回答',
          `这条回答上有 ${kids.length} 个划线追问。重新回答后追问卡片会保留，但原文高亮可能对不上。继续吗？`,
          '重新回答'
        );
        if (!ok) return;
      }
      this.chat.regenerate(s, nodeId, m.id);
    });
    act('file-plus', '保存为笔记', () => this.chat.saveAsNote(s, nodeId, m.id));
    act('message-square-plus', '继续追问', () => this.inputEl && this.inputEl.focus());
    act(
      'trash-2',
      '删除这一轮问答',
      async () => {
        if (await confirmModal(this.app, '删除这一轮', '删除这条回答和它前面的提问？基于它的追问卡片会保留。', '删除'))
          this.chat.deleteRound(s, nodeId, m.id);
      },
      'is-danger'
    );
    if (this.settings.chatShowMeta) {
      const t = m.doneAt || m.createdAt;
      const chars = (m.content || '').length;
      bar.createSpan({ cls: 'cmf-act-meta', text: [fmtTime(t), m.model, `${chars} 字`].filter(Boolean).join(' · ') });
    }
    if (m.editedAt) {
      const tag = bar.createSpan({ cls: 'cmf-edited-tag', text: '已编辑' });
      tag.setAttr('aria-label', `你在 ${fmtTime(m.editedAt)} 修改过这条回答`);
    }
  }

  async fillMessage(m, body) {
    if (m.role === 'user') {
      body.empty();
      body.createDiv({ text: m.content });
    } else {
      await this.renderMarkdown(body, m.content || '');
      if (m.pending) body.createDiv({ cls: 'cmf-typing', text: m.content ? '' : '思考中…' });
    }
    this.applyHighlights(m.id, body);
    this.renderActions(m, body._cmfActions);
  }

  applyHighlights(msgId, body) {
    if (!this.session || !this.node) return;
    for (const n of this.chat.notes.notesOn(this.session.id, this.node.id, msgId)) {
      for (const mk of highlightAnchor(body, n.anchor, n.id, 'note')) {
        mk.setAttr('aria-label', n.content ? `笔记：${truncate(n.content, 60)}` : '笔记');
        mk.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          this.editNote(n);
        });
      }
    }
    for (const c of childrenOf(this.session, this.node.id)) {
      if (!c.anchor || c.anchor.msgId !== msgId) continue;
      for (const mk of highlightAnchor(body, c.anchor, c.id)) {
        mk.setAttr('aria-label', `追问：${c.title}`);
        mk.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          this.revealCard(c.id);
        });
      }
    }
  }

  updateMessage(msgId, done) {
    const node = this.node;
    if (!node) return;
    const m = node.messages.find((x) => x.id === msgId);
    if (!m) return;
    let body = this.msgEls.get(msgId);
    if (!body) {
      this.renderMessage(m);
      body = this.msgEls.get(msgId);
    }
    const nearBottom = this.isNearBottom();
    this.fillMessage(m, body).then(() => {
      if (nearBottom) this.scrollToBottom();
    });
    if (done) this.renderComposerState();
  }

  isNearBottom() {
    const el = this.msgsEl;
    return !el || el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }

  scrollToBottom(force) {
    const el = this.msgsEl;
    if (!el) return;
    if (force || this.isNearBottom()) setTimeout(() => (el.scrollTop = el.scrollHeight), 0);
  }

  async submit() {
    const text = this.inputEl.value.trim();
    if ((this.pendingAtts || []).some((a) => a.loading)) {
      new Notice('附件还在处理中，请稍等一下');
      return;
    }
    const atts = (this.pendingAtts || []).filter((a) => a.att).map((a) => a.att);
    if (this.replyAnchor && this.session && this.node) {
      const anchor = this.replyAnchor;
      this.replyAnchor = null;
      this.setPending(null);
      this.inputEl.value = '';
      this.autoGrow();
      this.renderReply();
      this.clearAtts();
      this.doBranch(anchor, text, atts);
      return;
    }
    if (!text && !atts.length) return;
    if (this.session && this.node && this.chat.isNodeRunning(this.session, this.node)) return;
    this.inputEl.value = '';
    this.autoGrow();
    this.clearAtts();
    if (!this.session) {
      const s = this.chat.store.create(text || (atts[0] && atts[0].name) || '附件分析');
      this.session = s;
      this.nodeId = s.rootId;
      this.refreshAll();
    }
    this.chat.ask(this.session, this.nodeId, text, atts);
    this.scrollToBottom(true);
  }

  // ── 附件 ───────────────────────────────────────────────
  async addFiles(files) {
    if (!files || !files.length) return;
    if (this.mode === 'notes') return;
    this.pendingAtts = this.pendingAtts || [];
    for (const file of files) {
      const kind = attKind(file);
      if (!kind) {
        new Notice(`暂不支持「${file.name}」这种文件（支持图片、PDF、文本 / Markdown / 代码 / CSV 等）`, 6000);
        continue;
      }
      const item = { key: uid(), name: file.name || (kind === 'image' ? '图片' : '文件'), kind, loading: true };
      if (kind === 'image') {
        try {
          item.preview = URL.createObjectURL(file);
        } catch (_) {}
      }
      this.pendingAtts.push(item);
      this.renderAttTray();
      processUpload(this.chat, file)
        .then((att) => {
          item.att = att;
          item.loading = false;
          this.renderAttTray();
        })
        .catch((e) => {
          new Notice(`「${item.name}」添加失败：${(e && e.message) || e}`, 8000);
          this.removeAtt(item.key);
        });
    }
    if (this.inputEl) this.inputEl.focus();
  }

  removeAtt(key) {
    const it = (this.pendingAtts || []).find((a) => a.key === key);
    if (it && it.preview) URL.revokeObjectURL(it.preview);
    this.pendingAtts = (this.pendingAtts || []).filter((a) => a.key !== key);
    this.renderAttTray();
  }

  clearAtts() {
    for (const a of this.pendingAtts || []) if (a.preview) URL.revokeObjectURL(a.preview);
    this.pendingAtts = [];
    this.renderAttTray();
  }

  renderAttTray() {
    const el = this.attTrayEl;
    if (!el) return;
    el.empty();
    const list = this.pendingAtts || [];
    el.toggleClass('is-active', list.length > 0);
    for (const a of list) {
      const chip = el.createDiv({ cls: 'cmf-att-chip' + (a.loading ? ' is-loading' : '') + (a.kind === 'image' ? ' is-image' : '') });
      if (a.kind === 'image') {
        const src = a.preview || (a.att && this.app.vault.adapter.getResourcePath(a.att.path));
        if (src) chip.createEl('img', { attr: { src, alt: a.name } });
      } else {
        const ic = chip.createSpan({ cls: 'cmf-att-icon' });
        obsidian.setIcon(ic, a.kind === 'pdf' || (a.att && a.att.mime === 'application/pdf') ? 'file-text' : 'file-code');
        const info = chip.createDiv({ cls: 'cmf-att-info' });
        info.createDiv({ cls: 'cmf-att-name', text: a.name });
        const sub = a.loading
          ? '正在读取…'
          : [a.att.pages ? `${a.att.pages} 页` : null, `${(a.att.text || '').length} 字`, a.att.truncated ? '已截断' : null].filter(Boolean).join(' · ');
        info.createDiv({ cls: 'cmf-att-sub', text: sub });
      }
      if (a.loading && a.kind === 'image') chip.createDiv({ cls: 'cmf-att-spin', text: '…' });
      const x = chip.createDiv({ cls: 'cmf-att-x', attr: { 'aria-label': '移除' } });
      obsidian.setIcon(x, 'x');
      x.addEventListener('click', () => this.removeAtt(a.key));
    }
  }

  /** 用户消息里显示的附件（缩略图 / 文件卡片），点击在 Obsidian 里打开 */
  renderMsgAtts(parent, m) {
    const box = parent.createDiv({ cls: 'cmf-msg-atts' });
    const open = (path) => {
      const f = this.app.vault.getAbstractFileByPath(path);
      if (f) this.app.workspace.getLeaf('tab').openFile(f);
      else new Notice('附件文件已经不在了');
    };
    for (const a of m.attachments) {
      if (a.kind === 'image') {
        const img = box.createEl('img', { cls: 'cmf-msg-img', attr: { src: this.app.vault.adapter.getResourcePath(a.path), alt: a.name, 'aria-label': a.name } });
        img.addEventListener('click', () => open(a.path));
      } else {
        const chip = box.createDiv({ cls: 'cmf-att-chip is-sent', attr: { 'aria-label': '在 Obsidian 里打开' } });
        obsidian.setIcon(chip.createSpan({ cls: 'cmf-att-icon' }), a.mime === 'application/pdf' ? 'file-text' : 'file-code');
        const info = chip.createDiv({ cls: 'cmf-att-info' });
        info.createDiv({ cls: 'cmf-att-name', text: a.name });
        info.createDiv({ cls: 'cmf-att-sub', text: [a.pages ? `${a.pages} 页` : null, fmtSize(a.size), a.truncated ? '内容过长已截断' : null].filter(Boolean).join(' · ') });
        chip.addEventListener('click', () => open(a.path));
      }
    }
  }

  // ── 划线追问 ───────────────────────────────────────────
  /** 读取当前选区；在主窗口某条消息里时返回 {anchor, rect} */
  readSelection() {
    if (!this.node || !this.msgsEl) return null;
    const sel = document.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    const range = sel.getRangeAt(0);
    let el = range.commonAncestorContainer;
    if (el.nodeType !== 1) el = el.parentElement;
    const body = el && el.closest('.cmf-msg-body');
    if (!body || !this.msgsEl.contains(body) || body.hasClass('is-editing')) return null;
    const src = selectionToSource(range);
    if (!src.text) return null;
    const anchor = { text: src.text, msgId: body.dataset.msg };
    if (src.plain && src.plain !== src.text) anchor.plain = src.plain;
    return { anchor, range, rect: range.getBoundingClientRect() };
  }

  onSelect() {
    const r = this.readSelection();
    if (!r) return;
    this.openPop(r.rect, r.anchor);
    this.setPending(r.range);
  }

  /** 手机 / 窄屏：长按选字后，在底部显示「追问选中内容」按钮（不挡系统的复制菜单） */
  onSelectionChange() {
    this.updateMathSelection();
    if (!this.compact || this.popEl) return;
    clearTimeout(this.selTimer);
    this.selTimer = setTimeout(() => {
      const r = this.readSelection();
      if (r) {
        this.pendingSelRange = r.range.cloneRange();
        this.showPill(r.anchor);
      }
      else this.hidePill();
    }, 300);
  }

  updateMathSelection() {
    if (!this.msgsEl) return;
    const sel = document.getSelection();
    let range = null;
    if (sel && sel.rangeCount && !sel.isCollapsed) {
      const r = sel.getRangeAt(0);
      if (this.msgsEl.contains(r.commonAncestorContainer) || r.intersectsNode(this.msgsEl)) range = r;
    }
    if (!range && this.pendingRange && this.msgsEl.contains(this.pendingRange.commonAncestorContainer)) range = this.pendingRange;
    markSelectedMath(this.msgsEl, range);
  }

  /** 记住正在追问的那段选区（弹窗 / 引用打开期间保持高亮） */
  setPending(range) {
    this.pendingRange = range ? range.cloneRange() : null;
    setPendingHighlight(this.pendingRange);
    this.updateMathSelection();
  }

  showPill(anchor) {
    this.pendingAnchor = anchor;
    if (!this.pillEl) {
      this.pillEl = this.mainEl.createDiv({ cls: 'cmf-pill' });
      const part = (icon, text, fn) => {
        const b = this.pillEl.createDiv({ cls: 'cmf-pill-btn' });
        obsidian.setIcon(b.createSpan(), icon);
        b.createSpan({ text });
        b.addEventListener('pointerdown', (e) => e.preventDefault());
        b.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          const a = this.pendingAnchor;
          if (a) fn(a);
        });
      };
      part('message-square-plus', '追问', (a) => {
        this.hidePill();
        this.startReply(a);
      });
      this.pillEl.createDiv({ cls: 'cmf-pill-sep' });
      part('notebook-pen', '笔记', (a) => {
        this.hidePill();
        this.takeNote(a);
      });
      this.pillEl.createDiv({ cls: 'cmf-pill-sep' });
      part('copy', '复制', async (a) => {
        new Notice((await copyText(a.text)) ? '已复制' : '复制失败');
        this.hidePill();
        const sel = document.getSelection();
        if (sel) sel.removeAllRanges();
      });
    }
  }

  hidePill() {
    if (this.pillEl) {
      this.pillEl.remove();
      this.pillEl = null;
    }
  }

  openPop(rect, anchor) {
    this.closePop();
    this.popAnchor = anchor;
    this.popRect = rect;
    const pop = document.body.createDiv({ cls: 'cmf-pop' });
    pop.createDiv({ cls: 'cmf-pop-label', text: '追问：' });
    const input = pop.createEl('input', {
      cls: 'cmf-pop-input',
      attr: { type: 'text', placeholder: `什么是「${truncate(anchor.text, 12)}」？（留空 = 详细解释）` },
    });
    const presets = this.presetQuestions();
    if (presets.length) {
      const chips = pop.createDiv({ cls: 'cmf-preset-chips' });
      for (const q of presets) {
        const c = chips.createDiv({ cls: 'cmf-preset-chip', text: q, attr: { 'aria-label': '用这个问题追问' } });
        c.addEventListener('click', () => {
          this.closePop();
          this.doBranch(anchor, q);
        });
      }
    }
    const row = pop.createDiv({ cls: 'cmf-pop-row' });
    const copy = row.createEl('button', { cls: 'cmf-pop-copy', attr: { 'aria-label': '复制选中内容（含公式）' } });
    obsidian.setIcon(copy.createSpan(), 'copy');
    copy.createSpan({ text: '复制' });
    copy.addEventListener('click', async () => {
      const ok = await copyText(anchor.text);
      new Notice(ok ? '已复制' : '复制失败');
      this.closePop();
    });
    const noteBtn = row.createEl('button', { cls: 'cmf-pop-copy', attr: { 'aria-label': '给这段写笔记' } });
    obsidian.setIcon(noteBtn.createSpan(), 'notebook-pen');
    noteBtn.createSpan({ text: '笔记' });
    noteBtn.addEventListener('click', () => {
      this.closePop();
      this.takeNote(anchor);
    });
    const send = row.createEl('button', { cls: 'cmf-pop-send mod-cta', text: '发送追问' });
    if (this.compact || !rect) {
      // 手机：底部弹出
      pop.addClass('is-sheet');
      pop.prepend(createDiv({ cls: 'cmf-pop-quote', text: `「${truncate(anchor.text, 60)}」` }));
    } else {
      const w = 300;
      const left = Math.min(Math.max(8, rect.left + rect.width / 2 - w / 2), window.innerWidth - w - 8);
      const top = rect.bottom + 140 < window.innerHeight ? rect.bottom + 8 : Math.max(8, rect.top - 130);
      pop.style.left = `${left}px`;
      pop.style.top = `${top}px`;
      pop.style.width = `${w}px`;
    }
    const go = () => {
      const q = input.value;
      this.closePop();
      this.doBranch(anchor, q);
    };
    input.addEventListener('keydown', (e) => {
      if (e.isComposing) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        go();
      } else if (e.key === 'Escape') this.closePop();
    });
    send.addEventListener('click', go);
    this.popEl = pop;
    if (!pop.hasClass('is-sheet') && rect) {
      const h = pop.offsetHeight || 140;
      const top = rect.bottom + h + 16 < window.innerHeight ? rect.bottom + 8 : Math.max(8, rect.top - h - 8);
      pop.style.top = `${top}px`;
    }
    setTimeout(() => input.focus(), 20);
  }

  /** 新建划线追问并在右侧显示 */
  doBranch(anchor, q, attachments) {
    this.setPending(null);
    const s = document.getSelection();
    if (s) s.removeAllRanges();
    const childId = this.chat.branch(this.session, this.nodeId, anchor, q, attachments);
    this.sideTab = 'follow';
    this.expanded.add(childId);
    this.renderMain(true);
    this.renderSide();
    setTimeout(() => this.revealCard(childId, true), 30);
    if (this.compact) {
      if (this.inputEl) this.inputEl.blur();
      this.openDrawer('side');
    }
  }

  /** 手机：把选中的原文作为「引用」挂在主输入框上方，直接用主输入框追问（不会被键盘挡住） */
  startReply(anchor) {
    this.replyAnchor = anchor;
    if (this.pendingSelRange) this.setPending(this.pendingSelRange);
    this.pendingSelRange = null;
    this.renderReply();
    const sel = document.getSelection();
    if (sel) sel.removeAllRanges();
    if (this.inputEl) {
      this.inputEl.focus();
      setTimeout(() => this.inputEl && this.inputEl.scrollIntoView({ block: 'nearest' }), 300);
    }
  }

  renderReply() {
    const el = this.replyEl;
    if (!el) return;
    el.empty();
    const a = this.replyAnchor;
    el.toggleClass('is-active', !!a);
    if (this.inputEl) {
      this.inputEl.setAttr(
        'placeholder',
        a ? `针对这段追问…（留空 = ${this.settings.defaultFollowUp || '详细解释'}）` : this.node ? '继续追问…（也可以在回答里划线追问）' : '输入你的问题'
      );
    }
    if (!a) return;
    const icon = el.createSpan({ cls: 'cmf-reply-icon' });
    obsidian.setIcon(icon, 'corner-down-right');
    el.createSpan({ cls: 'cmf-reply-label', text: '追问' });
    el.createSpan({ cls: 'cmf-reply-text', text: `「${truncate(a.text, 40)}」` });
    const x = el.createSpan({ cls: 'cmf-reply-x', attr: { 'aria-label': '取消追问' } });
    obsidian.setIcon(x, 'x');
    x.addEventListener('click', () => {
      this.replyAnchor = null;
      this.setPending(null);
      this.renderReply();
    });
    const presets = this.presetQuestions();
    if (presets.length) {
      const chips = el.createDiv({ cls: 'cmf-preset-chips is-reply' });
      for (const q of presets) {
        const c = chips.createDiv({ cls: 'cmf-preset-chip', text: q });
        c.addEventListener('pointerdown', (e) => e.preventDefault());
        c.addEventListener('click', () => {
          if (!this.inputEl) return;
          this.inputEl.value = q;
          this.submit();
        });
      }
    }
    if (this.sendBtn) this.sendBtn.addClass('is-reply');
  }

  closePop() {
    if (this.popEl) {
      this.popEl.remove();
      this.popEl = null;
      if (!this.replyAnchor) this.setPending(null);
    }
  }

  // ── 右侧栏：追问卡片 / 问答树 ──────────────────────────
  scheduleSide() {
    if (this.sideTimer) return;
    this.sideTimer = setTimeout(() => {
      this.sideTimer = null;
      this.updateCards();
    }, 150);
  }

  renderSide() {
    const el = this.sideEl;
    if (!el) return;
    el.empty();
    this.cardEls.clear();
    const tabs = el.createDiv({ cls: 'cmf-tabs' });
    const tab = (id, icon, text) => {
      const t = tabs.createDiv({ cls: 'cmf-tab' + (this.sideTab === id ? ' is-active' : '') });
      obsidian.setIcon(t.createSpan(), icon);
      t.createSpan({ text });
      t.addEventListener('click', () => {
        this.sideTab = id;
        this.renderSide();
      });
    };
    tab('tree', 'git-fork', '问答树');
    tab('follow', 'messages-square', '追问');
    const body = el.createDiv({ cls: 'cmf-side-body' });
    this.sideBody = body;
    if (!this.session || !this.node) {
      body.createDiv({ cls: 'cmf-side-empty', text: '开始对话后，追问会以卡片的形式出现在这里。' });
      return;
    }
    if (this.sideTab === 'tree') this.renderTree(body);
    else this.renderCards(body);
  }

  renderCards(body) {
    const kids = childrenOf(this.session, this.nodeId);
    if (!kids.length) {
      body.createDiv({ cls: 'cmf-side-empty', text: '在左边的回答里划选一段文字，就能针对它追问。' });
      return;
    }
    for (const c of kids) {
      const card = body.createDiv({ cls: 'cmf-card' });
      this.cardEls.set(c.id, card);
      // 点击卡片 → 这个追问替换为主窗口；折叠按钮只展开 / 收起预览
      card.addEventListener('click', (e) => {
        if (e.target.closest('.cmf-card-fold, .cmf-card-del, .cmf-card-preview, .cmf-card-go')) return;
        this.openNode(c.id);
      });
      this.fillCard(c, card);
    }
  }

  fillCard(c, card) {
    const s = this.session;
    const open = this.expanded.has(c.id);
    card.empty();
    card.toggleClass('is-open', open);
    const head = card.createDiv({ cls: 'cmf-card-head' });
    const t = head.createDiv({ cls: 'cmf-card-title', text: c.title || '追问' });
    t.setAttr('aria-label', '在主窗口打开');
    const fold = head.createDiv({ cls: 'cmf-icon-btn cmf-card-fold', attr: { 'aria-label': open ? '收起' : '展开预览' } });
    obsidian.setIcon(fold, open ? 'chevron-up' : 'chevron-down');
    const del = head.createDiv({ cls: 'cmf-icon-btn cmf-card-del', attr: { 'aria-label': '删除这个追问' } });
    obsidian.setIcon(del, 'x');
    const running = this.chat.isNodeRunning(s, c);
    const kidsN = childrenOf(s, c.id).length;
    card.createDiv({
      cls: 'cmf-card-meta',
      text: `${fmtTime(c.createdAt)}${running ? ' · 生成中…' : ''}${kidsN ? ` · ${kidsN} 个追问` : ''}`,
    });
    const ans = lastAnswer(c);
    if (open) {
      const prev = card.createDiv({ cls: 'cmf-card-preview markdown-rendered' });
      this.renderMarkdown(prev, (ans && ans.content) || '思考中…');
      const go = card.createDiv({ cls: 'cmf-card-go', text: '进入这个对话 →' });
      go.addEventListener('click', () => this.openNode(c.id));
    } else {
      card.createDiv({ cls: 'cmf-card-snippet', text: ans && ans.content ? plainExcerpt(ans.content, 70) : running ? '思考中…' : '' });
    }
    fold.addEventListener('click', (e) => {
      e.stopPropagation();
      if (open) this.expanded.delete(c.id);
      else this.expanded.add(c.id);
      this.fillCard(c, card);
    });
    del.addEventListener('click', async (e) => {
      e.stopPropagation();
      const n = subtreeIds(s, c.id).length;
      const msg = n > 1 ? `确认删除「${c.title}」及其下的 ${n - 1} 个追问？` : `确认删除「${c.title}」？`;
      if (await confirmModal(this.app, '删除追问', msg, '删除')) this.chat.deleteNode(s, c.id);
    });
  }

  updateCards() {
    if (!this.session || !this.node) return;
    if (this.sideTab === 'tree') {
      this.renderSide();
      return;
    }
    const kids = childrenOf(this.session, this.nodeId);
    if (kids.length !== this.cardEls.size) {
      this.renderSide();
      return;
    }
    for (const c of kids) {
      const card = this.cardEls.get(c.id);
      if (!card) continue;
      const scroll = card.querySelector('.cmf-card-preview');
      const st = scroll ? scroll.scrollTop : 0;
      this.fillCard(c, card);
      const ns = card.querySelector('.cmf-card-preview');
      if (ns) ns.scrollTop = st;
    }
  }

  revealCard(childId, quiet) {
    if (this.compact && this.drawer !== 'side') this.openDrawer('side');
    this.sideTab = 'follow';
    this.expanded.add(childId);
    this.renderSide();
    const card = this.cardEls.get(childId);
    if (!card) return;
    card.scrollIntoView({ block: 'nearest', behavior: quiet ? 'auto' : 'smooth' });
    card.addClass('is-flash');
    setTimeout(() => card.removeClass('is-flash'), 900);
  }

  renderTree(body) {
    const s = this.session;
    const path = new Set(chainOf(s, this.nodeId).map((n) => n.id));
    body.createDiv({ cls: 'cmf-tree-pos', text: `当前位于第 ${chainOf(s, this.nodeId).length} 层 · 点任一问题可跳转` });
    const list = body.createDiv({ cls: 'cmf-tree' });

    /** 把一个窗口的消息拆成「一轮一问」 */
    const roundsOf = (node) => {
      const out = [];
      let cur = null;
      for (const m of node.messages) {
        if (m.role === 'user') {
          cur = { user: m, ids: [m.id] };
          out.push(cur);
        } else if (cur) {
          cur.ids.push(m.id);
          cur = null;
        } else {
          out.push({ user: null, ids: [m.id] });
        }
      }
      if (!out.length) out.push({ user: null, ids: [] });
      return out;
    };

    /**
     * 渲染一个窗口：窗口里的每个问题是同级的（1、2、3…）；
     * 从某个回答里划线追问出来的窗口，挂在那个问题下面（1.1、1.2…）。
     * 返回这个窗口占用的同级编号数量。
     */
    const renderWindow = (node, prefix, start, depth) => {
      const rounds = roundsOf(node);
      const kidsBy = new Map();
      for (const c of childrenOf(s, node.id)) {
        let idx = c.anchor ? rounds.findIndex((r) => r.ids.includes(c.anchor.msgId)) : -1;
        if (idx < 0) idx = rounds.length - 1;
        if (!kidsBy.has(idx)) kidsBy.set(idx, []);
        kidsBy.get(idx).push(c);
      }
      const running = this.chat.isNodeRunning(s, node);
      rounds.forEach((r, i) => {
        const label = `${prefix}${start + i + 1}`;
        const isCur = node.id === this.nodeId;
        const item = list.createDiv({
          cls: 'cmf-tree-item' + (isCur ? ' is-current' : path.has(node.id) ? ' is-path' : '') + (i > 0 ? ' is-followup' : ''),
        });
        item.style.paddingLeft = `${8 + depth * 16}px`;
        item.createSpan({ cls: 'cmf-tree-dot' });
        item.createSpan({ cls: 'cmf-tree-num', text: label });
        const main = item.createDiv({ cls: 'cmf-tree-main' });
        const line = main.createDiv({ cls: 'cmf-tree-line' });
        const question = (r.user && r.user.content) || node.title || '未命名问题';
        if (i === 0 && node.anchor && node.anchor.text) {
          line.createSpan({ cls: 'cmf-tree-mark', text: truncate(node.anchor.text, 16) });
        }
        line.createSpan({ cls: 'cmf-tree-title', text: truncate(question, 60) });
        if (running && i === rounds.length - 1) item.createSpan({ cls: 'cmf-tree-run', text: '…' });
        item.setAttr(
          'aria-label',
          (i === 0 && node.anchor && node.anchor.text ? `划线「${node.anchor.text}」\n` : '') + question
        );
        item.addEventListener('click', () => {
          if (r.user) this.focusMessage(node.id, r.user.id);
          else this.openNode(node.id);
        });
        let k = 0;
        for (const c of kidsBy.get(i) || []) k += renderWindow(c, `${label}.`, k, depth + 1);
      });
      return rounds.length;
    };
    renderWindow(s.nodes[s.rootId], '', 0, 0);

    const gen = body.createDiv({ cls: 'cmf-card-go cmf-tree-gen', text: '生成 Canvas 总览图 →' });
    gen.addEventListener('click', () => this.chat.generateOverview(s));
  }

  /** 打开某个窗口并滚动到其中一条消息 */
  presetQuestions() {
    const arr = this.settings.presetQuestions;
    return Array.isArray(arr) ? arr.map((q) => String(q || '').trim()).filter(Boolean) : [];
  }

  /** 左侧栏：点哪个就切到哪个（历史 / 收藏夹 / 笔记） */
  switchNav(which) {
    if (which === 'notes') {
      if (this.mode !== 'notes') {
        this.mode = 'notes';
        this.closePop();
        this.renderMain();
      }
    } else {
      this.navMode = which;
      if (this.mode === 'notes') {
        this.mode = 'chat';
        this.renderMain('top');
      }
    }
    this.renderNav();
    this.app.workspace.requestSaveLayout();
  }

  // ── 想法笔记 ───────────────────────────────────────────
  async takeNote(anchor) {
    const s = this.session;
    const node = this.node;
    if (!s || !node || !anchor) return;
    const sel = document.getSelection();
    if (sel) sel.removeAllRanges();
    this.setPending(null);
    const notes = this.chat.notes;
    await notes.load();
    const n = await openNoteEditor(this.app, notes, {
      anchor,
      folderId: this.lastNoteFolder,
      ctx: { sessionId: s.id, nodeId: node.id, msgId: anchor.msgId, sessionTitle: s.title, nodeTitle: node.title },
    });
    if (!n) return;
    this.lastNoteFolder = n.folderId;
    new Notice('已记笔记');
    this.chat.emit({ type: 'notes', sessionId: s.id, nodeId: node.id });
  }

  async editNote(n) {
    const r = await openNoteEditor(this.app, this.chat.notes, { note: n });
    if (r) this.chat.emit({ type: 'notes', sessionId: n.sessionId, nodeId: n.nodeId });
  }

  async openNoteSource(n) {
    this.closeDrawers();
    const s = await this.chat.store.get(n.sessionId);
    if (!s) return new Notice('原对话已被删除');
    const node = s.nodes[n.nodeId];
    if (!node) return new Notice('原来的窗口已被删除');
    this.pendingFocusNote = n.id;
    this.pendingFocusMsg = node.messages.some((m) => m.id === n.msgId) ? n.msgId : null;
    if (!this.pendingFocusMsg) {
      this.pendingFocusNote = null;
      new Notice('那条回答已被删除，打开所在窗口');
    }
    if (this.session && this.session.id === s.id) {
      this.mode = 'chat';
      this.nodeId = node.id;
      this.expanded.clear();
      this.renderNav();
      this.renderMain('top');
      this.renderSide();
    } else await this.openSession(s.id, node.id);
  }

  async renderNoteNav(el, tok) {
    const notes = this.chat.notes;
    await notes.load();
    if (tok !== this.navTok) return;
    if (!this.notesKey || (this.notesKey !== 'all' && this.notesKey !== 'none' && !notes.folder(this.notesKey))) this.notesKey = 'all';
    const head = el.createDiv({ cls: 'cmf-nav-label cmf-fav-head' });
    head.createSpan({ text: '笔记' });
    const tools = head.createSpan({ cls: 'cmf-fav-tools' });
    const tool = (icon, label, fn) => {
      const t = tools.createSpan({ cls: 'cmf-fav-tool', attr: { 'aria-label': label } });
      obsidian.setIcon(t, icon);
      t.addEventListener('click', (e) => {
        e.stopPropagation();
        fn();
      });
    };
    const newFolder = async (parentId) => {
      const name = await promptText(this.app, parentId ? `在「${notes.folder(parentId).name}」里新建文件夹` : '新建笔记文件夹', '文件夹名称');
      if (!name) return;
      const f = notes.addFolder(name, parentId);
      this.notesKey = f.id;
      this.renderNav();
      this.renderMain();
    };
    tool('folder-plus', '新建文件夹', () => newFolder(this.notesKey !== 'all' && this.notesKey !== 'none' ? this.notesKey : null));
    tool('message-square', '返回对话', () => {
      this.mode = 'chat';
      this.renderNav();
      this.renderMain('top');
    });

    const listEl = el.createDiv({ cls: 'cmf-fav' });
    const select = (key) => {
      this.notesKey = key;
      this.closeDrawers();
      this.renderNav();
      this.renderMain();
    };
    const fixed = (key, icon, name, n) => {
      const r = listEl.createDiv({ cls: 'cmf-fav-row cmf-note-nav' + (this.notesKey === key ? ' is-active' : '') });
      obsidian.setIcon(r.createSpan({ cls: 'cmf-fav-icon' }), icon);
      r.createSpan({ cls: 'cmf-fav-name', text: name });
      if (n) r.createSpan({ cls: 'cmf-fav-count', text: String(n) });
      r.addEventListener('click', () => select(key));
    };
    fixed('all', 'notebook', '全部笔记', notes.data.items.length);
    fixed('none', 'inbox', '未分类', notes.list('none').length);

    const folderMenu = (evt, f) => {
      evt.preventDefault();
      evt.stopPropagation();
      const menu = new obsidian.Menu();
      menu.addItem((i) => i.setTitle('新建子文件夹').setIcon('folder-plus').onClick(() => newFolder(f.id)));
      menu.addItem((i) =>
        i
          .setTitle('重命名')
          .setIcon('pencil')
          .onClick(async () => {
            const name = await promptText(this.app, '重命名文件夹', '文件夹名称', f.name);
            if (!name) return;
            notes.renameFolder(f.id, name);
            this.renderNav();
            this.renderMain();
          })
      );
      menu.addItem((i) =>
        i
          .setTitle('移动到…')
          .setIcon('folder-input')
          .onClick(async () => {
            const to = await pickFolder(this.app, notes, {
              title: `移动「${f.name}」到`,
              okText: '移动',
              exclude: f.id,
              allowRoot: true,
              selected: f.parentId || '',
            });
            if (to === null) return;
            notes.moveFolder(f.id, to || null);
            this.renderNav();
            this.renderMain();
          })
      );
      menu.addItem((i) =>
        i
          .setTitle('删除文件夹')
          .setIcon('trash')
          .onClick(async () => {
            const n = notes.count(f.id);
            const msg = n ? `删除「${f.name}」及其子文件夹？里面的 ${n} 条笔记会移到「未分类」，不会被删除。` : `删除「${f.name}」？`;
            if (!(await confirmModal(this.app, '删除文件夹', msg, '删除'))) return;
            notes.removeFolder(f.id);
            if (this.notesKey === f.id) this.notesKey = 'all';
            this.renderNav();
            this.renderMain();
          })
      );
      menu.showAtMouseEvent(evt);
    };

    if (notes.data.folders.length) listEl.createDiv({ cls: 'cmf-note-nav-sep', text: '文件夹' });
    const walk = (parentId, depth) => {
      for (const f of notes.children(parentId)) {
        const kids = notes.children(f.id).length;
        const row = listEl.createDiv({
          cls: 'cmf-fav-row cmf-fav-folder' + (f.collapsed ? ' is-collapsed' : '') + (this.notesKey === f.id ? ' is-active' : ''),
        });
        row.style.paddingLeft = `${6 + depth * 14}px`;
        const chev = row.createSpan({ cls: 'cmf-fav-chev' + (kids ? '' : ' is-leaf') });
        obsidian.setIcon(chev, 'chevron-down');
        chev.addEventListener('click', (e) => {
          e.stopPropagation();
          if (!kids) return;
          f.collapsed = !f.collapsed;
          notes.save();
          this.renderNav();
        });
        obsidian.setIcon(row.createSpan({ cls: 'cmf-fav-icon' }), this.notesKey === f.id ? 'folder-open' : 'folder');
        row.createSpan({ cls: 'cmf-fav-name', text: f.name });
        const n = notes.count(f.id);
        if (n) row.createSpan({ cls: 'cmf-fav-count', text: String(n) });
        const more = row.createSpan({ cls: 'cmf-fav-more', attr: { 'aria-label': '更多' } });
        obsidian.setIcon(more, 'more-horizontal');
        more.addEventListener('click', (e) => folderMenu(e, f));
        row.addEventListener('click', () => select(f.id));
        row.addEventListener('contextmenu', (e) => folderMenu(e, f));
        if (!f.collapsed) walk(f.id, depth + 1);
      }
    };
    walk(null, 0);
  }

  renderNotesPage(el) {
    const notes = this.chat.notes;
    this.msgsEl = null;
    this.inputEl = null;
    this.sendBtn = null;
    this.replyEl = null;
    if (!notes.data) {
      notes.load().then(() => this.mode === 'notes' && this.renderMain());
      return;
    }
    const key = this.notesKey || 'all';
    const title = key === 'all' ? '全部笔记' : key === 'none' ? '未分类' : notes.pathName(key) || '全部笔记';

    const head = el.createDiv({ cls: 'cmf-head' });
    const navToggle = head.createDiv({ cls: 'cmf-icon-btn cmf-panel-toggle', attr: { 'aria-label': '展开 / 收起左侧栏' } });
    obsidian.setIcon(navToggle, 'panel-left');
    navToggle.addEventListener('click', () => this.togglePanel('nav'));
    this.navToggleEl = navToggle;
    const titleEl = head.createDiv({ cls: 'cmf-head-title' });
    titleEl.createDiv({ cls: 'cmf-head-path', text: '笔记' });
    titleEl.createDiv({ cls: 'cmf-head-main', text: title });
    const sideToggle = head.createDiv({ cls: 'cmf-icon-btn cmf-panel-toggle', attr: { 'aria-label': '展开 / 收起右侧栏' } });
    obsidian.setIcon(sideToggle, 'panel-right');
    sideToggle.addEventListener('click', () => this.togglePanel('side'));
    this.sideToggleEl = sideToggle;
    this.applyLayout();

    const page = el.createDiv({ cls: 'cmf-msgs cmf-notes' });
    const all = notes.list(key);
    const bar = page.createDiv({ cls: 'cmf-notes-bar' });
    const search = bar.createEl('input', { cls: 'cmf-notes-search', attr: { type: 'search', placeholder: `在 ${all.length} 条笔记里搜索…` } });
    search.value = this.notesQuery || '';
    const listEl = page.createDiv({ cls: 'cmf-notes-list' });

    const renderList = () => {
      for (const c of this.notesComps || []) c.unload();
      this.notesComps = [];
      listEl.empty();
      const q = (this.notesQuery || '').trim().toLowerCase();
      const shown = q
        ? all.filter((n) => [n.content, n.anchor && n.anchor.text, n.sessionTitle, n.nodeTitle].some((x) => String(x || '').toLowerCase().includes(q)))
        : all;
      if (!shown.length) {
        const empty = listEl.createDiv({ cls: 'cmf-empty' });
        empty.createDiv({ cls: 'cmf-empty-title', text: q ? '没有匹配的笔记' : '这里还没有笔记' });
        if (!q) empty.createDiv({ cls: 'cmf-empty-sub', text: '在对话的回答里划选一段文字，右键「记笔记…」（或在划线弹窗里点「笔记」），写下看到这句话时的想法。' });
        return;
      }
      for (const n of shown) this.renderNoteCard(listEl, n, key === 'all' || key === 'none' ? true : n.folderId !== key);
    };
    search.addEventListener('input', () => {
      this.notesQuery = search.value;
      renderList();
    });
    renderList();
  }

  renderNoteCard(parent, n, showFolder) {
    const notes = this.chat.notes;
    const card = parent.createDiv({ cls: 'cmf-note-card' });
    const quote = card.createDiv({ cls: 'cmf-note-quote markdown-rendered' });
    this.notesComps.push(renderMdInto(this.app, quote, n.anchor ? n.anchor.text : ''));
    const body = card.createDiv({ cls: 'cmf-note-body markdown-rendered' });
    if (n.content) this.notesComps.push(renderMdInto(this.app, body, n.content));
    else body.createDiv({ cls: 'cmf-note-blank', text: '（没有写想法，点 ✏️ 补充）' });

    const foot = card.createDiv({ cls: 'cmf-note-foot' });
    const from = foot.createDiv({ cls: 'cmf-note-src', attr: { 'aria-label': '跳转到当时划线的对话' } });
    obsidian.setIcon(from.createSpan({ cls: 'cmf-note-src-icon' }), 'corner-up-left');
    const t = [n.sessionTitle, n.nodeTitle && n.nodeTitle !== n.sessionTitle ? n.nodeTitle : null].filter(Boolean).join(' › ');
    from.createSpan({ text: truncate(t || '原对话', 40) });
    const meta = foot.createDiv({ cls: 'cmf-note-meta' });
    if (showFolder && n.folderId && notes.folder(n.folderId)) {
      const chip = meta.createSpan({ cls: 'cmf-note-chip' });
      obsidian.setIcon(chip.createSpan(), 'folder');
      chip.createSpan({ text: notes.folder(n.folderId).name });
    }
    meta.createSpan({ text: fmtTime(n.updatedAt || n.addedAt) });
    const acts = foot.createDiv({ cls: 'cmf-note-acts' });
    const act = (icon, label, fn) => {
      const b = acts.createDiv({ cls: 'cmf-icon-btn', attr: { 'aria-label': label } });
      obsidian.setIcon(b, icon);
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        fn();
      });
    };
    const move = async () => {
      const to = await pickFolder(this.app, notes, { title: '移动笔记到', okText: '移动', allowRoot: true, rootLabel: '未分类', selected: n.folderId || '' });
      if (to === null) return;
      notes.updateNote(n.id, { folderId: to || null });
      this.chat.emit({ type: 'notes' });
    };
    const del = async () => {
      if (!(await confirmModal(this.app, '删除笔记', '删除这条笔记？此操作不可撤销。', '删除'))) return;
      notes.data.items = notes.data.items.filter((x) => x.id !== n.id);
      notes.save();
      this.chat.emit({ type: 'notes' });
    };
    act('pencil', '编辑笔记', () => this.editNote(n));
    act('folder-input', '移动到文件夹', move);
    act('copy', '复制（Markdown）', async () => {
      const md = `> ${String(n.anchor ? n.anchor.text : '').replace(/\n/g, '\n> ')}\n\n${n.content || ''}`;
      new Notice((await copyText(md)) ? '已复制' : '复制失败');
    });
    act('trash-2', '删除笔记', del);

    card.addEventListener('click', (e) => {
      if (e.target instanceof Element && e.target.closest('a, .cmf-icon-btn')) return;
      if ((document.getSelection() || {}).isCollapsed === false) return;
      this.openNoteSource(n);
    });
    card.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const menu = new obsidian.Menu();
      menu.addItem((i) => i.setTitle('跳转到原对话').setIcon('corner-up-left').onClick(() => this.openNoteSource(n)));
      menu.addItem((i) => i.setTitle('编辑笔记').setIcon('pencil').onClick(() => this.editNote(n)));
      menu.addItem((i) => i.setTitle('移动到文件夹…').setIcon('folder-input').onClick(move));
      menu.addSeparator();
      menu.addItem((i) => i.setTitle('删除笔记').setIcon('trash-2').onClick(del));
      menu.showAtMouseEvent(e);
    });
  }

  // ── 收藏夹 ─────────────────────────────────────────────
  /** 收藏当前窗口里的一轮问答（msgId = AI 回答） */
  favoriteRound(msgId) {
    const s = this.session;
    const node = this.node;
    if (!s || !node) return;
    const i = node.messages.findIndex((x) => x.id === msgId);
    if (i < 0) return;
    const q = i > 0 && node.messages[i - 1].role === 'user' ? node.messages[i - 1].content : node.title;
    this.chat.addToFavorites({ type: 'qa', sessionId: s.id, nodeId: node.id, msgId, title: truncate(q || node.title || '问答', 60) });
  }

  async openFavItem(it) {
    this.closeDrawers();
    const s = await this.chat.store.get(it.sessionId);
    if (!s) return new Notice('这个对话已被删除');
    if (it.type === 'qa') {
      const node = s.nodes[it.nodeId];
      if (!node) return new Notice('这个窗口已被删除');
      if (!node.messages.some((m) => m.id === it.msgId)) new Notice('这条回答已被删除，打开所在窗口');
      else this.pendingFocusMsg = it.msgId;
      if (this.session && this.session.id === s.id) {
        if (this.nodeId === node.id) this.applyPendingFocus();
        else this.openNode(node.id);
        this.renderNav();
      } else await this.openSession(s.id, node.id);
    } else await this.openSession(s.id);
  }

  async renderFavs(el, tok) {
    const fav = this.chat.fav;
    await fav.load();
    if (tok !== this.navTok) return;
    const head = el.createDiv({ cls: 'cmf-nav-label cmf-fav-head' });
    head.createSpan({ text: '收藏夹' });
    const tools = head.createSpan({ cls: 'cmf-fav-tools' });
    const tool = (icon, label, fn) => {
      const t = tools.createSpan({ cls: 'cmf-fav-tool', attr: { 'aria-label': label } });
      obsidian.setIcon(t, icon);
      t.addEventListener('click', (e) => {
        e.stopPropagation();
        fn();
      });
    };
    const newFolder = async (parentId) => {
      const name = await promptText(this.app, parentId ? `在「${fav.folder(parentId).name}」里新建收藏夹` : '新建收藏夹', '收藏夹名称');
      if (!name) return;
      fav.addFolder(name, parentId);
      this.renderNav();
    };
    tool('folder-plus', '新建收藏夹', () => newFolder(null));
    tool('layout-dashboard', '全部收藏夹生成 Canvas', () => {
      if (!fav.data.folders.length) return new Notice('还没有收藏夹');
      this.chat.exportFolderCanvas(null);
    });
    tool('history', '返回历史', () => {
      this.navMode = 'history';
      this.renderNav();
    });

    const listEl = el.createDiv({ cls: 'cmf-fav' });
    if (!fav.data.folders.length) {
      const empty = listEl.createDiv({ cls: 'cmf-hist-empty' });
      empty.setText('还没有收藏夹。点右上角 + 新建，或在回答 / 历史对话上右键「加入收藏夹」。');
      return;
    }

    const folderMenu = (evt, f) => {
      evt.preventDefault();
      evt.stopPropagation();
      const menu = new obsidian.Menu();
      menu.addItem((i) => i.setTitle('新建子收藏夹').setIcon('folder-plus').onClick(() => newFolder(f.id)));
      menu.addItem((i) =>
        i
          .setTitle('加入已有对话…')
          .setIcon('message-square-plus')
          .onClick(async () => {
            const s = await pickSession(this.app, await this.chat.store.list());
            if (!s) return;
            const r = fav.addItem(f.id, { type: 'session', sessionId: s.id, title: s.title || '未命名对话' });
            f.collapsed = false;
            new Notice(r.existed ? '这个对话已经在收藏夹里了' : `已加入「${f.name}」`);
            this.renderNav();
          })
      );
      menu.addItem((i) => i.setTitle('生成 Canvas').setIcon('layout-dashboard').onClick(() => this.chat.exportFolderCanvas(f.id)));
      menu.addSeparator();
      menu.addItem((i) =>
        i
          .setTitle('重命名')
          .setIcon('pencil')
          .onClick(async () => {
            const name = await promptText(this.app, '重命名收藏夹', '收藏夹名称', f.name);
            if (!name) return;
            fav.renameFolder(f.id, name);
            this.renderNav();
          })
      );
      menu.addItem((i) =>
        i
          .setTitle('移动到…')
          .setIcon('folder-input')
          .onClick(async () => {
            const to = await pickFolder(this.app, fav, { title: `移动「${f.name}」到`, okText: '移动', exclude: f.id, allowRoot: true, selected: f.parentId || '' });
            if (to === null) return;
            fav.moveFolder(f.id, to || null);
            this.renderNav();
          })
      );
      menu.addItem((i) =>
        i
          .setTitle('删除收藏夹')
          .setIcon('trash')
          .onClick(async () => {
            const n = fav.count(f.id);
            const msg = n ? `删除「${f.name}」及其子收藏夹？里面的 ${n} 条收藏会被移除（对话本身不受影响）。` : `删除「${f.name}」？`;
            if (!(await confirmModal(this.app, '删除收藏夹', msg, '删除'))) return;
            fav.removeFolder(f.id);
            this.renderNav();
          })
      );
      menu.showAtMouseEvent(evt);
    };

    const itemMenu = (evt, it) => {
      evt.preventDefault();
      evt.stopPropagation();
      const menu = new obsidian.Menu();
      menu.addItem((i) => i.setTitle('打开').setIcon('external-link').onClick(() => this.openFavItem(it)));
      menu.addItem((i) =>
        i
          .setTitle('移动到…')
          .setIcon('folder-input')
          .onClick(async () => {
            const to = await pickFolder(this.app, fav, { title: '移动到收藏夹', okText: '移动', selected: it.folderId });
            if (!to) return;
            fav.moveItem(it.id, to);
            this.renderNav();
          })
      );
      menu.addItem((i) =>
        i
          .setTitle('移出收藏夹')
          .setIcon('star-off')
          .onClick(() => {
            fav.removeItem(it.id);
            this.renderNav();
          })
      );
      menu.showAtMouseEvent(evt);
    };

    const curMsgIds = new Set(this.node ? this.node.messages.map((m) => m.id) : []);
    const walk = (parentId, depth) => {
      for (const f of fav.children(parentId)) {
        const row = listEl.createDiv({ cls: 'cmf-fav-row cmf-fav-folder' + (f.collapsed ? ' is-collapsed' : '') });
        row.style.paddingLeft = `${6 + depth * 14}px`;
        const chev = row.createSpan({ cls: 'cmf-fav-chev' });
        obsidian.setIcon(chev, 'chevron-down');
        obsidian.setIcon(row.createSpan({ cls: 'cmf-fav-icon' }), f.collapsed ? 'folder' : 'folder-open');
        row.createSpan({ cls: 'cmf-fav-name', text: f.name });
        const n = fav.count(f.id);
        if (n) row.createSpan({ cls: 'cmf-fav-count', text: String(n) });
        const more = row.createSpan({ cls: 'cmf-fav-more', attr: { 'aria-label': '更多' } });
        obsidian.setIcon(more, 'more-horizontal');
        more.addEventListener('click', (e) => folderMenu(e, f));
        row.addEventListener('click', () => {
          f.collapsed = !f.collapsed;
          fav.save();
          this.renderNav();
        });
        row.addEventListener('contextmenu', (e) => folderMenu(e, f));
        if (f.collapsed) continue;
        walk(f.id, depth + 1);
        for (const it of fav.itemsIn(f.id)) {
          const active =
            it.type === 'qa'
              ? this.session && this.session.id === it.sessionId && curMsgIds.has(it.msgId)
              : this.session && this.session.id === it.sessionId;
          const r = listEl.createDiv({ cls: 'cmf-fav-row cmf-fav-item' + (active ? ' is-active' : '') });
          r.style.paddingLeft = `${6 + (depth + 1) * 14 + 16}px`;
          obsidian.setIcon(r.createSpan({ cls: 'cmf-fav-icon' }), it.type === 'qa' ? 'message-square' : 'messages-square');
          r.createSpan({ cls: 'cmf-fav-name', text: it.title || (it.type === 'qa' ? '问答' : '对话') });
          r.setAttr('aria-label', it.type === 'qa' ? `问答：${it.title}` : `整个对话：${it.title}`);
          r.addEventListener('click', () => this.openFavItem(it));
          r.addEventListener('contextmenu', (e) => itemMenu(e, it));
        }
      }
    };
    walk(null, 0);
  }

  focusMessage(nodeId, msgId) {
    this.pendingFocusMsg = msgId;
    if (nodeId !== this.nodeId) {
      this.openNode(nodeId);
    } else {
      this.closeDrawers();
      this.applyPendingFocus();
    }
  }

  applyPendingFocus() {
    const msgId = this.pendingFocusMsg;
    if (!msgId) return;
    this.pendingFocusMsg = null;
    const tryScroll = (n) => {
      const el = this.msgsEl && this.msgsEl.querySelector(`.cmf-msg[data-msg="${msgId}"]`);
      if (!el) {
        if (n > 0) setTimeout(() => tryScroll(n - 1), 80);
        return;
      }
      const noteId = this.pendingFocusNote;
      this.pendingFocusNote = null;
      const marks = noteId ? Array.from(el.querySelectorAll(`[data-note="${noteId}"]`)) : [];
      const target = marks.length ? marks : [el];
      target[0].scrollIntoView({ block: marks.length ? 'center' : 'start', behavior: 'smooth' });
      for (const t of target) t.addClass('is-flash');
      setTimeout(() => target.forEach((t) => t.removeClass('is-flash')), 1600);
    };
    // 等 Markdown 渲染完再滚动
    setTimeout(() => tryScroll(10), 150);
  }
}

module.exports._chat = { highlightAnchor, markSelectedMath, paintMath, normalizeMath, buildThreadMessages, chainOf, childrenOf, subtreeIds, highlightInEl };
