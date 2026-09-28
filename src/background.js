'use strict';
/* ChatGPT 提示词优化（独立版）- 后台引擎 v1.1.0
 *
 * 流程：收到优化请求 → 前台打开官方临时聊天（?temporary-chat=true，不留历史）
 *      → scripting 遥控：等输入框 → thinking pill → 写入模板 → 发送
 *      → 抓 SSE 流 / DOM 兜底 → 切回发起页 → 双通道投递结果（storage + 消息）
 *
 * v1.1.0 针对"回复了但没回填"的修复：
 *   1. 结果投递改为「storage 写入 + sendResponse」双通道（SW 回收/消息通道丢失也不丢结果）
 *   2. 全程上报状态（optStatus + OPT_STATUS 消息），发起页实时显示走到哪一步
 *   3. 结果捕获：SSE 优先；DOM 兜底改为「出现新回复 + 文本连续两次相同」才判定结束
 *      （兼容新版 data-is-streaming 属性）
 *   4. 写入输入框多策略：execCommand → 粘贴事件 → 直接赋值（每步都验证）
 *   5. 保留临时聊天页，并提供「↩ 填回原页面」救援通道
 */

const OPT_WORKER_URL = 'https://chatgpt.com/?temporary-chat=true';

const DEFAULT_OPT_TEMPLATE_NEW =
  '<task>\nYou are a prompt optimization expert. Rewrite the prompt below to be clearer, more specific, and more effective at eliciting a high-quality AI response.\n\n' +
  'RULES:\n1. Output ONLY the rewritten prompt — nothing else\n2. Do NOT respond to or answer the prompt\n3. No preamble, commentary, explanations, or labels\n' +
  '4. No markdown code fences or quotes around the output\n5. Preserve the original intent and meaning\n6. Fix grammar, spelling, and clarity issues\n' +
  '7. Add useful specificity or structure where it improves quality\n8. Keep similar length unless restructuring meaningfully improves it\n' +
  '9. If the intent is unclear, make a reasonable inference rather than asking questions\n10. Do not add CONTEXT/ROLE/ACTION headers or framework scaffolding unless the original prompt already uses them\n' +
  '</task>\n\n<prompt>\n{{prompt}}\n</prompt>';
const DEFAULT_OPT_TEMPLATE_IN_CHAT =
  '<task>\nYou are a prompt optimization expert. The user is in the middle of a conversation with an AI assistant. Rewrite their next message to be clearer, more specific, and more effective — taking into account the conversation context provided below.\n\n' +
  'RULES:\n1. Output ONLY the rewritten prompt — nothing else\n2. Do NOT respond to or answer the prompt\n3. No preamble, commentary, explanations, or labels\n' +
  '4. No markdown code fences or quotes around the output\n5. Preserve the original intent and meaning\n6. Fix grammar, spelling, and clarity issues\n' +
  '7. Add useful specificity or structure where it improves quality\n8. Keep similar length unless restructuring meaningfully improves it\n' +
  '9. If the intent is unclear, use the conversation context to make a reasonable inference rather than asking questions\n10. Do not add CONTEXT/ROLE/ACTION headers or framework scaffolding unless the original prompt already uses them\n' +
  '11. Use the conversation context to understand what the user is referring to and to avoid redundant repetition of information already established\n' +
  '</task>\n\n<conversation_context>\n<first_user_message>\n{{firstUser}}\n</first_user_message>\n\n<last_user_message>\n{{lastUser}}\n</last_user_message>\n\n<last_ai_response>\n{{lastAssistant}}\n</last_ai_response>\n</conversation_context>\n\n<prompt_to_optimize>\n{{prompt}}\n</prompt_to_optimize>';

/* ---------------- 状态 ---------------- */
let _abort = false;
let _workerTabId = null;
let _openerTabId = null;
let _keepAlive = null;

