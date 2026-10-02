'use strict';
/*
 * Canvas Mindflow — 在 Obsidian Canvas 卡片里直接和 AI 对话
 *
 * 设计要点
 * - 一张原生文字卡片 = 一轮问答：问题写在卡片正文，回答写在同一张卡片里的
 *   可折叠 callout（> [!ai]+ 回答）。Markdown / LaTeX / 代码高亮全部交给
 *   Obsidian 原生渲染；卡片大小可自由拖拽；数据就是普通 .canvas 文件。
 * - 划选回答中的文字 → 按 Tab 或点「✦ 追问」→ 在右侧生成子卡片，带上原文
 *   锚点（> [!excerpt] 原文）并立即回答。
 * - 上下文 = 沿连线向上的所有祖先卡片（按拓扑顺序），较远的回答自动截断；
 *   连到卡片上的笔记文件卡片也会作为资料送给 AI。
 */

const obsidian = require('obsidian');
const { Plugin, PluginSettingTab, Setting, Notice, requestUrl } = obsidian;

// ─────────────────────────────────────────────────────────────
// 设置
// ─────────────────────────────────────────────────────────────
const DEFAULT_SETTINGS = {
  apiBaseUrl: 'https://api.deepseek.com/v1',
  apiKey: '',
  model: 'deepseek-chat',
  temperature: 0.7,
  systemPrompt:
    '你是一位耐心、严谨的学习伙伴。默认用简体中文回答，结构清晰，善用 Markdown（小标题、列表、表格、代码块、LaTeX 公式）。先用一两句话给出核心结论，再展开说明。',
  answerTitle: '回答',
  excerptTitle: '原文',
  nodeWidth: 460,
  maxAutoHeight: 640,
  maxExpandHeight: 900,
  expandWidth: 640,
  maxExpandWidth: 960,
  edgeLabel: false,
  highlightExcerpt: true,
  debug: false,
  chatFolder: 'Mindflow',
  fullContextDepth: 3,
  truncateChars: 600,
  maxAncestors: 20,
  includeNoteFiles: true,
  noteCharLimit: 6000,
  enableTab: true,
  maxTokens: 0,
  // 对话视图
  chatNavWidth: 210,
  chatSideWidth: 320,
  chatNavCollapsed: false,
  chatSideCollapsed: false,
  chatFontSize: 15,
  chatSendKey: 'enter',
  chatShowMeta: true,
  defaultFollowUp: '请详细解释这段内容。',
  noteFolder: '',
  // 划线追问的预设问题（右键 / 追问小窗里一键选择）
  presetQuestions: ['请详细解释这段内容。', '能举一个具体的例子吗？', '这个公式是怎么推导出来的？', '用通俗易懂的话再讲一遍。', '这和前面的内容有什么联系？'],
  // 附件
  visionModel: '',
  attachMaxChars: 40000,
};

const DEFAULT_SYSTEM_PROMPT = DEFAULT_SETTINGS.systemPrompt;