function fillTemplate(tpl, vars) {
  return String(tpl).replace(/\{\{(\w+)\}\}/g, function (m, n) {
    return (vars && vars[n] !== undefined) ? vars[n] : m;
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function reportStatus(text) {
  try { chrome.storage.local.set({ optStatus: { text: text, ts: Date.now() } }); } catch (e) { /* 忽略 */ }
  if (_openerTabId != null) {
    try { chrome.tabs.sendMessage(_openerTabId, { type: 'OPT_STATUS', text: text }).catch(() => {}); } catch (e) { /* 忽略 */ }
  }
}
function startKeepAlive() {
  stopKeepAlive();
  _keepAlive = setInterval(function () {
    try { chrome.runtime.getPlatformInfo(function () {}); } catch (e) { /* 忽略 */ }
  }, 15000);
}
function stopKeepAlive() {
  if (_keepAlive) { clearInterval(_keepAlive); _keepAlive = null; }
}

async function scriptExec(tabId, func, args) {
  try {
    const res = await chrome.scripting.executeScript({
      target: { tabId: tabId }, world: 'MAIN', func: func, args: args || []
    });
    return res && res[0] ? res[0].result : undefined;
  } catch (e) {
    return undefined;
  }
}
async function scriptPoll(tabId, func, opts) {
  const end = Date.now() + (opts.timeout || 15000);
  while (Date.now() < end) {
    if (_abort) throw new Error('cancelled');
    const r = await scriptExec(tabId, func, opts.args || []);
    if (r != null && r !== false && r !== '') return r;
    await sleep(opts.interval || 400);
  }
  throw new Error('timeout');
}
function waitTabLoad(tabId, timeout) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (fn, arg) => { if (!done) { done = true; chrome.tabs.onUpdated.removeListener(listener); fn(arg); } };
    const timer = setTimeout(() => finish(reject, new Error('tab load timeout')), timeout || 30000);
    const listener = (id, info) => { if (id === tabId && info.status === 'complete') { clearTimeout(timer); finish(resolve); } };
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then((t) => {
      if (t && t.status === 'complete') { clearTimeout(timer); finish(resolve); }
    }).catch(() => {});
  });
}
async function closeWorker() {
  const id = _workerTabId;
  _workerTabId = null;
  if (id != null) { try { await chrome.tabs.remove(id); } catch (e) { /* 可能已被关 */ } }
}

/* 写入文本：多策略 + 抗换行校验
   校验不再逐字比对模板开头（innerText 在 ProseMirror 里会按段落插换行，
   逐字比对必然失败，会误判成"写入失败"，然后清空重写反而把内容抹掉）。
   判定标准：① 归一化空白后包含模板首个词元（如 <task>）；② 文本长度明显增长。 */
async function fillComposer(tabId, text) {
  const fn = async function (payload) {
    const txt = payload.txt;
    const sleepFn = (ms) => new Promise((r) => setTimeout(r, ms));
    const pick = () => document.querySelector('div[contenteditable="true"].ProseMirror[role="textbox"]') ||
      document.querySelector('textarea[aria-label="Chat with ChatGPT"]') ||
      document.querySelector('#prompt-textarea') ||
      document.querySelector('div[contenteditable="true"][role="textbox"]') ||
      document.querySelector('main div[contenteditable="true"]');
    const read = (el) => (el ? (el.isContentEditable ? (el.innerText || el.textContent || '') : (el.value || '')) : '');
    const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    /* 模板第一个词元：不含空白，换行怎么变都能匹配上 */
    const probe = (norm(txt).split(' ')[0] || '').slice(0, 14);
    const want = Math.min(20, txt.trim().length);
    const notes = [];

    const el0 = pick();
    if (!el0) return { ok: false, detail: 'composer not found' };
    const beforeLen = read(pick()).length;

    /* execCommand 在"文档没有焦点"时会静默失败（比如 Chrome 窗口不在最前面）。
       先尽量把焦点抢过来，抢不到就在诊断里如实写出来。 */
    const focusInfo = () => {
      let act = '?';
      try {
        const a = document.activeElement;
        act = a ? (a.tagName.toLowerCase() + (a.id ? '#' + a.id : '') +
          (a.className && typeof a.className === 'string' ? '.' + a.className.split(' ')[0] : '')) : 'null';
      } catch (e) { /* 忽略 */ }
      return 'hasFocus=' + (document.hasFocus ? document.hasFocus() : '?') + ' active=' + act;
    };
    try { window.focus(); } catch (e) { /* 忽略 */ }
    for (let i = 0; i < 12 && document.hasFocus && !document.hasFocus(); i++) await sleepFn(250);

    const check = (tag) => {
      const el = pick();
      const cur = read(el);
      const n = norm(cur);
      /* 归一化空白后包含模板首个词元 → 写进去了 */
      if (probe && n.indexOf(probe) >= 0) return { ok: true, strategy: tag, detail: notes.join(' | ') };
      /* 模板开头没有可辨识词元时，退一步：长度明显增长也算成功 */
      if (cur.length > beforeLen + 10 && cur.length >= want) {
        return { ok: true, strategy: tag + '(仅长度)', detail: notes.join(' | ') };
      }
      return null;
    };
    /* 写进去还不算数：页面 hydrate 完成时 ProseMirror 会把 DOM 重挂一遍，
       刚插进去的文字会被清掉。隔 500ms 再确认一次，被清掉就换下一招。 */
    const stableCheck = async (tag) => {
      const first = check(tag);
      if (!first) return null;
      await sleepFn(500);
      const again = check(tag);
      if (again) return again;
      notes.push(tag + ' 写入后被页面清掉（疑似还没 hydrate）');
      return null;
    };

    // A) execCommand（原版同款，ProseMirror 认这条路径）
    try {
      const el = pick() || el0;
      el.focus();
      document.execCommand('selectAll');
      document.execCommand('insertText', false, txt);
      await sleepFn(200);
      let r = await stableCheck('execCommand');
      if (!r) {
        /* 等页面稳定后重试一次 */
        await sleepFn(1500);
        const el2 = pick() || el0;
        el2.focus();
        document.execCommand('selectAll');
        document.execCommand('insertText', false, txt);
        await sleepFn(250);
        r = await stableCheck('execCommand重试');
      }
      if (r) return r;
      notes.push('execCommand 未生效(len=' + read(pick()).length + ')');
    } catch (e) { notes.push('execCommand 异常:' + e.message); }

    // B) 合成粘贴事件（ProseMirror 的 paste 处理器会读 clipboardData）
    try {
      const el = pick() || el0;
      el.focus();
      const cur = norm(read(el));
      if (cur && cur.indexOf(probe) < 0) {
        document.execCommand('selectAll');
        document.execCommand('delete');
      }
      const dt = new DataTransfer();
      dt.setData('text/plain', txt);
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      await sleepFn(250);
      const r = await stableCheck('paste');
      if (r) return r;
      notes.push('paste 未生效(len=' + read(pick()).length + ')');
    } catch (e) { notes.push('paste 异常:' + e.message); }

    // C) 直接赋值 + input 事件
    try {
      const el = pick() || el0;
      el.focus();
      if (el.isContentEditable) {
        el.textContent = txt;
        el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: txt }));
      } else {
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
        setter.call(el, txt);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
      await sleepFn(250);
      const r = await stableCheck('setter');
      if (r) return r;
      notes.push('setter 未生效(len=' + read(pick()).length + ')');
    } catch (e) { notes.push('setter 异常:' + e.message); }

    /* 失败时把现场情况带回去，方便定位（含选中元素的样子） */
    const el = pick();
    const rect = el ? el.getBoundingClientRect() : null;
    notes.push('现场: <' + (el ? el.tagName.toLowerCase() : '?') +
      ' class=' + (el && el.className ? String(el.className).slice(0, 40) : '') +
      ' editable=' + (el ? el.isContentEditable : '?') +
      ' vis=' + (rect ? Math.round(rect.width) + 'x' + Math.round(rect.height) : '?') +
      ' len=' + read(el).length + '> ' + focusInfo());
    return { ok: false, detail: notes.join(' | ') };
  };
  return await scriptExec(tabId, fn, [{ txt: text }]);
}

/* 发送：等发送按钮出现 → 点击（原版做法），按钮找不到再退回回车。
   是否发出以 __optSseStarted / 停止按钮 / 新助手节点为准，最多等 30 秒。
   只有"连发送按钮都点不到且回车也没用"才返回失败。 */
async function sendComposer(tabId, baseline) {
  const notes = [];
  const clickFn = async function (payload) {
    const base = payload.base || 0;
    const sleepFn = (ms) => new Promise((r) => setTimeout(r, ms));
    const pick = () => document.querySelector('div[contenteditable="true"].ProseMirror[role="textbox"]') ||
      document.querySelector('textarea[aria-label="Chat with ChatGPT"]') ||
      document.querySelector('#prompt-textarea');
    const read = (el) => (el ? (el.isContentEditable ? (el.innerText || '') : (el.value || '')) : '');
    const stop = () => Array.prototype.slice.call(document.querySelectorAll('button[aria-label]'))
      .some((b) => /stop|停止/i.test(b.getAttribute('aria-label') || '') &&
        (b.offsetParent || b.getClientRects().length));
    const started = () => !!window.__optSseStarted || stop() ||
      document.querySelectorAll('div[data-message-author-role="assistant"]').length > base;
    /* 等按钮渲染出来再点：新版是条件渲染，刚写好文本时按钮可能还没出现 */
    const findBtn = () => {
      const b = document.querySelector('button[data-testid="send-button"]') ||
        document.querySelector('button[data-testid="composer-submit-button"]');
      if (b && !b.disabled) return b;
      const cands = Array.prototype.slice.call(document.querySelectorAll('button[aria-label]'));
      return cands.find((x) => /send|发送/i.test(x.getAttribute('aria-label') || '') &&
        !/voice|dictation|语音/i.test(x.getAttribute('aria-label') || '')) || null;
    };
    let clicked = false;
    for (let i = 0; i < 40; i++) {
      const b = findBtn();
      if (b) { b.click(); clicked = true; break; }
      await sleepFn(200);
    }
    const pressEnter = () => {
      const el = pick();
      if (!el) return;
      el.focus();
      ['keydown', 'keyup'].forEach((t) => el.dispatchEvent(new KeyboardEvent(t, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true })));
    };
    for (let i = 0; i < 150; i++) {
      await sleepFn(200);
      if (started()) return { ok: true, strategy: clicked ? 'click' : 'enter', detail: '' };
      /* 没点到按钮：3 秒后补一次回车 */
      if (!clicked && i === 15 && read(pick())) pressEnter();
    }
    return {
      ok: false,
      soft: true,
      detail: clicked ? '已点击发送按钮，但 30 秒内没有生成迹象' : '没有找到发送按钮，回车也未生效'
    };
  };
  const r = await scriptExec(tabId, clickFn, [{ base: baseline || 0 }]);
  return r || { ok: false, soft: true, detail: notes.join(' | ') || '注入失败' };
}