/** 常用 OpenAI 兼容服务商 */
const PROVIDERS = [
  { id: 'deepseek', name: 'DeepSeek', url: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { id: 'openai', name: 'OpenAI', url: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  { id: 'moonshot', name: 'Kimi（Moonshot）', url: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
  { id: 'qwen', name: '通义千问（阿里云百炼）', url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  { id: 'zhipu', name: '智谱 GLM', url: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
  { id: 'siliconflow', name: '硅基流动 SiliconFlow', url: 'https://api.siliconflow.cn/v1', model: 'deepseek-ai/DeepSeek-V3' },
  { id: 'openrouter', name: 'OpenRouter', url: 'https://openrouter.ai/api/v1', model: 'openai/gpt-4o-mini' },
  { id: 'ollama', name: 'Ollama（本地）', url: 'http://localhost:11434/v1', model: 'qwen2.5' },
];


// ─────────────────────────────────────────────────────────────
// 划线文字 → 保留公式与符号的源码
// Obsidian 渲染公式（MathJax）时符号是用 CSS 画的，DOM 里没有对应文字，
// 直接 selection.toString() 会把公式和 ×、≥、上下标等符号全部丢掉。
// 做法：渲染后给每个 .math 元素记下它的 LaTeX 源码，划线时再换回 $…$。
// ─────────────────────────────────────────────────────────────
/** 按出现顺序提取 Markdown 里的公式（跳过代码） */
function extractMath(md) {
  const src = String(md || '')
    .replace(/^>\s?/gm, '')
    .replace(/(```|~~~)[\s\S]*?\1/g, '')
    .replace(/`[^`\n]*`/g, '');
  const out = [];
  const re = /\$\$([\s\S]+?)\$\$|\$(?!\s)([^$\n]*?[^\s$\\])\$(?!\d)|\$(?!\s)([^$\s\\])\$(?!\d)/g;
  let m;
  while ((m = re.exec(src))) {
    if (m[1] !== undefined) out.push({ tex: m[1].trim(), display: true });
    else out.push({ tex: (m[2] !== undefined ? m[2] : m[3]).trim(), display: false });
  }
  return out;
}

/** 给渲染好的公式元素标上源码；数量对不上时尽量按显示/行内分别对齐 */
function annotateMath(root, md) {
  if (!root) return;
  const els = Array.from(root.querySelectorAll('.math'));
  if (!els.length) return;
  const list = extractMath(md);
  if (list.length === els.length) {
    els.forEach((el, i) => {
      el.dataset.tex = list[i].tex;
      el.dataset.display = list[i].display ? '1' : '';
    });
    return;
  }
  const blocks = list.filter((x) => x.display);
  const inlines = list.filter((x) => !x.display);
  let bi = 0;
  let ii = 0;
  for (const el of els) {
    const isBlock = el.classList.contains('math-block');
    const item = isBlock ? blocks[bi++] : inlines[ii++];
    if (item) {
      el.dataset.tex = item.tex;
      el.dataset.display = isBlock ? '1' : '';
    }
  }
}

function blockText(node) {
  let out = '';
  node.childNodes.forEach((ch) => {
    if (ch.nodeType === 3) {
      out += ch.nodeValue;
      return;
    }
    if (ch.nodeType !== 1) return;
    const tag = ch.tagName;
    if (tag === 'BR') {
      out += '\n';
      return;
    }
    const block = /^(P|DIV|LI|H[1-6]|TR|BLOCKQUOTE|PRE|UL|OL|TABLE|THEAD|TBODY)$/.test(tag);
    if (block && out && !out.endsWith('\n')) out += '\n';
    out += blockText(ch);
    if (tag === 'TD' || tag === 'TH') out += ' ';
    if (block && !out.endsWith('\n')) out += '\n';
  });
  return out;
}

/**
 * 把一个选区转换成「源码文字」：公式换回 $LaTeX$；同时返回不含公式的纯文本（用于定位高亮）。
 * 选区只覆盖公式的一部分时，自动扩展到整个公式。
 */
function selectionToSource(range) {
  const r = range.cloneRange();
  const mathOf = (n) => {
    const e = n && (n.nodeType === 1 ? n : n.parentElement);
    return e ? e.closest('.math') : null;
  };
  const sm = mathOf(r.startContainer);
  if (sm) r.setStartBefore(sm);
  const em = mathOf(r.endContainer);
  if (em) r.setEndAfter(em);
  const build = (withMath) => {
    const div = document.createElement('div');
    div.appendChild(r.cloneContents());
    div.querySelectorAll('.copy-code-button, button, .cmf-typing').forEach((x) => x.remove());
    div.querySelectorAll('.math').forEach((el) => {
      let t = '';
      if (withMath) {
        const tex = el.dataset.tex;
        if (tex != null && tex !== '') t = el.dataset.display ? `$$${tex}$$` : `$${tex}$`;
        else {
          const mml = el.querySelector('mjx-assistive-mml, math');
          t = mml ? mml.textContent : '';
        }
      }
      el.replaceWith(document.createTextNode(t));
    });
    return blockText(div)
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  };
  return { text: build(true), plain: build(false), range: r };
}

// ─────────────────────────────────────────────────────────────
// 卡片文本格式：解析 / 生成
// ─────────────────────────────────────────────────────────────
const AI_HEAD_RE = /^>\s?\[!ai\]([+-]?)(.*)$/i;
const EXCERPT_HEAD_RE = /^>\s?\[!excerpt\][+-]?(.*)$/i;

function quoteBlock(text) {
  return String(text)
    .split('\n')
    .map((l) => (l.length ? '> ' + l : '>'))
    .join('\n');
}

function unquote(line) {
  return line.replace(/^>\s?/, '');
}

/** 把卡片文本拆成 { excerpt, question, answer, folded, trailing } */
function parseNodeText(text) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  let i = 0;
  let excerpt = null;
  let start = 0;
  while (start < lines.length && !lines[start].trim()) start++;
  if (start < lines.length && EXCERPT_HEAD_RE.test(lines[start])) {
    const ex = [];
    i = start + 1;
    while (i < lines.length && /^>/.test(lines[i])) {
      ex.push(unquote(lines[i]));
      i++;
    }
    excerpt = ex.join('\n').trim();
  }
  let aiIdx = -1;
  for (let k = i; k < lines.length; k++) {
    if (AI_HEAD_RE.test(lines[k])) {
      aiIdx = k;
      break;
    }
  }
  let question = lines.slice(i, aiIdx >= 0 ? aiIdx : lines.length).join('\n').trim();
  // 新格式：原文与问题同一行 ——「==原文== 问题」
  if (!excerpt) {
    const m = /^==([^\n]+?)==\s*/.exec(question);
    if (m) {
      excerpt = m[1].trim();
      question = question.slice(m[0].length).trim();
    }
  }
  let answer = null;
  let folded = false;
  let trailing = '';
  if (aiIdx >= 0) {
    folded = AI_HEAD_RE.exec(lines[aiIdx])[1] === '-';
    const a = [];
    let j = aiIdx + 1;
    while (j < lines.length && /^>/.test(lines[j])) {
      a.push(unquote(lines[j]));
      j++;
    }
    answer = a.join('\n').trim();
    trailing = lines.slice(j).join('\n').trim();
  }
  return { excerpt, question, answer, folded, trailing };
}

/** 由结构生成卡片文本 */
function buildNodeText(p, opts) {
  const parts = [];
  if (p.excerpt) {
    const ex = String(p.excerpt).replace(/\s*\n\s*/g, ' ').replace(/==/g, '').trim();
    parts.push(`==${ex}== ${p.question || ''}`.trim());
  } else if (p.question) {
    parts.push(p.question);
  }
  if (p.answer !== null && p.answer !== undefined) {
    parts.push(`> [!ai]${p.folded ? '-' : '+'} ${opts.answerTitle}\n` + quoteBlock(p.answer || '…'));
  }
  if (p.trailing) parts.push(p.trailing);
  return parts.join('\n\n');
}

/** 切换折叠标记；顺带清理旧版本残留的「· 生成中…」 */
function setFoldedInText(text, folded) {
  return String(text).replace(/^(>\s?\[!ai\])[+-]?([^\n]*)$/im, (m, head, title) => {
    return `${head}${folded ? '-' : '+'}${title.replace(/\s*·\s*生成中…?\s*$/, '')}`;
  });
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 在卡片源码中把划选的文字包上 ==高亮==。
 * 划选到的是渲染后的文字，源码里可能夹着 **、`、_ 等标记，所以先精确匹配，
 * 不行再做宽松匹配；代码块里的内容、已经高亮过的内容会跳过。
 * 返回新文本；找不到时返回 null。
 */
function highlightInText(text, selection) {
  const segs = String(selection)
    .split(/\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2);
  let out = String(text);
  let changed = false;
  const inCodeOrMark = (src, idx) => {
    const before = src.slice(0, idx);
    const fences = (before.match(/^(>\s?)*\s*(```|~~~)/gm) || []).length;
    const marks = (before.match(/==/g) || []).length;
    return fences % 2 === 1 || marks % 2 === 1;
  };
  for (const seg of segs) {
    const head = out.search(/^>\s?\[!ai\]/im);
    const starts = head >= 0 ? [head, 0] : [0];
    const exact = new RegExp(escapeRe(seg), 'g');
    const loose = new RegExp(
      Array.from(seg)
        .map((ch) => (/\s/.test(ch) ? '\\s+' : escapeRe(ch)))
        .join('[*_`~]*'),
      'g'
    );
    let hit = null;
    for (const re of [exact, loose]) {
      for (const from of starts) {
        re.lastIndex = from;
        let m;
        while ((m = re.exec(out))) {
          if (!m[0].includes('==') && !m[0].includes('\n') && !inCodeOrMark(out, m.index)) {
            hit = { index: m.index, len: m[0].length };
            break;
          }
          re.lastIndex = m.index + 1;
        }
        if (hit) break;
      }
      if (hit) break;
    }
    if (!hit) continue;
    // 向两侧吞掉紧挨着的格式符号，避免 ==…== 与 **…** 交叉
    while (hit.index > 0 && /[*_`~]/.test(out[hit.index - 1])) {
      hit.index--;
      hit.len++;
    }
    while (/[*_`~]/.test(out[hit.index + hit.len] || '')) hit.len++;
    out = out.slice(0, hit.index) + '==' + out.slice(hit.index, hit.index + hit.len) + '==' + out.slice(hit.index + hit.len);
    changed = true;
  }
  return changed ? out : null;
}

function formatQuestion(p) {
  const q = (p.question || '').trim();
  if (p.excerpt) {
    return `关于上文中的这段内容：\n「${p.excerpt}」\n\n${q || '请详细解释这段内容。'}`;
  }
  return q;
}

function truncate(s, n) {
  s = String(s).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n) + '…' : s;
}

// ─────────────────────────────────────────────────────────────
// 上下文：沿连线收集祖先卡片
// ─────────────────────────────────────────────────────────────
/**
 * 返回 [{node, dist}]，父先子后（拓扑序）。只保留距离最近的 maxN 个祖先。
 * data 为 canvas.getData() 的结果：{ nodes: [...], edges: [...] }
 */
function collectAncestors(data, targetId, maxN) {
  const byId = new Map(data.nodes.map((n) => [n.id, n]));
  const parentsOf = (id) => data.edges.filter((e) => e.toNode === id).map((e) => e.fromNode);
  const pos = (id) => byId.get(id) || { x: 0, y: 0 };
  const byPos = (a, b) => pos(a).y - pos(b).y || pos(a).x - pos(b).x;

  const dist = new Map();
  const queue = [];
  for (const p of parentsOf(targetId)) {
    if (p !== targetId && !dist.has(p)) {
      dist.set(p, 1);
      queue.push(p);
    }
  }
  while (queue.length) {
    const c = queue.shift();
    for (const p of parentsOf(c)) {
      if (p === targetId || dist.has(p)) continue;
      dist.set(p, dist.get(c) + 1);
      queue.push(p);
    }
  }
  const kept = new Set(
    [...dist.entries()].sort((a, b) => a[1] - b[1]).slice(0, maxN).map((e) => e[0])
  );
  const order = [];
  const seen = new Set();
  const visit = (id) => {
    if (seen.has(id) || !kept.has(id)) return;
    seen.add(id);
    for (const p of parentsOf(id).filter((x) => kept.has(x)).sort(byPos)) visit(p);
    order.push(id);
  };
  for (const p of parentsOf(targetId).filter((x) => kept.has(x)).sort(byPos)) visit(p);
  return order.map((id) => ({ node: byId.get(id), dist: dist.get(id) })).filter((x) => x.node);
}

function mergeSameRole(msgs) {
  const out = [];
  for (const m of msgs) {
    const last = out[out.length - 1];
    if (last && last.role === m.role && m.role !== 'system') {
      last.content += '\n\n' + m.content;
      if (m._images) last._images = (last._images || []).concat(m._images);
    } else {
      const o = { role: m.role, content: m.content };
      if (m._images) o._images = m._images.slice();
      out.push(o);
    }
  }
  return out;
}

/** readNote(path) → Promise<{name, content}|null>，用于读取笔记文件卡片 */
async function buildMessages(settings, data, targetId, targetText, readNote) {
  const msgs = [];
  if (settings.systemPrompt && settings.systemPrompt.trim()) {
    msgs.push({ role: 'system', content: settings.systemPrompt.trim() });
  }
  for (const { node, dist } of collectAncestors(data, targetId, settings.maxAncestors)) {
    if (node.type === 'text') {
      const p = parseNodeText(node.text);
      if (p.answer !== null) {
        const q = formatQuestion(p);
        if (q) msgs.push({ role: 'user', content: q });
        if (p.answer) {
          let a = p.answer;
          if (dist > settings.fullContextDepth && a.length > settings.truncateChars) {
            a = a.slice(0, settings.truncateChars) + '\n…（较早的回答，已截断）';
          }
          msgs.push({ role: 'assistant', content: a });
        }
      } else if ((node.text || '').trim()) {
        msgs.push({ role: 'user', content: `【背景资料】\n${node.text.trim()}` });
      }
    } else if (node.type === 'file' && settings.includeNoteFiles && readNote) {
      const note = await readNote(node.file);
      if (note && note.content.trim()) {
        let c = note.content;
        if (c.length > settings.noteCharLimit) c = c.slice(0, settings.noteCharLimit) + '\n…（已截断）';
        msgs.push({ role: 'user', content: `【笔记《${note.name}》】\n${c}` });
      }
    } else if (node.type === 'link' && node.url) {
      msgs.push({ role: 'user', content: `【参考链接】${node.url}` });
    }
  }
  msgs.push({ role: 'user', content: formatQuestion(parseNodeText(targetText)) });
  // 保证 system 之后第一条是 user
  const merged = mergeSameRole(msgs);
  const firstNonSys = merged.findIndex((m) => m.role !== 'system');
  if (firstNonSys >= 0 && merged[firstNonSys].role === 'assistant') {
    merged.splice(firstNonSys, 0, { role: 'user', content: '（继续之前的讨论）' });
  }
  return merged;
}

// ─────────────────────────────────────────────────────────────
// OpenAI 兼容接口（流式）
// ─────────────────────────────────────────────────────────────
function chatUrl(settings) {
  return settings.apiBaseUrl.trim().replace(/\/+$/, '') + '/chat/completions';
}

function headers(settings) {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${settings.apiKey.trim()}` };
}

function requestBody(settings, messages, stream) {
  const body = { model: settings.model, messages, temperature: Number(settings.temperature), stream };
  const mt = parseInt(settings.maxTokens, 10);
  if (mt > 0) body.max_tokens = mt;
  return body;
}

/** 读取服务商的模型列表（GET /models） */
async function fetchModels(settings) {
  const res = await requestUrl({
    url: settings.apiBaseUrl.trim().replace(/\/+$/, '') + '/models',
    method: 'GET',
    headers: headers(settings),
    throw: false,
  });
  if (res.status >= 400) throw new Error(`HTTP ${res.status} ${String(res.text || '').slice(0, 200)}`);
  const list = (res.json && (res.json.data || res.json.models)) || [];
  return list.map((m) => (typeof m === 'string' ? m : m.id || m.name)).filter(Boolean).sort();
}

async function completeOnce(settings, messages, extra) {
  const res = await requestUrl({
    url: chatUrl(settings),
    method: 'POST',
    headers: headers(settings),
    body: JSON.stringify(Object.assign(requestBody(settings, messages, false), extra || {})),
    throw: false,
  });
  if (res.status >= 400) throw new Error(`HTTP ${res.status} ${String(res.text || '').slice(0, 300)}`);
  const j = res.json;
  return (j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
}

async function streamChat(settings, messages, onDelta, signal) {
  const body = requestBody(settings, messages, true);
  let res;
  try {
    res = await fetch(chatUrl(settings), { method: 'POST', headers: headers(settings), body: JSON.stringify(body), signal });
  } catch (e) {
    if (e && e.name === 'AbortError') throw e;
    // 某些接口不允许浏览器跨域：退回非流式请求
    onDelta(await completeOnce(settings, messages));
    return;
  }
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${t.slice(0, 300)}`);
  }
  if (!res.body) {
    onDelta(await completeOnce(settings, messages));
    return;
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const d = line.slice(5).trim();
      if (d === '[DONE]') return;
      try {
        const j = JSON.parse(d);
        const c = j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content;
        if (c) onDelta(c);
      } catch (_) {
        /* 忽略不完整行 */
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────
// Canvas 内部 API 小工具（Obsidian 未公开，做了防御式调用）
//
// 重要：canvas.setData() 之后 Obsidian 可能会用新的对象替换卡片，
// 所以所有异步流程都只记卡片 id，每次操作前用 liveNode() 重新取。
// ─────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));

function genId() {
  let s = '';
  const c = 'abcdef0123456789';
  for (let i = 0; i < 16; i++) s += c[Math.floor(Math.random() * c.length)];
  return s;
}

function liveNode(canvas, id) {
  return (canvas && canvas.nodes && canvas.nodes.get && canvas.nodes.get(id)) || null;
}

function nodeData(node) {
  try {
    return node.getData() || {};
  } catch (_) {
    return {};
  }
}

function isTextNode(node) {
  const d = nodeData(node);
  return d.type === 'text' || (d.type === undefined && typeof node.text === 'string');
}

function getNodeText(node) {
  if (typeof node.text === 'string') return node.text;
  return nodeData(node).text || '';
}

function setNodeText(node, text) {
  if (typeof node.setText === 'function') node.setText(text);
  else patchNode(node, { text });
}

/** 修改卡片数据（尺寸 / 自定义字段），文本以 node.text 为准，避免被旧数据覆盖 */
function patchNode(node, patch) {
  const next = Object.assign({}, nodeData(node));
  if (typeof node.text === 'string' && !('text' in patch)) next.text = node.text;
  for (const k of Object.keys(patch)) {
    if (patch[k] === undefined) delete next[k];
    else next[k] = patch[k];
  }
  if (next.width) next.width = Math.round(next.width);
  if (next.height) next.height = Math.round(next.height);
  node.setData(next);
}

function isEditing(node) {
  return !!(node.isEditing || (node.nodeEl && node.nodeEl.querySelector('.cm-editor')));
}

function selectedNodes(canvas) {
  const out = [];
  if (!canvas || !canvas.selection) return out;
  for (const item of canvas.selection) {
    if (item && liveNode(canvas, item.id) === item) out.push(item);
  }
  return out;
}

function addEdges(canvas, fromIds, toId, label) {
  const data = canvas.getData();
  for (const fromId of fromIds) {
    data.edges.push({
      id: genId(),
      fromNode: fromId,
      fromSide: 'right',
      toNode: toId,
      toSide: 'left',
      toEnd: 'arrow',
      label: label || undefined,
    });
  }
  canvas.setData(data);
}

function answerBlockOf(node) {
  const content = node.contentEl || (node.nodeEl && node.nodeEl.querySelector('.canvas-node-content'));
  if (!content) return null;
  const callout = content.querySelector('.callout[data-callout="ai"]');
  if (!callout) return null;
  const sizer = content.querySelector('.markdown-preview-sizer');
  let block = callout;
  while (block.parentElement && block.parentElement !== sizer) block = block.parentElement;
  return block.parentElement === sizer ? block : callout;
}

/** 回答里横向放不下的内容（表格、代码块、公式、图片）还差多少宽度（画布坐标） */
function measureOverflowX(node) {
  const block = answerBlockOf(node);
  if (!block) return 0;
  let extra = Math.max(0, block.scrollWidth - block.clientWidth);
  for (const el of block.querySelectorAll('table, pre, .math-block, mjx-container[display="true"], img, .table-wrapper')) {
    extra = Math.max(extra, el.scrollWidth - el.clientWidth);
    const parent = el.parentElement;
    if (parent) extra = Math.max(extra, el.scrollWidth - parent.clientWidth);
  }
  return extra;
}

/**
 * 测量卡片内容完整显示需要的高度（画布坐标，不受缩放影响）。
 * 回答区在卡片内单独滚动，所以用 问题区高度 + 回答区 scrollHeight 计算。
 */
function measureNodeHeight(node) {
  const nodeEl = node.nodeEl;
  const content = node.contentEl || (nodeEl && nodeEl.querySelector('.canvas-node-content'));
  if (!nodeEl || !content) return null;
  const nodeRect = nodeEl.getBoundingClientRect();
  const scale = node.height ? nodeRect.height / node.height : 1;
  if (!scale || !isFinite(scale)) return null;
  const view = content.querySelector('.markdown-preview-view') || content;
  const sizer = content.querySelector('.markdown-preview-sizer') || view;
  const scrolled = (view.scrollTop || 0) * scale;
  const padB = parseFloat(getComputedStyle(view).paddingBottom) || 0;
  const block = answerBlockOf(node);
  let bottom = 0; // 相对卡片顶部、画布坐标
  if (block && block.parentElement === sizer) {
    // 回答块被 flex 拉伸占满剩余空间，所以不能用它的高度，要量里面 callout 的真实高度
    const callout = block.querySelector('.callout[data-callout="ai"]') || block;
    const cr = callout.getBoundingClientRect();
    const cs = getComputedStyle(callout);
    const bs = getComputedStyle(block);
    bottom =
      (cr.top - nodeRect.top + scrolled + (block.scrollTop || 0) * scale + cr.height) / scale +
      (parseFloat(cs.marginBottom) || 0) +
      (parseFloat(bs.paddingBottom) || 0);
    let sib = block.nextElementSibling;
    while (sib) {
      bottom += sib.getBoundingClientRect().height / scale;
      sib = sib.nextElementSibling;
    }
  } else {
    for (const child of Array.from(sizer.children)) {
      const r = child.getBoundingClientRect();
      if (r.height > 0) bottom = Math.max(bottom, (r.bottom - nodeRect.top + scrolled) / scale);
    }
  }
  if (!bottom) return null;
  return bottom + padB + 14;
}

// ─────────────────────────────────────────────────────────────
// 插件主体
// ─────────────────────────────────────────────────────────────
class CanvasMindflowPlugin extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.running = new Map(); // nodeId -> AbortController
    this.prevSizes = new Map(); // nodeId -> 展开前的尺寸
    this.selInfo = null;
    this.selBtn = null;
    this.popover = null;

    this.addSettingTab(new MindflowSettingTab(this.app, this));
    this.registerCommands();
    this.registerMenus();
    this.chat = new MindflowChat(this);
    this.chat.load();

    this.registerDomEvent(document, 'selectionchange', () => this.onSelectionChange());
    this.registerDomEvent(window, 'keydown', (e) => this.onKeyDown(e), { capture: true });
    this.registerDomEvent(window, 'pointerdown', (e) => this.onPointerDown(e), { capture: true });
    this.registerDomEvent(window, 'mousedown', (e) => this.onPointerDown(e), { capture: true });
    this.registerDomEvent(window, 'click', (e) => this.onClick(e), { capture: true });
    this.registerDomEvent(window, 'wheel', (e) => this.onWheel(e), { capture: true, passive: true });
    this.registerEvent(
      this.app.workspace.on('active-leaf-change', () => {
        this.closeAll();
        setTimeout(() => this.migrateAll(), 300);
      })
    );
    this.app.workspace.onLayoutReady(() => setTimeout(() => this.migrateAll(), 500));
    this.dbg('load', { version: this.manifest.version });
  }

  onunload() {
    if (this.chat) this.chat.unload();
    for (const c of this.running.values()) c.abort();
    this.closeAll();
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  // ── 调试日志（写到插件目录 debug.log）──────────────────────
  dbg(tag, obj) {
    if (!this.settings.debug) return;
    try {
      const line = JSON.stringify({ t: new Date().toISOString().slice(11, 23), tag, ...(obj || {}) }) + '\n';
      const path = `${this.app.vault.configDir}/plugins/${this.manifest.id}/debug.log`;
      this._dbgQueue = (this._dbgQueue || Promise.resolve()).then(() => this.app.vault.adapter.append(path, line)).catch(() => {});
    } catch (_) {}
  }

  elPath(el) {
    const out = [];
    let e = el;
    for (let i = 0; e && i < 12; i++, e = e.parentElement) {
      out.push(e.tagName.toLowerCase() + (e.className && typeof e.className === 'string' ? '.' + e.className.trim().split(/\s+/).join('.') : '') + (e.dataset && e.dataset.callout ? `[callout=${e.dataset.callout}]` : ''));
      if (e.classList && e.classList.contains('canvas-node')) break;
    }
    return out;
  }

  inspect(canvas, node) {
    const protoNames = (o) => {
      const names = new Set();
      let p = o;
      for (let i = 0; p && i < 4; i++, p = Object.getPrototypeOf(p)) Object.getOwnPropertyNames(p).forEach((n) => names.add(n));
      return Array.from(names).sort();
    };
    const d = node ? nodeData(node) : null;
    this.dbg('inspect', {
      canvasMethods: protoNames(canvas),
      nodeMethods: node ? protoNames(node) : null,
      nodeKeys: node ? Object.keys(node) : null,
      nodeData: d,
      nodeText: node ? getNodeText(node) : null,
      html: node && node.nodeEl ? node.nodeEl.outerHTML.slice(0, 6000) : null,
      measure: node ? measureNodeHeight(node) : null,
      height: node ? node.height : null,
    });
    new Notice('Mindflow：已写入调试信息');
  }

  get fmt() {
    return { answerTitle: this.settings.answerTitle || '回答', excerptTitle: this.settings.excerptTitle || '原文' };
  }

  // ── 视图定位 ──────────────────────────────────────────────
  canvasViewFromEl(el) {
    if (!el) return null;
    for (const leaf of this.app.workspace.getLeavesOfType('canvas')) {
      const v = leaf.view;
      if (v && v.containerEl && v.containerEl.contains(el) && v.canvas) return v;
    }
    return null;
  }

  activeCanvasView() {
    const ws = this.app.workspace;
    const leaf = ws.activeLeaf || (ws.getMostRecentLeaf && ws.getMostRecentLeaf());
    const v = leaf && leaf.view;
    return v && v.getViewType && v.getViewType() === 'canvas' && v.canvas ? v : null;
  }

  nodeFromEl(canvas, el) {
    if (!canvas || !el || !canvas.nodes) return null;
    for (const n of canvas.nodes.values()) if (n.nodeEl && n.nodeEl.contains(el)) return n;
    return null;
  }

  /** 把旧格式卡片（灰色「原文」块、残留的「生成中…」）转换成新格式 */
  migrateCanvas(canvas) {
    if (!canvas || !canvas.nodes) return;
    let changed = 0;
    for (const n of canvas.nodes.values()) {
      if (this.running.has(n.id) || !isTextNode(n) || isEditing(n)) continue;
      const text = getNodeText(n);
      const oldExcerpt = /^\s*>\s?\[!excerpt\]/i.test(text);
      const staleTitle = /^>\s?\[!ai\][+-]?[^\n]*生成中/im.test(text);
      if (!oldExcerpt && !staleTitle) continue;
      const p = parseNodeText(text);
      const next = buildNodeText(p, this.fmt);
      if (next !== text) {
        setNodeText(n, next);
        changed++;
      }
    }
    // 旧版本遗留：连线上的原文标签、原卡片里没高亮的原文
    try {
      const data = canvas.getData();
      const byId = new Map(data.nodes.map((n) => [n.id, n]));
      let edgeChanged = false;
      for (const e of data.edges) {
        const child = byId.get(e.toNode);
        const parent = byId.get(e.fromNode);
        if (!child || child.type !== 'text' || !parent) continue;
        const cp = parseNodeText(child.text);
        if (!cp.excerpt) continue;
        if (!this.settings.edgeLabel && e.label && cp.excerpt.startsWith(e.label.replace(/…$/, ''))) {
          delete e.label;
          edgeChanged = true;
        }
        if (this.settings.highlightExcerpt && parent.type === 'text' && !this.running.has(parent.id)) {
          const flat = cp.excerpt.replace(/\s+/g, '');
          const marks = (parent.text.match(/==([^=\n]+)==/g) || []).map((m) => m.replace(/=|\s|[*_`~]/g, ''));
          if (!marks.some((m) => m.includes(flat) || flat.includes(m))) {
            const hl = highlightInText(parent.text, cp.excerpt);
            const live = liveNode(canvas, parent.id);
            if (hl && live && !isEditing(live)) {
              setNodeText(live, hl);
              parent.text = hl;
              changed++;
            }
          }
        }
      }
      if (edgeChanged) {
        const fresh = canvas.getData();
        const keep = new Map(data.edges.map((e) => [e.id, e]));
        fresh.edges = fresh.edges.map((e) => (keep.has(e.id) ? Object.assign({}, e, { label: keep.get(e.id).label }) : e));
        for (const e of fresh.edges) if (e.label === undefined) delete e.label;
        canvas.setData(fresh);
        changed++;
      }
    } catch (err) {
      this.dbg('migrateErr', { msg: String(err) });
    }
    if (changed) {
      canvas.requestSave();
      this.dbg('migrate', { changed });
    }
  }

  migrateAll() {
    for (const leaf of this.app.workspace.getLeavesOfType('canvas')) {
      if (leaf.view && leaf.view.canvas) this.migrateCanvas(leaf.view.canvas);
    }
  }

  setStreamingClass(canvas, id, on) {
    const n = liveNode(canvas, id);
    if (n && n.nodeEl) n.nodeEl.toggleClass('cmf-streaming', on);
  }

  // ── 核心：在卡片内回答 ────────────────────────────────────
  async ask(canvas, id) {
    if (!this.settings.apiKey.trim()) {
      new Notice('Canvas Mindflow：请先在设置里填写 API Key');
      return;
    }
    let node = liveNode(canvas, id);
    if (!node) return;
    if (!isTextNode(node)) {
      new Notice('只能对文字卡片提问');
      return;
    }
    if (this.running.has(id)) return;
    const text = getNodeText(node);
    const p = parseNodeText(text);
    if (!p.question.trim() && !p.excerpt) {
      new Notice('卡片里还没有问题');
      return;
    }

    const readNote = async (path) => {
      const f = this.app.vault.getAbstractFileByPath(path);
      if (!f || f.extension !== 'md') return null;
      return { name: f.basename, content: await this.app.vault.cachedRead(f) };
    };
    const messages = await buildMessages(this.settings, canvas.getData(), id, text, readNote);

    node = liveNode(canvas, id);
    if (!node) return;
    if (p.answer === null && node.width < this.settings.nodeWidth) patchNode(node, { width: this.settings.nodeWidth });
    this.prevSizes.delete(id);
    patchNode(node, { cmfPrevSize: undefined });

    const ctrl = new AbortController();
    this.running.set(id, ctrl);
    let answer = '';
    let lastRender = 0;
    let timer = null;
    let finalText = '';
    const render = () => {
      const n = liveNode(canvas, id);
      if (!n) return;
      finalText = buildNodeText(Object.assign({}, p, { answer: normalizeMath(answer), folded: false }), this.fmt);
      setNodeText(n, finalText);
      if (n.nodeEl) n.nodeEl.addClass('cmf-streaming');
      this.fitSoon(canvas, id, 'grow');
    };
    const flush = () => {
      timer = null;
      lastRender = Date.now();
      render();
    };
    render();
    try {
      await streamChat(
        this.settings,
        messages,
        (delta) => {
          answer += delta;
          const wait = 120 - (Date.now() - lastRender);
          if (wait <= 0) flush();
          else if (!timer) timer = setTimeout(flush, wait);
        },
        ctrl.signal
      );
      if (!answer.trim()) answer = '（AI 返回为空）';
    } catch (e) {
      if (e && e.name === 'AbortError') answer += '\n\n*（已停止生成）*';
      else answer = (answer ? answer + '\n\n' : '') + `❌ 请求失败：${(e && e.message) || e}`;
    } finally {
      if (timer) clearTimeout(timer);
      this.running.delete(id);
      render();
      this.setStreamingClass(canvas, id, false);
      canvas.requestSave();
    }
    // 兜底：如果卡片在生成期间被替换过，把最终文本再写一次
    await sleep(400);
    const n = liveNode(canvas, id);
    if (n) {
      n.nodeEl && n.nodeEl.removeClass('cmf-streaming');
      const cur = parseNodeText(getNodeText(n));
      if (cur.answer !== null && cur.answer !== answer.trim() && answer.trim().startsWith(cur.answer.replace(/…$/, ''))) {
        setNodeText(n, finalText);
        canvas.requestSave();
      }
    }
  }

  /** 编辑状态下先退出编辑，让文字写回卡片，再提问 */
  async askAfterCommit(canvas, id) {
    const node = liveNode(canvas, id);
    if (!node) return;
    if (isEditing(node)) {
      try {
        if (typeof node.blur === 'function') node.blur();
      } catch (_) {}
      try {
        if (typeof canvas.deselectAll === 'function') canvas.deselectAll();
      } catch (_) {}
      await sleep(80);
      try {
        const n = liveNode(canvas, id);
        if (n && typeof canvas.selectOnly === 'function') canvas.selectOnly(n);
      } catch (_) {}
    }
    await this.ask(canvas, id);
  }

  /**
   * 渲染完成后调整高度
   * grow   ：只增不减，上限 maxAutoHeight（流式生成时）
   * expand ：展开到完整显示，上限 maxExpandHeight
   * exact  ：正好包住内容（折叠后）
   */
  async fitSoon(canvas, id, mode) {
    await sleep(60);
    await nextFrame();
    const node = liveNode(canvas, id);
    if (!node) return;
    const h = measureNodeHeight(node);
    this.dbg('fit', { mode, measured: h, height: node.height });
    if (!h) return;
    if (mode === 'exact') {
      patchNode(node, { height: Math.max(60, h) });
    } else {
      const cap = mode === 'expand' ? this.settings.maxExpandHeight : this.settings.maxAutoHeight;
      const target = Math.min(h, cap);
      if (target > node.height + 2) patchNode(node, { height: target });
    }
  }

  // ── 折叠 / 展开 ──────────────────────────────────────────
  /**
   * 展开：记下当前尺寸，然后把卡片放大到能完整显示回答（有上限）。
   * 折叠：恢复到展开前的尺寸；没有记录时收紧到正好包住问题。
   */
  async setFold(canvas, id, folded) {
    const node = liveNode(canvas, id);
    if (!node) return;
    const text = getNodeText(node);
    const p = parseNodeText(text);
    if (p.answer === null) return;
    const newText = setFoldedInText(text, folded);
    this.dbg('setFold', { folded, wasFolded: p.folded, w: node.width, h: node.height });
    if (p.folded === folded && newText === text) return;

    if (!folded) {
      const prev = { width: node.width, height: node.height };
      this.prevSizes.set(id, prev);
      setNodeText(node, newText);
      const n = liveNode(canvas, id);
      if (n) {
        const patch = { cmfPrevSize: prev };
        const target = Math.max(n.width, Math.min(this.settings.expandWidth, this.settings.maxExpandWidth));
        if (target > n.width) patch.width = target;
        patchNode(n, patch);
      }
      await sleep(40);
      await nextFrame();
      // 表格、代码块、公式等宽内容：继续加宽到能完整显示（不超过上限）
      const n2 = liveNode(canvas, id);
      if (n2) {
        const extra = measureOverflowX(n2);
        if (extra > 4) {
          const w = Math.min(n2.width + extra + 8, this.settings.maxExpandWidth);
          if (w > n2.width) patchNode(n2, { width: w });
        }
      }
      await this.fitSoon(canvas, id, 'expand');
    } else {
      const n0 = liveNode(canvas, id);
      const prev = this.prevSizes.get(id) || (n0 && nodeData(n0).cmfPrevSize);
      setNodeText(node, newText);
      const n = liveNode(canvas, id);
      if (prev && prev.height) {
        if (n) patchNode(n, { width: prev.width, height: prev.height, cmfPrevSize: undefined });
      } else {
        if (n) patchNode(n, { cmfPrevSize: undefined });
        await this.fitSoon(canvas, id, 'exact');
      }
      this.prevSizes.delete(id);
    }
    canvas.requestSave();
  }

  toggleFold(canvas, id) {
    const node = liveNode(canvas, id);
    if (!node) return;
    const p = parseNodeText(getNodeText(node));
    if (p.answer !== null) this.setFold(canvas, id, !p.folded);
  }

  async foldAll(canvas, folded) {
    const ids = [];
    for (const n of canvas.nodes.values()) {
      if (isTextNode(n) && parseNodeText(getNodeText(n)).answer !== null) ids.push(n.id);
    }
    for (const id of ids) await this.setFold(canvas, id, folded);
  }

  // ── 新建卡片 ─────────────────────────────────────────────
  /** 在 parent 右侧找一个不与其它卡片重叠的位置 */
  placeRightOf(canvas, parent, preferY, width, height) {
    const x = parent.x + parent.width + 100;
    let y = preferY != null ? preferY : parent.y;
    const others = Array.from(canvas.nodes.values())
      .filter((n) => n !== parent && nodeData(n).type !== 'group')
      .filter((n) => n.x < x + width && n.x + n.width > x)
      .sort((a, b) => a.y - b.y);
    for (let guard = 0; guard < 3; guard++) {
      let moved = false;
      for (const n of others) {
        if (y < n.y + n.height + 40 && y + height + 40 > n.y) {
          y = n.y + n.height + 40;
          moved = true;
        }
      }
      if (!moved) break;
    }
    return { x, y };
  }

  /** 新建文字卡片，返回 id */
  createNode(canvas, pos, text, height, focus) {
    const node = canvas.createTextNode({
      pos,
      size: { width: this.settings.nodeWidth, height: height || 100 },
      text: text || '',
      focus: !!focus,
    });
    return node.id;
  }

  focusEdit(canvas, id) {
    setTimeout(() => {
      try {
        const n = liveNode(canvas, id);
        if (!n) return;
        if (typeof canvas.selectOnly === 'function') canvas.selectOnly(n);
        if (!isEditing(n) && typeof n.startEditing === 'function') n.startEditing();
      } catch (_) {}
    }, 60);
  }

  /** Tab：在右侧新建一张空白追问卡片 */
  createFollowUp(canvas, parentId) {
    const parent = liveNode(canvas, parentId);
    if (!parent) return;
    const pos = this.placeRightOf(canvas, parent, parent.y, this.settings.nodeWidth, 100);
    const id = this.createNode(canvas, pos, '', 100, true);
    addEdges(canvas, [parentId], id);
    canvas.requestSave();
    this.focusEdit(canvas, id);
  }

  /** 划词追问：高亮原卡片里的原文，新建带原文锚点的子卡片并立即回答 */
  async createFromSelection(canvas, parentId, excerpt, question, rect) {
    let parent = liveNode(canvas, parentId);
    if (!parent) return;
    let preferY = parent.y;
    if (rect && parent.nodeEl) {
      const nr = parent.nodeEl.getBoundingClientRect();
      const scale = parent.height ? nr.height / parent.height : 1;
      if (scale > 0) preferY = parent.y + Math.max(0, (rect.top - nr.top) / scale - 20);
    }
    if (this.settings.highlightExcerpt) {
      const before = getNodeText(parent);
      const hl = highlightInText(before, excerpt);
      this.dbg('highlight', { excerpt, found: !!hl, before: before.slice(0, 800) });
      if (hl) setNodeText(parent, hl);
      parent = liveNode(canvas, parentId);
      if (!parent) return;
    }
    const q = question.trim() || '请详细解释这段内容。';
    const text = buildNodeText({ excerpt, question: q, answer: null }, this.fmt);
    const pos = this.placeRightOf(canvas, parent, preferY, this.settings.nodeWidth, 140);
    const id = this.createNode(canvas, pos, text, 140, false);
    addEdges(canvas, [parentId], id, this.settings.edgeLabel ? truncate(excerpt, 16) : undefined);
    canvas.requestSave();
    {
      const pd = canvas.getData().nodes.find((n) => n.id === parentId);
      const pl = liveNode(canvas, parentId);
      this.dbg('afterEdge', { dataText: pd && pd.text.slice(0, 300), liveText: pl && getNodeText(pl).slice(0, 300), sameObj: pl === parent });
    }
    await sleep(50);
    await this.ask(canvas, id);
  }

  /** 视口中央新建问题卡片 */
  createQuestionAtCenter(canvas) {
    let x = 0;
    let y = 0;
    try {
      const bb = canvas.getViewportBBox();
      x = (bb.minX + bb.maxX) / 2 - this.settings.nodeWidth / 2;
      y = (bb.minY + bb.maxY) / 2 - 60;
    } catch (_) {
      x = (canvas.x || 0) - this.settings.nodeWidth / 2;
      y = canvas.y || 0;
    }
    const id = this.createNode(canvas, { x, y }, '', 100, true);
    canvas.requestSave();
    this.focusEdit(canvas, id);
  }

  /** 多选：新建一张连接所有选中卡片的汇总提问卡片 */
  createMergeQuestion(canvas, nodes) {
    const x = Math.max(...nodes.map((n) => n.x + n.width)) + 100;
    const y = Math.min(...nodes.map((n) => n.y));
    const ids = nodes.map((n) => n.id);
    const id = this.createNode(canvas, { x, y }, '', 100, true);
    addEdges(canvas, ids, id);
    canvas.requestSave();
    this.focusEdit(canvas, id);
  }

  stopAll() {
    for (const c of this.running.values()) c.abort();
  }

  // ── 键盘 / 鼠标 ──────────────────────────────────────────
  onKeyDown(evt) {
    if (this.popover) return; // 弹窗自己处理
    const t = evt.target instanceof Element ? evt.target : null;
    const inCanvasView = t && this.canvasViewFromEl(t);
    const view = inCanvasView || this.activeCanvasView();
    if (!view) return;
    const editable = t && t.closest('.cm-editor, input, textarea, [contenteditable="true"]');
    if (editable && !inCanvasView) return; // 焦点在别处（搜索框等）
    const canvas = view.canvas;

    // Ctrl/Cmd + Enter：让 AI 回答当前卡片
    if (evt.key === 'Enter' && (evt.ctrlKey || evt.metaKey) && !evt.shiftKey && !evt.altKey && !evt.isComposing) {
      const sel = selectedNodes(canvas);
      const node = (t && this.nodeFromEl(canvas, t)) || (sel.length === 1 ? sel[0] : null);
      if (!node || !isTextNode(node)) return;
      evt.preventDefault();
      evt.stopPropagation();
      this.askAfterCommit(canvas, node.id);
      return;
    }

    // Tab：有划选文字 → 追问弹窗；否则 → 新建空白子卡片
    if (evt.key === 'Tab' && this.settings.enableTab && !evt.ctrlKey && !evt.metaKey && !evt.altKey && !evt.shiftKey) {
      if (editable) return; // 编辑卡片时保留原生缩进
      if (this.selInfo && this.selInfo.canvas === canvas) {
        evt.preventDefault();
        evt.stopPropagation();
        this.openPopover();
        return;
      }
      const sel = selectedNodes(canvas);
      if (sel.length === 1) {
        evt.preventDefault();
        evt.stopPropagation();
        this.createFollowUp(canvas, sel[0].id);
      }
    }
  }

  /** 找到事件所在的、已选中且未在编辑的卡片 */
  selectedNodeAt(el) {
    const nodeEl = el.closest('.canvas-node');
    if (!nodeEl || nodeEl.querySelector('.cm-editor')) return null;
    const view = this.canvasViewFromEl(nodeEl);
    if (!view) return null;
    const node = this.nodeFromEl(view.canvas, nodeEl);
    if (!node || !view.canvas.selection || !view.canvas.selection.has(node)) return null;
    return { view, node };
  }

  /** 已选中的卡片里，按住回答区域拖动 = 划选文字（而不是移动卡片） */
  onPointerDown(evt) {
    if (evt.button !== 0) return;
    const t = evt.target instanceof Element ? evt.target : null;
    if (!t) return;
    if (this.popover && !this.popover.contains(t)) this.closePopover();
    if (t.closest('.cmf-sel-btn, .cmf-popover')) return;
    const title = t.closest('.callout[data-callout="ai"] > .callout-title');
    if (title) {
      if (evt.type === 'pointerdown') this.handleTitlePress(evt, title);
      else {
        evt.preventDefault();
        evt.stopPropagation();
      }
      return;
    }
    const content = t.closest(
      '.callout[data-callout="ai"] > .callout-content, .callout[data-callout="excerpt"] > .callout-content'
    );
    if (!content) return;
    if (!this.selectedNodeAt(t)) return;
    evt.stopPropagation();
  }

  /** 已选中卡片的回答区可以滚动时，滚轮用来滚动回答而不是缩放画布 */
  onWheel(evt) {
    this.hideSelButton();
    const t = evt.target instanceof Element ? evt.target : null;
    if (!t || evt.ctrlKey || evt.metaKey) return;
    const hit = this.selectedNodeAt(t);
    if (!hit) return;
    const block = answerBlockOf(hit.node);
    if (!block || !block.contains(t)) return;
    const canDown = block.scrollTop + block.clientHeight < block.scrollHeight - 1;
    const canUp = block.scrollTop > 0;
    if ((evt.deltaY > 0 && canDown) || (evt.deltaY < 0 && canUp)) evt.stopPropagation();
  }

  /** 按下「回答」标题 → 折叠/展开（在按下时处理，不依赖 click，避免卡片重绘后丢失点击） */
  handleTitlePress(evt, title) {
    const nodeEl = title.closest('.canvas-node');
    if (!nodeEl || nodeEl.querySelector('.cm-editor')) return;
    const view = this.canvasViewFromEl(nodeEl);
    if (!view) return;
    const node = this.nodeFromEl(view.canvas, nodeEl);
    if (!node) return;
    evt.preventDefault();
    evt.stopPropagation();
    this.dbg('titlePress', { id: node.id });
    this.swallowClickUntil = Date.now() + 600;
    this.toggleFold(view.canvas, node.id);
  }

  /** 吞掉标题上的 click，防止 Obsidian 自己再折叠一次 */
  onClick(evt) {
    const t = evt.target instanceof Element ? evt.target : null;
    if (!t) return;
    const onTitle = t.closest('.canvas-node .callout[data-callout="ai"] > .callout-title');
    if (onTitle || (this.swallowClickUntil && Date.now() < this.swallowClickUntil && t.closest('.canvas-node'))) {
      evt.preventDefault();
      evt.stopPropagation();
    }
  }

  // ── 划词浮动按钮 & 追问弹窗 ──────────────────────────────
  onSelectionChange() {
    // 拖选经过公式时，给公式加选中底色
    try {
      const sel = document.getSelection();
      const r = sel && sel.rangeCount && !sel.isCollapsed ? sel.getRangeAt(0) : null;
      let el = r && r.commonAncestorContainer;
      if (el && el.nodeType !== 1) el = el.parentElement;
      const nodeEl = el && el.closest('.canvas-node');
      if (this._mathSelScope && this._mathSelScope !== nodeEl) markSelectedMath(this._mathSelScope, null);
      if (nodeEl) markSelectedMath(nodeEl, r);
      this._mathSelScope = nodeEl || null;
    } catch (_) {}
    if (this.popover) return;
    clearTimeout(this.selTimer);
    this.selTimer = setTimeout(() => this.updateSelection(), 120);
  }

  updateSelection() {
    if (this.popover) return;
    const sel = document.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return this.clearSelection();
    const range = sel.getRangeAt(0);
    let el = range.commonAncestorContainer;
    if (el && el.nodeType !== 1) el = el.parentElement;
    if (!el || el.closest('.cm-editor')) return this.clearSelection();
    const nodeEl = el.closest('.canvas-node');
    if (!nodeEl) return this.clearSelection();
    const view = this.canvasViewFromEl(nodeEl);
    if (!view) return this.clearSelection();
    const node = this.nodeFromEl(view.canvas, nodeEl);
    if (!node) return this.clearSelection();
    annotateMath(nodeEl, getNodeText(node));
    const text = selectionToSource(range).text;
    if (!text) return this.clearSelection();
    const rect = range.getBoundingClientRect();
    this.selInfo = { canvas: view.canvas, nodeId: node.id, text, rect };
    this.showSelButton(rect);
  }

  clearSelection() {
    this.selInfo = null;
    this.hideSelButton();
  }

  showSelButton(rect) {
    this.hideSelButton();
    const btn = document.body.createDiv({ cls: 'cmf-sel-btn', text: '✦ 追问' });
    btn.setAttr('aria-label', '针对选中内容追问（Tab）');
    const top = rect.top > 44 ? rect.top - 38 : rect.bottom + 8;
    btn.style.top = `${top}px`;
    btn.style.left = `${rect.left + rect.width / 2}px`;
    btn.addEventListener('mousedown', (e) => e.preventDefault());
    btn.addEventListener('pointerdown', (e) => e.preventDefault());
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.openPopover();
    });
    this.selBtn = btn;
  }

  hideSelButton() {
    if (this.selBtn) {
      this.selBtn.remove();
      this.selBtn = null;
    }
  }

  openPopover() {
    const info = this.selInfo;
    if (!info) return;
    this.hideSelButton();
    this.closePopover();
    const pop = document.body.createDiv({ cls: 'cmf-popover' });
    pop.createDiv({ cls: 'cmf-pop-excerpt', text: `「${truncate(info.text, 90)}」` });
    const ta = pop.createEl('textarea', {
      cls: 'cmf-pop-input',
      attr: { rows: '2', placeholder: '想追问什么？留空=详细解释这段' },
    });
    pop.createDiv({ cls: 'cmf-pop-hint', text: 'Enter 发送　Shift+Enter 换行　Esc 取消' });
    const r = info.rect;
    const w = 340;
    const left = Math.min(Math.max(8, r.left + r.width / 2 - w / 2), window.innerWidth - w - 8);
    const below = r.bottom + 10;
    const top = below + 130 < window.innerHeight ? below : Math.max(8, r.top - 140);
    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;
    pop.style.width = `${w}px`;
    ta.addEventListener('keydown', (e) => {
      if (e.isComposing) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.closePopover();
      } else if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        const q = ta.value;
        this.closePopover();
        this.selInfo = null;
        const s = document.getSelection();
        if (s) s.removeAllRanges();
        this.createFromSelection(info.canvas, info.nodeId, info.text, q, info.rect);
      }
    });
    this.popover = pop;
    setTimeout(() => ta.focus(), 20);
  }

  closePopover() {
    if (this.popover) {
      this.popover.remove();
      this.popover = null;
    }
  }

  closeAll() {
    this.closePopover();
    this.clearSelection();
  }

  // ── 命令 & 右键菜单 ──────────────────────────────────────
  withCanvas(checking, fn) {
    const view = this.activeCanvasView();
    if (!view) return false;
    const r = fn(view.canvas, true);
    if (r === false) return false;
    if (!checking) fn(view.canvas, false);
    return true;
  }

  registerCommands() {
    const single = (canvas) => {
      const s = selectedNodes(canvas);
      return s.length === 1 ? s[0] : null;
    };
    const withNode = (checking, run) =>
      this.withCanvas(checking, (canvas, dry) => {
        const n = single(canvas);
        if (!n) return false;
        if (!dry) run(canvas, n.id);
      });
    this.addCommand({
      id: 'new-question',
      name: '在画布中央新建问题卡片',
      checkCallback: (checking) =>
        this.withCanvas(checking, (canvas, dry) => {
          if (!dry) this.createQuestionAtCenter(canvas);
        }),
    });
    this.addCommand({
      id: 'ask',
      name: '让 AI 回答选中的卡片（Ctrl/Cmd+Enter）',
      checkCallback: (checking) => withNode(checking, (c, id) => this.askAfterCommit(c, id)),
    });
    this.addCommand({
      id: 'follow-up',
      name: '新建追问子卡片（Tab）',
      checkCallback: (checking) => withNode(checking, (c, id) => this.createFollowUp(c, id)),
    });
    this.addCommand({
      id: 'toggle-fold',
      name: '折叠/展开选中卡片的回答',
      checkCallback: (checking) => withNode(checking, (c, id) => this.toggleFold(c, id)),
    });
    this.addCommand({
      id: 'fold-all',
      name: '折叠画布上所有回答',
      checkCallback: (checking) =>
        this.withCanvas(checking, (canvas, dry) => {
          if (!dry) this.foldAll(canvas, true);
        }),
    });
    this.addCommand({
      id: 'expand-all',
      name: '展开画布上所有回答',
      checkCallback: (checking) =>
        this.withCanvas(checking, (canvas, dry) => {
          if (!dry) this.foldAll(canvas, false);
        }),
    });
    this.addCommand({ id: 'stop', name: '停止所有生成', callback: () => this.stopAll() });
    this.addCommand({
      id: 'debug-inspect',
      name: '调试：导出选中卡片结构',
      checkCallback: (checking) =>
        this.withCanvas(checking, (canvas, dry) => {
          if (!dry) this.inspect(canvas, single(canvas));
        }),
    });
  }

  registerMenus() {
    this.registerEvent(
      this.app.workspace.on('canvas:node-menu', (menu, node) => {
        const canvas = node.canvas;
        if (!canvas || !isTextNode(node)) return;
        const id = node.id;
        const p = parseNodeText(getNodeText(node));
        if (this.running.has(id)) {
          menu.addItem((i) =>
            i.setTitle('停止生成').setIcon('square').onClick(() => this.running.get(id) && this.running.get(id).abort())
          );
        } else {
          menu.addItem((i) =>
            i
              .setTitle(p.answer === null ? '让 AI 回答' : '重新回答')
              .setIcon(p.answer === null ? 'sparkles' : 'refresh-cw')
              .onClick(() => this.askAfterCommit(canvas, id))
          );
        }
        menu.addItem((i) => i.setTitle('追问（新建子卡片）').setIcon('corner-down-right').onClick(() => this.createFollowUp(canvas, id)));
        if (p.answer !== null) {
          menu.addItem((i) =>
            i
              .setTitle(p.folded ? '展开回答' : '折叠回答')
              .setIcon(p.folded ? 'chevrons-up-down' : 'chevrons-down-up')
              .onClick(() => this.setFold(canvas, id, !p.folded))
          );
        }
      })
    );
    this.registerEvent(
      this.app.workspace.on('canvas:selection-menu', (menu, canvas) => {
        const nodes = selectedNodes(canvas);
        if (nodes.length < 2) return;
        menu.addItem((i) =>
          i.setTitle(`汇总提问（连接 ${nodes.length} 张卡片）`).setIcon('git-merge').onClick(() => this.createMergeQuestion(canvas, nodes))
        );
      })
    );
  }
}

// ─────────────────────────────────────────────────────────────
// 设置页
// ─────────────────────────────────────────────────────────────
class MindflowSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
    this.models = null;
  }

  display() {
    const { containerEl } = this;
    const s = this.plugin.settings;
    const save = async () => {
      await this.plugin.saveSettings();
      if (this.plugin.chat) this.plugin.chat.applyLayoutSettings();
    };
    containerEl.empty();
    containerEl.addClass('cmf-settings');

    const section = (title, desc) => {
      new Setting(containerEl).setName(title).setHeading();
      if (desc) containerEl.createDiv({ cls: 'setting-item-description cmf-settings-desc', text: desc });
    };
    const num = (name, desc, key, min, max) =>
      new Setting(containerEl)
        .setName(name)
        .setDesc(desc)
        .addText((t) => {
          t.inputEl.type = 'number';
          t.inputEl.style.width = '90px';
          t.setValue(String(s[key])).onChange(async (v) => {
            const n = parseInt(v, 10);
            if (!isNaN(n) && n >= min && (max == null || n <= max)) {
              s[key] = n;
              await save();
            }
          });
        });
    const toggle = (name, desc, key) =>
      new Setting(containerEl)
        .setName(name)
        .setDesc(desc)
        .addToggle((t) => t.setValue(!!s[key]).onChange(async (v) => ((s[key] = v), await save())));

    // ── AI 服务 ────────────────────────────────────────────
    section('AI 服务', '支持所有 OpenAI 兼容接口。选一个服务商会自动填好 API 地址和推荐模型。');
    const current = PROVIDERS.find((p) => s.apiBaseUrl.trim().replace(/\/+$/, '') === p.url);
    new Setting(containerEl)
      .setName('服务商')
      .addDropdown((d) => {
        d.addOption('custom', '自定义');
        for (const p of PROVIDERS) d.addOption(p.id, p.name);
        d.setValue(current ? current.id : 'custom');
        d.onChange(async (v) => {
          const p = PROVIDERS.find((x) => x.id === v);
          if (!p) return;
          s.apiBaseUrl = p.url;
          s.model = p.model;
          this.models = null;
          await save();
          this.display();
        });
      });
    new Setting(containerEl)
      .setName('API 地址')
      .setDesc('基础地址，通常以 /v1 结尾')
      .addText((t) => {
        t.inputEl.style.width = '280px';
        t.setValue(s.apiBaseUrl).onChange(async (v) => ((s.apiBaseUrl = v.trim()), await save()));
      });
    new Setting(containerEl)
      .setName('API Key')
      .setDesc('保存在本库的插件数据里，会随库同步到你的其他设备')
      .addText((t) => {
        t.inputEl.type = 'password';
        t.inputEl.style.width = '280px';
        t.setValue(s.apiKey).onChange(async (v) => ((s.apiKey = v.trim()), await save()));
      })
      .addExtraButton((b) =>
        b
          .setIcon('eye')
          .setTooltip('显示 / 隐藏')
          .onClick(() => {
            const input = b.extraSettingsEl.parentElement.querySelector('input');
            if (input) input.type = input.type === 'password' ? 'text' : 'password';
          })
      );
    const modelSetting = new Setting(containerEl).setName('模型').setDesc('可以手动填写，或点「获取列表」从服务商读取可用模型');
    if (this.models && this.models.length) {
      modelSetting.addDropdown((d) => {
        for (const m of this.models) d.addOption(m, m);
        if (!this.models.includes(s.model)) d.addOption(s.model, `${s.model}（当前）`);
        d.setValue(s.model).onChange(async (v) => ((s.model = v), await save()));
      });
    } else {
      modelSetting.addText((t) => {
        t.inputEl.style.width = '220px';
        t.setValue(s.model).onChange(async (v) => ((s.model = v.trim()), await save()));
      });
    }
    modelSetting.addButton((b) =>
      b.setButtonText('获取列表').onClick(async () => {
        b.setDisabled(true);
        try {
          this.models = await fetchModels(s);
          if (!this.models.length) new Notice('服务商没有返回模型列表，请手动填写');
          this.display();
        } catch (e) {
          new Notice(`获取失败：${(e && e.message) || e}`, 8000);
        } finally {
          b.setDisabled(false);
        }
      })
    );
    new Setting(containerEl)
      .setName('测试连接')
      .setDesc('用当前配置发一条很短的请求')
      .addButton((b) =>
        b.setButtonText('测试').onClick(async () => {
          b.setDisabled(true);
          try {
            const r = await completeOnce(s, [{ role: 'user', content: '只回复“好”' }], { max_tokens: 8 });
            new Notice(`连接成功：${truncate(r, 30)}`);
          } catch (e) {
            new Notice(`连接失败：${(e && e.message) || e}`, 8000);
          } finally {
            b.setDisabled(false);
          }
        })
      );
    new Setting(containerEl)
      .setName('Temperature')
      .setDesc('越低越严谨，越高越发散（默认 0.7）')
      .addSlider((sl) =>
        sl.setLimits(0, 2, 0.1).setValue(Number(s.temperature)).setDynamicTooltip().onChange(async (v) => ((s.temperature = v), await save()))
      );
    num('最大回复长度', '单次回答最多多少 token，0 表示不限制（由服务商决定）', 'maxTokens', 0);
    new Setting(containerEl)
      .setName('系统提示词')
      .setDesc('AI 的角色与回答风格，对话视图和 Canvas 卡片共用')
      .addExtraButton((b) =>
        b
          .setIcon('rotate-ccw')
          .setTooltip('恢复默认')
          .onClick(async () => {
            s.systemPrompt = DEFAULT_SYSTEM_PROMPT;
            await save();
            this.display();
          })
      );
    const sp = containerEl.createEl('textarea', { cls: 'cmf-settings-textarea' });
    sp.rows = 5;
    sp.value = s.systemPrompt;
    sp.addEventListener('change', async () => {
      s.systemPrompt = sp.value;
      await save();
    });

    // ── 对话视图 ──────────────────────────────────────────
    section('对话视图', '划线追问的对话窗口。');
    new Setting(containerEl)
      .setName('打开对话视图')
      .addButton((b) => b.setButtonText('打开').onClick(() => this.plugin.chat && this.plugin.chat.openView()));
    new Setting(containerEl)
      .setName('发送方式')
      .addDropdown((d) =>
        d
          .addOption('enter', 'Enter 发送，Shift+Enter 换行')
          .addOption('mod-enter', 'Ctrl/Cmd+Enter 发送，Enter 换行')
          .setValue(s.chatSendKey)
          .onChange(async (v) => ((s.chatSendKey = v), await save()))
      );
    new Setting(containerEl)
      .setName('回答字号')
      .addSlider((sl) =>
        sl.setLimits(12, 20, 1).setValue(Number(s.chatFontSize)).setDynamicTooltip().onChange(async (v) => ((s.chatFontSize = v), await save()))
      );
    toggle('显示回答信息', '在每条回答下方显示时间和所用模型', 'chatShowMeta');
    new Setting(containerEl)
      .setName('划线追问的默认问题')
      .setDesc('划线后不输入问题直接发送时使用')
      .addText((t) => {
        t.inputEl.style.width = '240px';
        t.setValue(s.defaultFollowUp).onChange(async (v) => ((s.defaultFollowUp = v.trim() || '请详细解释这段内容。'), await save()));
      });
    // 预设追问
    new Setting(containerEl)
      .setName('划线追问的预设问题')
      .setDesc('划线后右键或在追问小窗里一键选用，不用每次手打。可以增删、调整顺序。')
      .addButton((b) =>
        b.setButtonText('添加问题').onClick(async () => {
          s.presetQuestions = (s.presetQuestions || []).concat(['']);
          await save();
          this.display();
          setTimeout(() => {
            const inputs = containerEl.querySelectorAll('.cmf-preset-input');
            const last = inputs[inputs.length - 1];
            if (last) last.focus();
          }, 30);
        })
      )
      .addExtraButton((b) =>
        b
          .setIcon('rotate-ccw')
          .setTooltip('恢复默认预设')
          .onClick(async () => {
            s.presetQuestions = DEFAULT_SETTINGS.presetQuestions.slice();
            await save();
            this.display();
          })
      );
    const presetBox = containerEl.createDiv({ cls: 'cmf-preset-list' });
    const presets = Array.isArray(s.presetQuestions) ? s.presetQuestions : [];
    if (!presets.length) presetBox.createDiv({ cls: 'cmf-preset-empty', text: '还没有预设问题，点「添加问题」' });
    presets.forEach((q, i) => {
      const row = presetBox.createDiv({ cls: 'cmf-preset-row' });
      row.createSpan({ cls: 'cmf-preset-num', text: String(i + 1) });
      const input = row.createEl('input', { cls: 'cmf-preset-input', attr: { type: 'text', placeholder: '例如：这个概念的直观理解是什么？' } });
      input.value = q;
      input.addEventListener('change', async () => {
        s.presetQuestions[i] = input.value.trim();
        await save();
      });
      const btn = (icon, tip, fn, disabled) => {
        const b = row.createDiv({ cls: 'clickable-icon cmf-preset-btn' + (disabled ? ' is-disabled' : ''), attr: { 'aria-label': tip } });
        obsidian.setIcon(b, icon);
        if (!disabled) b.addEventListener('click', fn);
      };
      const move = async (d) => {
        const arr = s.presetQuestions;
        [arr[i], arr[i + d]] = [arr[i + d], arr[i]];
        await save();
        this.display();
      };
      btn('arrow-up', '上移', () => move(-1), i === 0);
      btn('arrow-down', '下移', () => move(1), i === presets.length - 1);
      btn('trash-2', '删除', async () => {
        s.presetQuestions.splice(i, 1);
        await save();
        this.display();
      });
    });
    num('左侧栏宽度', '也可以直接拖动侧栏边缘调整', 'chatNavWidth', 140, 480);
    num('右侧栏宽度', '也可以直接拖动侧栏边缘调整', 'chatSideWidth', 220, 720);
    new Setting(containerEl)
      .setName('恢复默认布局')
      .setDesc('两侧栏都展开，宽度恢复默认')
      .addButton((b) =>
        b.setButtonText('恢复').onClick(async () => {
          s.chatNavWidth = DEFAULT_SETTINGS.chatNavWidth;
          s.chatSideWidth = DEFAULT_SETTINGS.chatSideWidth;
          s.chatNavCollapsed = false;
          s.chatSideCollapsed = false;
          await save();
          this.display();
        })
      );
    new Setting(containerEl)
      .setName('对话保存位置')
      .setDesc('对话数据、总览图都保存在库里的这个文件夹，会随库一起同步')
      .addText((t) => t.setValue(s.chatFolder).onChange(async (v) => ((s.chatFolder = v.trim() || 'Mindflow'), await save())));
    new Setting(containerEl)
      .setName('图片识别模型（可选）')
      .setDesc('发送图片时改用这个模型（需要支持图片输入，例如 gpt-4o、qwen-vl-max、glm-4v）。留空则用上面的模型；DeepSeek 目前不支持图片。')
      .addText((t) => {
        t.inputEl.style.width = '200px';
        t.setPlaceholder('留空 = 使用默认模型').setValue(s.visionModel || '').onChange(async (v) => ((s.visionModel = v.trim()), await save()));
      });
    num('附件文字上限', 'PDF / 文本文件最多发送多少个字，超出部分截断', 'attachMaxChars', 2000);
    new Setting(containerEl)
      .setName('「保存为笔记」的位置')
      .setDesc('留空则保存到「对话保存位置/笔记」')
      .addText((t) => t.setValue(s.noteFolder).onChange(async (v) => ((s.noteFolder = v.trim()), await save())));

    // ── 上下文 ────────────────────────────────────────────
    section('上下文', '追问时，AI 会看到上层窗口的对话；越远的回答截得越短，节省 token。');
    num('完整保留的层数', '离当前窗口几层以内的回答发送全文', 'fullContextDepth', 0);
    num('远端回答截取字数', '更远的回答只发送前 N 个字', 'truncateChars', 50);
    num('最多祖先卡片数', 'Canvas 卡片对话：沿连线向上最多带多少张卡片', 'maxAncestors', 1);
    toggle('读取连接的笔记', 'Canvas 卡片对话：把连到问题上的笔记文件卡片内容作为资料发送', 'includeNoteFiles');

    // ── Canvas 卡片 ───────────────────────────────────────
    section('Canvas 卡片对话', '在 .canvas 里，选中卡片按 Ctrl/Cmd+Enter 让 AI 直接在卡片里回答。');
    num('卡片宽度', '新建卡片和首次回答时的宽度', 'nodeWidth', 200);
    num('自动增高上限', '生成回答时卡片最多自动长到多高', 'maxAutoHeight', 150);
    num('展开时最大高度', '点「回答」标题展开时最多放大到多高', 'maxExpandHeight', 150);
    num('展开时宽度', '展开时卡片至少放宽到这个宽度', 'expandWidth', 200);
    num('展开时最大宽度', '有宽表格、代码块时最多加宽到这个宽度', 'maxExpandWidth', 200);
    new Setting(containerEl)
      .setName('回答标题')
      .addText((t) => t.setValue(s.answerTitle).onChange(async (v) => ((s.answerTitle = v || '回答'), await save())));
    toggle('Tab 追问', '选中卡片按 Tab 新建追问卡片；划选文字后按 Tab 打开追问框', 'enableTab');
    toggle('连线上显示原文', '划词追问时在连线上标出原文的前几个字', 'edgeLabel');
    toggle('高亮原文', '划词追问后把原卡片里被追问的文字标成高亮', 'highlightExcerpt');

    // ── 高级 ──────────────────────────────────────────────
    section('高级');
    toggle('调试日志', '把调试信息写到插件目录的 debug.log，排查问题时再打开', 'debug');
  }
}

module.exports = CanvasMindflowPlugin;
module.exports.default = CanvasMindflowPlugin;
// 供测试使用
module.exports._internals = {
  parseNodeText,
  buildNodeText,
  setFoldedInText,
  highlightInText,
  extractMath,
  formatQuestion,
  collectAncestors,
  buildMessages,
  DEFAULT_SETTINGS,
};