/* 切 thinking/instant pill */
async function setWorkerThinking(tabId, wantThinking) {
  const fn = async function (want) {
    const sleepFn = (ms) => new Promise((r) => setTimeout(r, ms));
    const find = () => {
      const ls = Array.from(document.querySelectorAll('button.__composer-pill[aria-pressed]')).filter((b) => !b.getAttribute('aria-haspopup'));
      return ls.find((b) => /think/i.test((b.textContent || '').trim())) || (ls.length === 1 ? ls[0] : null);
    };
    const p = find();
    if (p) {
      const on = p.getAttribute('aria-pressed') === 'true';
      if (on === want) return 'ok';
      p.click();
      const t0 = Date.now() + 900;
      while (Date.now() < t0) {
        const q = find();
        if (q && (q.getAttribute('aria-pressed') === 'true') === want) break;
        await sleepFn(40);
      }
      return 'ok';
    }
    const p2 = Array.from(document.querySelectorAll('button.__composer-pill')).find((b) => /^(instant|thinking)\b/i.test((b.textContent || '').trim()));
    if (p2) {
      const on = /^thinking\b/i.test((p2.textContent || '').trim());
      if (on !== want) {
        ['pointerdown', 'pointerup', 'click'].forEach((k) => p2.dispatchEvent(new PointerEvent(k, { bubbles: true, cancelable: true, pointerType: 'mouse' })));
        await sleepFn(1000);
      }
      return 'ok';
    }
    return 'none';
  };
  return scriptExec(tabId, fn, [!!wantThinking]);
}

/* 装 fetch hook：收集 SSE（也标记本页为优化 worker）
   原版同款：在 POST /backend-api/f/conversation 同步置 __optSseStarted，
   它是"确实发出去了"最可靠的信号（比看 DOM 里有没有停止按钮可靠得多）。 */
async function installFetchHook(tabId) {
  const fn = function () {
    document.documentElement.setAttribute('data-opt-worker', '1');
    if (window.__optHooked) {
      window.__optSseChunks = [];
      window.__optSseDone = false;
      window.__optSseStarted = false;
      return 'reset';
    }
    window.__optHooked = true;
    window.__optSseChunks = [];
    window.__optSseDone = false;
    window.__optSseStarted = false;
    const orig = window.fetch.bind(window);
    const re = /\/backend-api\/f\/conversation(?:\?|$)/i;
    window.fetch = async function (input, init) {
      const url = (typeof input === 'string' ? input : (input && input.url)) || '';
      const method = ((init && init.method) || (typeof input !== 'string' && input && input.method) || 'GET').toUpperCase();
      const isPost = method === 'POST' && re.test(url);
      let resp;
      /* 发请求前就置位：即使后面 await 还没回来，也能确认"已经发出去了" */
      if (isPost) { window.__optSseChunks = []; window.__optSseDone = false; window.__optSseStarted = true; }
      try {
        resp = await orig.apply(this, arguments);
      } catch (e) {
        if (isPost) window.__optSseDone = true;
        throw e;
      }
      if (isPost) {
        if (resp && resp.body && resp.clone) {
          const clone = resp.clone();
          (async () => {
            try {
              const reader = clone.body.getReader();
              const dec = new TextDecoder();
              for (;;) {
                const r = await reader.read();
                if (r.done) break;
                window.__optSseChunks.push(dec.decode(r.value, { stream: true }));
              }
            } catch (e) { /* 忽略 */ }
            window.__optSseDone = true;
          })();
        } else {
          window.__optSseDone = true;
        }
      }
      return resp;
    };
    return 'hooked';
  };
  return scriptExec(tabId, fn);
}
async function sseStartedFlag(tabId) {
  return scriptExec(tabId, () => (window.__optSseStarted ? true : null));
}
async function sseDoneFlag(tabId) {
  return scriptExec(tabId, () => (window.__optSseDone ? true : null));
}
/* SSE 解析：直接照搬原版（1.2.6）的增量累加器。
   新版接口不再只发整段 message.content.parts，而是 patch/append 增量帧：
     {"p":"/message/content/parts/0","o":"append","v":"..."}
   只认整段的解析器会一无所获 —— 这是"回复了却抓不到结果"的主因之一。 */
async function parseSse(tabId) {
  return scriptExec(tabId, function () {
    if (!window.__optSseDone || !Array.isArray(window.__optSseChunks)) return '';
    const raw = window.__optSseChunks.join('');
    const byId = new Map();
    let curId = null;
    let lastPath = null;
    const slot = (id) => {
      if (!byId.has(id)) byId.set(id, { channel: null, role: null, parts: {} });
      return byId.get(id);
    };
    const pathRe = /^\/message\/content\/parts\/(\d+)$/;
    const handle = (o) => {
      /* 消息头：带 message.id 的完整对象 */
      if (o && o.v && typeof o.v === 'object' && !Array.isArray(o.v) && o.v.message && typeof o.v.message === 'object') {
        const m = o.v.message;
        if (m.id) {
          curId = m.id;
          const s = slot(m.id);
          if (m.channel) s.channel = m.channel;
          if (m.author && m.author.role) s.role = m.author.role;
          const parts = m.content && m.content.parts;
          if (Array.isArray(parts)) parts.forEach((p, i) => { if (typeof p === 'string') s.parts[i] = p; });
          lastPath = null;
          return;
        }
      }
      if (o && o.o === 'patch' && Array.isArray(o.v)) { o.v.forEach(handle); return; }
      if (o && o.o === 'append' && typeof o.p === 'string' && typeof o.v === 'string') {
        const m = o.p.match(pathRe);
        if (m && curId != null) {
          const idx = +m[1];
          const s = slot(curId);
          s.parts[idx] = (s.parts[idx] || '') + o.v;
          lastPath = o.p;
        }
        return;
      }
      /* 续帧：只有 v，路径沿用上一帧 */
      if (o && o.o == null && o.p == null && typeof o.v === 'string' && lastPath != null && curId != null) {
        const m = lastPath.match(pathRe);
        if (m) {
          const idx = +m[1];
          const s = slot(curId);
          s.parts[idx] = (s.parts[idx] || '') + o.v;
        }
      }
    };
    for (const block of raw.split(/\n\n+/)) {
      const m = block.match(/^data:\s*(.+)$/m);
      if (!m) continue;
      const data = m[1].trim();
      if (!data || data === '[DONE]') continue;
      let o;
      try { o = JSON.parse(data); } catch (e) { continue; }
      if (!o || o.type) continue;
      if (o.o || o.p != null || o.v != null) handle(o);
    }
    /* 优先取 channel=final 的那条，否则取最长的一条 */
    let best = null;
    for (const s of byId.values()) if (s.channel === 'final') best = s;
    if (!best) {
      let max = 0;
      for (const s of byId.values()) {
        const len = Object.keys(s.parts).reduce((a, k) => a + String(s.parts[k]).length, 0);
        if (len > max) { max = len; best = s; }
      }
    }
    if (!best) return '';
    return Object.keys(best.parts).map(Number).sort((a, b) => a - b).map((k) => best.parts[k]).join('').trim();
  });
}
async function countAssistant(tabId) {
  const r = await scriptExec(tabId, () => document.querySelectorAll('div[data-message-author-role="assistant"]').length);
  return typeof r === 'number' ? r : 0;
}
/* 取最后一条助手回复；生成中（停止按钮在）不采样，避免抓到半截 */
async function readLastAssistant(tabId, baseline) {
  return scriptExec(tabId, function (base) {
    /* 只有"真实可见"的停止按钮才算生成中：新版页面里隐藏的按钮也会留在 DOM 里，
       不判可见性的话 DOM 兜底会永远等不到结果。 */
    const stop = Array.prototype.slice.call(document.querySelectorAll('button[aria-label]'))
      .find((b) => /stop|停止/i.test(b.getAttribute('aria-label') || '') &&
        (b.offsetParent || b.getClientRects().length));
    if (stop) return null;
    const turns = document.querySelectorAll('div[data-message-author-role="assistant"]');
    if (turns.length <= base) return null;
    const last = turns[turns.length - 1];
    const body = last.querySelector('div.markdown.prose') ||
      last.querySelector('[class*="markdown"][class*="prose"]') || last;
    const text = (body.innerText || '').trim();
    return text || null;
  }, [baseline]);
}

/* ---------------- 消息 ---------------- */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;

  if (msg.type === 'OPT_OPTIMIZE_PROMPT') {
    const openerTab = sender && sender.tab;
    _openerTabId = openerTab && typeof openerTab.id === 'number' ? openerTab.id : null;
    _abort = false;
    startKeepAlive();
    (async () => {
      try {
        if (_openerTabId != null) chrome.storage.local.set({ optOpenerTabId: _openerTabId, optResult: null });
        const st = await chrome.storage.local.get({ optTplNew: null, optTplInChat: null });
        const tplNew = st.optTplNew || DEFAULT_OPT_TEMPLATE_NEW;
        const tplIn = st.optTplInChat || DEFAULT_OPT_TEMPLATE_IN_CHAT;
        const finalMsg = msg.chatContext
          ? fillTemplate(tplIn, {
            prompt: msg.prompt,
            firstUser: msg.chatContext.firstUser || '',
            lastUser: msg.chatContext.lastUser || '',
            lastAssistant: msg.chatContext.lastAssistant || ''
          })
          : fillTemplate(tplNew, { prompt: msg.prompt });

        reportStatus('① 正在打开临时聊天…');
        const createOpts = { url: OPT_WORKER_URL, active: true };
        if (openerTab) { createOpts.index = openerTab.index + 1; createOpts.windowId = openerTab.windowId; }
        const tab = await chrome.tabs.create(createOpts);
        _workerTabId = tab.id;

        await waitTabLoad(tab.id, 30000);
        if (_abort) { await closeWorker(); sendResponse({ cancelled: true }); stopKeepAlive(); return; }
        reportStatus('② 等待输入框就绪…');
        await sleep(800);
        await scriptPoll(tab.id, () => (
          !!(document.querySelector('div[contenteditable="true"].ProseMirror[role="textbox"]') ||
             document.querySelector('textarea[aria-label="Chat with ChatGPT"]') ||
             document.querySelector('#prompt-textarea')) || null
        ), { timeout: 15000, interval: 400 });
        /* 输入框出现 ≠ 页面 hydrate 完成：再等一拍，避免刚写进去的文字被重挂 DOM 清掉 */
        await sleep(700);
        if (_abort) { await closeWorker(); sendResponse({ cancelled: true }); stopKeepAlive(); return; }

        const isTemp = await scriptExec(tab.id, () => /temporary-chat=true/.test(location.search));
        await setWorkerThinking(tab.id, msg.thinkingMode === 'thinking');
        await installFetchHook(tab.id);

        reportStatus('③ 正在写入模板…');
        /* 让窗口和临时聊天页都真正拿到焦点：execCommand 依赖 document 有焦点，
           窗口在后台时它会静默失败（表现就是"三种写法全都没生效"）。 */
        try {
          if (openerTab && openerTab.windowId != null) {
            await chrome.windows.update(openerTab.windowId, { focused: true });
          }
          await chrome.tabs.update(tab.id, { active: true });
          await sleep(250);
        } catch (e) { /* 忽略 */ }
        const fill = await fillComposer(tab.id, finalMsg);
        if (!fill || !fill.ok) {
          const detail = (fill && fill.detail) || '未知原因';
          reportStatus('✗ 写入输入框失败：' + detail);
          sendResponse({ ok: false, error: '写入输入框失败（' + detail + '）', step: 'fill' });
          stopKeepAlive();
          return;
        }

        const baseline = await countAssistant(tab.id);
        reportStatus('④ 正在发送…');
        const sent = await sendComposer(tab.id, baseline);
        let softSend = false;
        if (!sent || !sent.ok) {
          const detail = (sent && sent.detail) || '未知原因';
          if (sent && sent.soft) {
            /* 没能确认，但很可能已经发出去了：不要在这里放弃，否则页面里回复了、
               插件却当失败处理 —— 这正是"回复了但没回填"的成因之一。 */
            softSend = true;
            reportStatus('④ 已发送（未确认），继续等待回复…');
          } else {
            reportStatus('✗ 发送失败：' + detail);
            sendResponse({ ok: false, error: '发送失败（' + detail + '）', step: 'send' });
            stopKeepAlive();
            return;
          }
        }

        reportStatus('⑤ 等待回复…');
        let result = '';
        let how = '';
        try {
          await scriptPoll(tab.id, () => (window.__optSseDone ? true : null), { timeout: 90000, interval: 500 });
          result = (await parseSse(tab.id)) || '';
          if (result) how = 'SSE';
        } catch (e) { /* 走 DOM 兜底 */ }

        if (!result) {
          reportStatus('⑤ 等待回复（DOM 检测）…');
          let prev = '';
          let same = 0;
          let sawReply = false;
          for (let i = 0; i < 180; i++) {
            if (_abort) break;
            const t = await readLastAssistant(tab.id, baseline);
            if (t) {
              sawReply = true;
              same = (t === prev) ? same + 1 : 0;
              prev = t;
              /* 连续 3 次读到完全相同的文本才认为生成结束（避免把流式中间态当结果） */
              if (same >= 2) { result = t; how = 'DOM'; break; }
            }
            /* 连一条回复都没出现：尽快收工，别让用户干等 2 分钟 */
            if (!sawReply && i === 45) { reportStatus('✗ 迟迟没有回复，已停止等待'); break; }
            if (i % 7 === 6) reportStatus('⑤ 正在生成回复…（' + Math.round((i + 1) * 0.7) + ' 秒）');
            await sleep(700);
          }
          if (!result && sawReply && prev) { result = prev; how = 'DOM(未稳定)'; }
        }

        if (!result) {
          const hint = softSend ? '发送未确认，且没抓到回复' : '未捕获到回复内容';
          reportStatus('✗ ' + hint);
          sendResponse({
            ok: false,
            error: hint + '（临时聊天页已保留，可点页面右下角的「↩ 填回原页面」手动回填）',
            step: 'capture',
            softSend: softSend
          });
          stopKeepAlive();
          return;
        }

        reportStatus('⑥ 正在回填…');
        try {
          const act = await chrome.tabs.query({ active: true, currentWindow: true });
          if (_workerTabId != null && act[0] && act[0].id === _workerTabId && _openerTabId != null) {
            chrome.tabs.update(_openerTabId, { active: true }).catch(() => {});
          }
        } catch (e) { /* 忽略 */ }
        await sleep(300);

        /* 原版同款：后台直接把结果写进发起页的输入框（不依赖消息通道是否还活着）。
           写入前先确认输入框里还是用户当初那段原文，避免把用户新写的内容冲掉。 */
        let paste = 'failed';
        if (_openerTabId != null) {
          const r = await scriptExec(_openerTabId, function (payload) {
            const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
            const pick = () => document.querySelector('div[contenteditable="true"].ProseMirror[role="textbox"]') ||
              document.querySelector('textarea[aria-label="Chat with ChatGPT"]') ||
              document.querySelector('#prompt-textarea');
            const el = pick();
            if (!el) return 'no-composer';
            const cur = norm(el.isContentEditable ? el.innerText : el.value);
            if (cur && payload.expect && cur !== norm(payload.expect)) return 'skipped';
            el.focus();
            let ok = false;
            try {
              document.execCommand('selectAll');
              ok = document.execCommand('insertText', false, payload.txt);
            } catch (e) { ok = false; }
            const read = () => norm(el.isContentEditable ? (el.innerText || el.textContent) : el.value);
            if (!ok || read().indexOf(norm(payload.txt).slice(0, 20)) < 0) {
              if (el.isContentEditable) {
                el.innerHTML = '';
                el.appendChild(document.createTextNode(payload.txt));
              } else {
                el.value = payload.txt;
              }
              el.dispatchEvent(new Event('input', { bubbles: true }));
            }
            return read().indexOf(norm(payload.txt).slice(0, 20)) >= 0 ? 'ok' : 'failed';
          }, [{ txt: result.trim(), expect: msg.prompt || '' }]);
          if (r === 'ok' || r === 'skipped' || r === 'failed' || r === 'no-composer') paste = r;
        }

        const payload = {
          text: result.trim(),
          ts: Date.now(),
          how: how,
          tempOk: isTemp === true,
          softSend: softSend,
          sentBy: (sent && sent.strategy) || 'n/a',
          filledBy: (fill && fill.strategy) || 'n/a',
          pasted: paste === 'ok',
          pasteState: paste
        };
        await chrome.storage.local.set({ optResult: payload });
        sendResponse({
          ok: true,
          result: payload.text,
          how: how,
          pasted: paste === 'ok',
          pasteState: paste
        });
        stopKeepAlive();
      } catch (e) {
        const errText = String((e && e.message) || e);
        if (_abort) {
          sendResponse({ cancelled: true });
        } else {
          reportStatus('✗ 出错：' + errText);
          sendResponse({ ok: false, error: errText });
        }
        stopKeepAlive();
      }
    })();
    return true;
  }

  if (msg.type === 'OPT_CANCEL_OPTIMIZE') {
    _abort = true;
    stopKeepAlive();
    closeWorker().then(() => sendResponse && sendResponse({ ok: true }));
    return true;
  }

  /* 领回结果：发起页刷新后输入框空了，把还没被领走的结果补上。
     只有当初发起优化的那个标签页才能领（避免在别的标签页乱填）。 */
  if (msg.type === 'OPT_CLAIM_RESULT') {
    (async () => {
      try {
        const st = await chrome.storage.local.get({ optResult: null, optOpenerTabId: null });
        const o = st.optResult;
        const from = sender && sender.tab ? sender.tab.id : null;
        const sameTab = from != null &&
          ((st.optOpenerTabId != null && from === st.optOpenerTabId) ||
            (_openerTabId != null && from === _openerTabId));
        const fresh = !!(o && o.text && Date.now() - (o.ts || 0) < 10 * 60 * 1000);
        if (fresh && sameTab && !o.claimed) {
          await chrome.storage.local.set({ optResult: Object.assign({}, o, { claimed: true }) });
          sendResponse({ ok: true, text: o.text, how: o.how || '', pastedBefore: !!o.pasted });
        } else {
          sendResponse({ ok: true, text: '' });
        }
      } catch (e) {
        sendResponse({ ok: false, text: '', error: String((e && e.message) || e) });
      }
    })();
    return true;
  }

  /* 诊断用：内容脚本问后台"你还在吗、上一步走到哪" */
  if (msg.type === 'OPT_PING') {
    (async () => {
      let st = {};
      try { st = await chrome.storage.local.get({ optStatus: null, optResult: null }); } catch (e) { /* 忽略 */ }
      sendResponse({
        ok: true,
        version: chrome.runtime.getManifest().version,
        workerTabId: _workerTabId,
        openerTabId: _openerTabId,
        lastStatus: (st && st.optStatus && st.optStatus.text) || '(无)',
        lastResultTs: (st && st.optResult && st.optResult.ts) || 0
      });
    })();
    return true;
  }

  /* 救援通道：临时聊天页按钮 → 回填发起页 */
  if (msg.type === 'OPT_RESCUE') {
    (async () => {
      try {
        const st = await chrome.storage.local.get({ optOpenerTabId: null });
        const target = _openerTabId != null ? _openerTabId : st.optOpenerTabId;
        const text = String(msg.text || '').trim();
        if (!text) { sendResponse && sendResponse({ ok: false, error: '没有可回填的内容' }); return; }
        await chrome.storage.local.set({ optResult: { text: text, ts: Date.now(), how: 'rescue', pasted: false } });
        let msgOk = false;
        if (target != null) {
          try {
            const r = await chrome.tabs.sendMessage(target, { type: 'OPT_BACKFILL', text: text });
            msgOk = !!(r && r.ok);
          } catch (e) { /* 内容脚本可能没在跑 */ }
        }
        /* 消息通道不通就直接注入写入，双保险 */
        let injected = false;
        if (!msgOk && target != null) {
          const r = await scriptExec(target, function (t) {
            const pick = () => document.querySelector('div[contenteditable="true"].ProseMirror[role="textbox"]') ||
              document.querySelector('textarea[aria-label="Chat with ChatGPT"]') ||
              document.querySelector('#prompt-textarea');
            const el = pick();
            if (!el) return false;
            el.focus();
            document.execCommand('selectAll');
            let ok = document.execCommand('insertText', false, t);
            const read = () => String(el.isContentEditable ? (el.innerText || '') : (el.value || ''));
            if (!ok || read().indexOf(t.slice(0, 20)) < 0) {
              if (el.isContentEditable) { el.innerHTML = ''; el.appendChild(document.createTextNode(t)); }
              else { el.value = t; }
              el.dispatchEvent(new Event('input', { bubbles: true }));
            }
            return read().indexOf(t.slice(0, 20)) >= 0;
          }, [text]);
          injected = r === true;
        }
        sendResponse && sendResponse({ ok: msgOk || injected, how: msgOk ? 'message' : (injected ? 'inject' : 'none') });
      } catch (e) {
        sendResponse && sendResponse({ ok: false, error: String((e && e.message) || e) });
      }
    })();
    return true;
  }
});