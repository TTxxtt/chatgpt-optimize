/**
 * ChatGPT 提示词优化（独立版）- 内容脚本
 * 页面侧只做：输入框下方「优化」按钮、Esc 取消、回车确认/Esc 还原、回填。
 * 实际改写全部由后台在"官方临时聊天"里完成（不留历史，前台可见）。
 * 临时聊天页（?temporary-chat=true 或已被后台标记）不注入任何 UI。
 */
'use strict';

(function () {
  if (window.__optContentLoaded) return;
  window.__optContentLoaded = true;

  const SEL = {
    composer: [
      'textarea[aria-label="Chat with ChatGPT"]',
      'div[contenteditable="true"].ProseMirror[role="textbox"]',
      'textarea#prompt-textarea',
      'main div[contenteditable="true"]'
    ],
    sendBtn: [
      'button[data-testid="send-button"]',
      'button[aria-label*="Send"]',
      'button[aria-label*="发送"]'
    ],
    stopBtn: [
      'button[data-testid="stop-button"]',
      'button[aria-label*="Stop"]',
      'button[aria-label*="停止"]'
    ],
    turn: ['main div[data-message-author-role]', 'div[data-message-author-role]'],
    turnBody: ['div.markdown.prose', '.markdown', 'article p']
  };

  function $q(sel, root) { return (root || document).querySelector(sel); }
  function $qa(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function firstOf(list, root) {
    for (let i = 0; i < list.length; i++) {
      const el = (root || document).querySelector(list[i]);
      if (el) return el;
    }
    return null;
  }
  /* 排除扩展自己的 UI（独立版 opt-*；大合体版 sp-*） */
  function isOwnUi(el) {
    return !!(el.closest('#opt-fab') || el.closest('.opt-confirm') ||
      el.closest('[id^="sp-"], [class*=" sp-"], [class^="sp-"]'));
  }
  function visible(el) {
    return !!el.offsetParent || el.getClientRects().length > 0;
  }
  /* 输入框查找：已知候选 → 扫描 contenteditable → 扫描 textarea（动态兜底） */
  function findComposer() {
    const hit = firstOf(SEL.composer);
    if (hit) return hit;
    // 动态扫描 contenteditable（优先 role=textbox，跳过扩展 UI 与隐藏元素）
    const edits = $qa('[contenteditable="true"]');
    let fallback = null;
    for (const el of edits) {
      if (isOwnUi(el) || !visible(el)) continue;
      if (el.getAttribute('role') === 'textbox') return el;
      if (!fallback) fallback = el;
    }
    if (fallback) return fallback;
    // 动态扫描 textarea（优先 aria-label 像聊天输入的，跳过隐藏）
    const tas = $qa('textarea');
    let taBest = null;
    for (const ta of tas) {
      if (isOwnUi(ta) || !visible(ta)) continue;
      const label = (ta.getAttribute('aria-label') || '');
      if (/chat|message|prompt|输入|消息|发送/i.test(label)) return ta;
      if (!taBest) taBest = ta;
    }
    return taBest;
  }
  function getComposer() { return findComposer(); }
  function getText(box) { return (box ? (box.innerText || box.value || '') : ''); }

  /* ============ 诊断（点优化时输出，供定位误报原因） ============ */
  function btnInfo(el) {
    const r = el.getBoundingClientRect();
    return {
      t: el.tagName.toLowerCase(),
      id: el.id || '',
      tid: el.getAttribute('data-testid') || '',
      aria: (el.getAttribute('aria-label') || '').slice(0, 40),
      busy: el.getAttribute('aria-busy') || '',
      pressed: el.getAttribute('aria-pressed') || '',
      dis: !!el.disabled,
      hid: isHidden(el),
      rect: Math.round(r.width) + 'x' + Math.round(r.height) + '@' + Math.round(r.x) + ',' + Math.round(r.y),
      txt: (el.textContent || '').trim().slice(0, 18)
    };
  }
  function buildReport() {
    const box = getComposer();
    const scope = composerScope(box);
    const rep = {
      时间: new Date().toLocaleTimeString(),
      地址: location.href,
      视口: window.innerWidth + 'x' + window.innerHeight,
      会话状态: {
        轮次数: turnNodes().length,
        按钮文案: (document.getElementById('opt-fab') || {}).textContent,
        按钮标题: (document.getElementById('opt-fab') || {}).title,
        确认条存在: !!document.getElementById('opt-confirm'),
        是否判定为在回复: isBusy(getComposer())
      },
      输入框: null,
      判定用的停止按钮: null,
      候选停止按钮: [],
      输入框区域内所有按钮: [],
      全页含stop或停止的按钮: []
    };
    if (box) {
      const r = box.getBoundingClientRect();
      rep.输入框 = {
        命中: box.tagName + (box.getAttribute('role') ? '[role=' + box.getAttribute('role') + ']' : '') +
          (box.className ? '.' + String(box.className).split(' ')[0] : ''),
        内容: JSON.stringify((box.innerText || box.value || '').slice(0, 40)),
        不可用: isHidden(box),
        位置: Math.round(r.width) + 'x' + Math.round(r.height) + '@' + Math.round(r.x) + ',' + Math.round(r.y)
      };
    }
    const stop = visibleStopBtn(box);
    rep.判定用的停止按钮 = stop ? btnInfo(stop) : '无（应判定为"空闲"）';
    rep.候选停止按钮 = $qa('button[data-testid="stop-button"], button[data-testid="composer-submit-button"], button[aria-label*="Stop" i], button[aria-label*="停止"]')
      .slice(0, 8).map(btnInfo);
    if (scope) rep.输入框区域内所有按钮 = Array.prototype.slice.call(scope.querySelectorAll('button')).slice(0, 15).map(btnInfo);
    rep.全页含stop或停止的按钮 = $qa('button').filter(function (b) {
      const k = (b.getAttribute('aria-label') || '') + ' ' + (b.getAttribute('data-testid') || '');
      return /stop|停止/i.test(k);
    }).slice(0, 8).map(function (b) {
      const o = btnInfo(b);
      o.在输入框区域内 = !!(scope && scope.contains(b));
      return o;
    });
    /* 后端状态：能拿到 service worker 就直接问它 */
    rep.后端 = '无响应（后台 service worker 可能已挂）';
    return rep;
  }
  function finishDiagnostic(rep) {
    const txt = JSON.stringify(rep, null, 2);
    console.log('[OPT] 诊断报告:\n' + txt);
    try { chrome.storage.local.set({ optLastReport: txt }); } catch (e) { }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(txt).catch(function () { });
    }
    toast('【诊断模式】报告已复制到剪贴板，请发我：\n' + txt, 20000);
  }
  function runDiagnostic() {
    let rep;
    try { rep = buildReport(); }
    catch (e) { rep = { 构建失败: String((e && e.message) || e) }; }
    let settled = false;
    const done = function () { if (!settled) { settled = true; finishDiagnostic(rep); } };
    try {
      chrome.runtime.sendMessage({ type: 'OPT_PING' }).then(function (r) {
        rep.后端 = r || '后台无返回';
        done();
      }).catch(function (e) {
        rep.后端 = '查询失败: ' + String((e && e.message) || e);
        done();
      });
    } catch (e) {
      rep.后端 = 'sendMessage 不可用: ' + String((e && e.message) || e);
    }
    setTimeout(done, 700); // 后台不响应也要出报告，否则点了没反应
  }

  /* 找不到输入框时输出诊断（复制到剪贴板），供修正选择器 */
  function composerDiag() {
    const info = { url: location.href, readyState: document.readyState };
    info.editable = $qa('[contenteditable="true"]').slice(0, 10).map(function (el) {
      return {
        tag: el.tagName,
        role: el.getAttribute('role') || '',
        cls: (el.className || '').toString().slice(0, 80),
        aria: (el.getAttribute('aria-label') || '').slice(0, 60),
        vis: visible(el)
      };
    });
    info.textareas = $qa('textarea').slice(0, 10).map(function (ta) {
      return {
        aria: (ta.getAttribute('aria-label') || '').slice(0, 60),
        cls: (ta.className || '').toString().slice(0, 60),
        vis: visible(ta),
        len: (ta.value || '').length
      };
    });
    const txt = JSON.stringify(info, null, 2);
    console.log('[OPT] 输入框诊断:\n' + txt);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(txt).catch(function () {});
    }
    return txt;
  }
  /* 写入文本：execCommand 优先（ProseMirror 只认这条路径），失败再退回直接赋值。
     v1.1.0：新版 chatgpt.com 的 contenteditable 直接改 innerHTML 会被 React/ProseMirror
     重渲染清掉，表现为"回复了但没回填"。 */
  function setText(text, box) {
    box = box || getComposer();
    if (!box) return false;
    text = String(text || '');
    const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    /* 用"模板第一个词元"判定，不逐字比对：innerText 会按段落插换行 */
    const probe = (norm(text).split(' ')[0] || '').slice(0, 14);
    box.focus();
    if (box.isContentEditable) {
      let ok = false;
      try {
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(box);
        sel.removeAllRanges();
        sel.addRange(range);
        ok = document.execCommand('insertText', false, text);
      } catch (e) { ok = false; }
      const cur = norm(box.innerText || box.textContent || '');
      if (!ok || !cur || (probe && cur.indexOf(probe) < 0)) {
        box.innerHTML = '';
        box.appendChild(document.createTextNode(text));
        try {
          box.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
        } catch (e) {
          box.dispatchEvent(new Event('input', { bubbles: true }));
        }
      }
    } else if (box.value !== undefined) {
      try {
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
        setter.call(box, text);
      } catch (e) { box.value = text; }
      box.dispatchEvent(new Event('input', { bubbles: true }));
    }
    box.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }
  /* 宽松比较：innerText 常带尾换行/不换行空格，严格相等会把"没变过"误判成"已变化" */
  function sameText(a, b) {
    return String(a == null ? '' : a).replace(/\s+/g, ' ').trim() ===
      String(b == null ? '' : b).replace(/\s+/g, ' ').trim();
  }
  /* 输入框所在区域（发送/停止按钮都在这里），用于把"是否在回复"的判断限定在 composer 附近，
     避免全页扫描误扫到别的按钮。 */
  function composerScope(box) {
    if (!box) return null;
    return box.closest('form') || box.parentElement || null;
  }
  function isHidden(el) {
    try {
      if (!el || !el.isConnected) return true;
      for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
        if (n.getAttribute && n.getAttribute('aria-hidden') === 'true') return true;
        if (typeof n.checkVisibility === 'function' && !n.checkVisibility()) return true;
      }
      if (el.disabled) return true;
      return !visible(el);
    } catch (e) {
      return true; // 任何异常都按"不可用"处理，宁可漏判也不要误报
    }
  }
  /* "正在回复"的判据：composer 附近存在【真实可见的停止按钮】。
     绝不能用「找不到发送按钮」当判据 —— 发送按钮是条件渲染的，
     输入框为空 / 新对话 / 输入法组字时它可能不存在，那样空白页点优化会误报。 */
  function visibleStopBtn(box) {
    const scope = composerScope(box) || document;
    const direct = scope.querySelector('button[data-testid="stop-button"]') ||
      scope.querySelector('button[data-testid="composer-submit-button"][aria-busy="true"]');
    if (direct && !isHidden(direct)) return direct;
    const btns = scope.querySelectorAll('button');
    for (let i = 0; i < btns.length; i++) {
      const b = btns[i];
      const key = (b.getAttribute('aria-label') || '') + ' ' + (b.getAttribute('data-testid') || '');
      if (/(^|\s)stop(\s|$)|停止/i.test(key) && !isHidden(b)) return b;
    }
    return null;
  }
  function isBusy(box) {
    return !!visibleStopBtn(box);
  }
  function turnNodes() {
    for (let i = 0; i < SEL.turn.length; i++) {
      const n = $qa(SEL.turn[i]);
      if (n.length) return n;
    }
    return [];
  }
  function clip(s, max) {
    s = String(s || '').trim();
    return s.length > max ? s.slice(0, max) + '…' : s;
  }
  /* 原版同款上下文：首/末用户消息 + 末助手正文，各 2000 字符 */
  function conversationContext() {
    const turns = turnNodes();
    const users = [], assists = [];
    turns.forEach(function (n) {
      const role = n.getAttribute('data-message-author-role');
      if (!role) return;
      if (role === 'user') {
        const text = (n.innerText || '').trim();
        if (text) users.push(text);
      } else if (role === 'assistant') {
        const body = n.querySelector(SEL.turnBody.join(','));
        const text = ((body || n).innerText || '').trim();
        if (text) assists.push(text);
      }
    });
    return {
      firstUser: users.length ? clip(users[0], 2000) : '（无）',
      lastUser: users.length ? clip(users[users.length - 1], 2000) : '（无）',
      lastAssistant: assists.length ? clip(assists[assists.length - 1], 2000) : '（无）'
    };
  }

  /* ---------------- 状态与 UI ---------------- */
  const state = {
    running: false,
    lastRaw: '',
    reqTs: 0,        // 本次请求发起时间：用于判断 storage 里的结果是新的还是上一轮的
    appliedText: '', // 已回填过的结果，避免"消息 + storage"双通道重复回填
    status: '',
    watch: null
  };
  const WATCH_TIMEOUT = 5 * 60 * 1000; // 后台最多被等 5 分钟，避免"永远转圈"

  function copyText(text, hint) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        toast(hint + '（结果已复制到剪贴板）', 7000);
      }, function () { toast(hint, 7000); });
    } else {
      toast(hint, 7000);
    }
  }
  /* 页面内提示条：不用 window.alert —— 一旦用户勾过"阻止此页面创建更多对话框"，
     alert 会被静音，表现就是"点了没反应"。自己画的条子一定会显示。 */
  let toastEl = null;
  let toastTimer = null;
  function toast(msg, ms) {
    try {
      if (!toastEl) {
        toastEl = document.createElement('div');
        toastEl.id = 'opt-toast';
        document.body.appendChild(toastEl);
      }
      toastEl.textContent = String(msg || '');
      toastEl.classList.add('opt-toast-show');
      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = setTimeout(function () {
        if (toastEl) toastEl.classList.remove('opt-toast-show');
      }, ms || 5000);
    } catch (e) { /* 极端情况下退回 alert */ try { window.alert(msg); } catch (e2) { } }
  }
  /* 扩展被更新/停用后，老页面里的脚本还活着但 chrome.* 已经不能用了 */
  function ctxAlive() {
    try { return !!(chrome && chrome.runtime && chrome.runtime.id); } catch (e) { return false; }
  }
  /* 双通道投递之「storage 通道」：后台把结果写进 optResult，
     即使 sendResponse 因为 service worker 被回收而丢失，这里也能补上。 */
  function startResultWatch() {
    stopResultWatch();
    const deadline = Date.now() + WATCH_TIMEOUT;
    state.watch = setInterval(function () {
      if (Date.now() > deadline) { stopResultWatch(); return; }
      try {
        chrome.storage.local.get({ optResult: null }, function (r) {
          const o = r && r.optResult;
          if (o && o.text && o.ts >= state.reqTs) applyResult(o.text, false);
        });
      } catch (e) { /* 忽略 */ }
    }, 1200);
  }
  function stopResultWatch() {
    if (state.watch) { clearInterval(state.watch); state.watch = null; }
  }
  /* 回填（幂等）：先判断输入框是否还是我们发起时的那段文字 */
  function applyResult(text, force) {
    const t = String(text || '').trim();
    if (!t || state.appliedText === t) return false;
    state.appliedText = t;
    stopResultWatch();
    const lastRaw = state.lastRaw;
    resetFlight();
    const box = getComposer();
    if (!box) {
      copyText(t, '优化完成，但没找到输入框，未回填。');
      return true;
    }
    const current = getText(box);
    if (sameText(current, t)) {
      /* 后台已经直接粘贴进输入框了：只需补确认条 */
      state.lastRaw = lastRaw;
      showConfirmChip();
      return true;
    }
    if (force || !current.trim() || sameText(current, lastRaw)) {
      setText(t, box);
      state.lastRaw = lastRaw; // 保留原文，供 Esc 还原
      box.focus();
      showConfirmChip();
    } else {
      copyText(t, '优化完成，但输入框内容已变化，未覆盖。');
    }
    return true;
  }

  /* 进度显示：把后台上报的步骤写在按钮上，用户能实时看到走到哪一步 */
  function setStatus(text) {
    state.status = text || '';
    if (!fab) return;
    if (fab.classList.contains('opt-running')) {
      fab.textContent = '⏳ ' + state.status + '（点击取消）';
    } else if (/^✗/.test(state.status)) {
      fab.textContent = '✨优化 · 上次失败';
      fab.title = state.status;
    }
  }

  let fab = null;
  /* 按钮跟随输入框：挂到输入框所在容器内，输入框重渲染后自动跟上 */
  function attachFab() {
    const box = getComposer();
    const container = box ? (box.closest('form') || box.parentElement) : null;
    if (!container) {
      if (fab && fab.parentElement) fab.remove();
      return;
    }
    if (fab && fab.parentElement === container) return;
    if (!fab) {
      fab = document.createElement('button');
      fab.id = 'opt-fab';
      fab.type = 'button';
      fab.textContent = '✨优化';
      fab.title = '打开临时聊天自动改写当前输入并回填（Alt+O）';
      fab.addEventListener('click', function () {
        if (state.running) { cancelOptimize(); } else { doOptimize(); }
      });
    }
    if (fab.parentElement) fab.remove();
    container.appendChild(fab);
    setFab(state.running);
  }
  function setFab(running) {
    if (!fab) return;
    fab.classList.toggle('opt-running', running);
    if (running) {
      fab.textContent = '⏳ ' + (state.status || '正在优化…') + '（点击取消）';
      fab.title = '点击取消（Esc 也可取消）';
    } else {
      fab.textContent = '✨优化';
      fab.title = '打开临时聊天自动改写当前输入并回填（Alt+O）';
    }
  }

  /* 确认条：回车确认 / Esc 还原（原版同款） */
  let chip = null;
  let chipKey = null;
  /* 结果已经被确认/还原后清掉存档，避免下次打开页面又被补填一遍 */
  function clearStoredResult() {
    try { chrome.storage.local.set({ optResult: null }); } catch (e) { /* 忽略 */ }
  }
  function showConfirmChip() {
    if (document.getElementById('opt-confirm')) return;
    chip = document.createElement('div');
    chip.id = 'opt-confirm';
    chip.className = 'opt-confirm';
    chip.textContent = '优化结果已填入：回车确认 · Esc 还原';
    document.body.appendChild(chip);
    chipKey = function (e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        rejectRewrite();
      } else if (e.key === 'Enter' && !e.shiftKey) {
        const b = getComposer();
        if (b && (e.target === b || b.contains(e.target))) {
          e.preventDefault();
          e.stopPropagation();
          clearConfirmChip();
          state.lastRaw = null;
          clearStoredResult();
        }
      }
    };
    document.addEventListener('keydown', chipKey, true);
  }
  function clearConfirmChip() {
    if (chip && chip.parentElement) chip.remove();
    chip = null;
    if (chipKey) { document.removeEventListener('keydown', chipKey, true); chipKey = null; }
  }
  function rejectRewrite() {
    const b = getComposer();
    if (b && state.lastRaw != null) {
      setText(state.lastRaw, b);
      b.focus();
    }
    state.lastRaw = null;
    clearConfirmChip();
    clearStoredResult();
  }

  /* ---------------- 流程 ---------------- */
  function doOptimize() {
    if (state.running) return;
    if (!ctxAlive()) {
      toast('扩展刚被更新或停用，本页面的旧脚本已失效：请按 F5 刷新本页面后再点「优化」。', 9000);
      return;
    }
    /* 点下去先给反馈：无论如何都能看到按钮变了 */
    if (fab) { fab.textContent = '⏳ 正在准备…'; }
    const restore = function () { setFab(state.running); };
    try {
      /* 诊断模式：不改写，直接输出报告（在弹窗里打开此开关） */
      chrome.storage.local.get({ optDiag: false }, function (r) {
        if (r && r.optDiag) { restore(); runDiagnostic(); return; }
        proceedOptimize(restore);
      });
    } catch (e) {
      restore();
      toast('扩展上下文已失效：请刷新本页面（F5）后再点。', 9000);
    }
  }
  function proceedOptimize(restore) {
    restore = restore || function () { setFab(state.running); };
    const box = getComposer();
    if (!box) {
      // 找不到输入框：输出诊断供修正
      const d = composerDiag();
      restore();
      toast('未找到 ChatGPT 输入框。已把页面输入框诊断复制到剪贴板（共 ' + d.length + ' 字符），请发给我以便修正。', 9000);
      return;
    }
    /* 顺序很重要：先如实报告"输入为空"，再判断是否正在回复。
       反过来会导致空白输入框点优化时弹出误导性的"请等回复结束"。 */
    const raw = getText(box);
    if (!raw.trim()) { restore(); toast('输入框为空：请先输入要优化的内容。'); return; }
    if (isBusy(box)) { restore(); toast('ChatGPT 正在回复中，请等它回复结束后再点优化。'); return; }
    try {
      chrome.storage.local.get({ optMode: 'instant' }, function (r) {
        const mode = r && r.optMode === 'thinking' ? 'thinking' : 'instant';
        const hasHistory = turnNodes().length > 0;
        const chatContext = hasHistory ? conversationContext() : null;
        state.lastRaw = raw;
        state.running = true;
        state.appliedText = '';
        state.reqTs = Date.now();
        state.status = '正在打开临时聊天…';
        setFab(true);
        startResultWatch(); // 先开好 storage 通道：即便 sendResponse 丢了也能回填
        try {
          chrome.runtime.sendMessage({
            type: 'OPT_OPTIMIZE_PROMPT',
            prompt: raw,
            thinkingMode: mode,
            chatContext: chatContext || undefined,
            reqTs: state.reqTs
          })
            .then(function (resp) { handleResponse(resp); })
            .catch(function (e) { handleResponse(null, e); });
        } catch (e) {
          handleError(new Error('扩展上下文已失效，请刷新页面（F5）后重试'));
        }
      });
    } catch (e) {
      handleError(new Error('扩展上下文已失效，请刷新页面（F5）后重试'));
    }
  }
  function resetFlight() {
    state.running = false;
    setFab(false);
  }
  function handleResponse(resp, err) {
    /* storage 通道已经回填过了，消息通道就不用再管 */
    if (state.appliedText) return;
    if (resp && resp.cancelled) {
      stopResultWatch();
      resetFlight();
      state.lastRaw = null;
      state.status = '';
      return;
    }
    /* 没有返回体（service worker 被回收、消息端口关闭）：不当作失败，
       继续等 storage 通道；按钮上写清楚，避免用户以为插件没反应。 */
    if (!resp) {
      state.status = '等待后台返回结果…';
      setStatus(state.status);
      return;
    }
    if (resp.ok) {
      const text = String(resp.result || '').trim();
      /* 后台已经直接写进输入框了（原版同款通道）：只补确认条，别再写一遍 */
      if (resp.pasted && text) {
        state.appliedText = text;   // 让 storage 通道别重复回填
        stopResultWatch();
        resetFlight();
        if (getComposer()) { getComposer().focus(); showConfirmChip(); }
        return;
      }
      if (text) { applyResult(text, false); return; }
      stopResultWatch();
      resetFlight();
      copyText('', '优化完成，但没有拿到结果内容。');
      return;
    }
    /* 失败：先查一次 storage，可能结果其实已经写进去了 */
    chrome.storage.local.get({ optResult: null }, function (r) {
      const o = r && r.optResult;
      if (o && o.text && o.ts >= state.reqTs) { applyResult(o.text, false); return; }
      handleError(new Error((resp && resp.error) || (err && err.message) || '优化失败'));
    });
  }
  function handleError(err) {
    stopResultWatch();
    resetFlight();
    if (err && err.message === 'cancelled') { state.lastRaw = null; return; }
    // 出错还原原文
    const box = getComposer();
    if (box && state.lastRaw != null && sameText(getText(box), state.lastRaw)) {
      setText(state.lastRaw, box);
    }
    state.lastRaw = null;
    const msg = (err && err.message) || '优化失败';
    state.status = '✗ ' + msg;
    setStatus(state.status);
    /* 失败详情通常很长（含现场诊断），顺手复制到剪贴板，方便直接粘给我 */
    try {
      if (navigator.clipboard && navigator.clipboard.writeText && msg.length > 30) {
        navigator.clipboard.writeText('[优化失败] ' + msg).catch(function () { });
      }
    } catch (e) { /* 忽略 */ }
    toast('优化失败：' + msg + (msg.length > 30 ? '\n（详情已复制到剪贴板，可直接粘给我）' : ''), 15000);
  }
  function cancelOptimize() {
    if (!state.running) return;
    chrome.runtime.sendMessage({ type: 'OPT_CANCEL_OPTIMIZE' }).catch(function () { });
    stopResultWatch();
    state.appliedText = '';
    // 取消：还原原文
    if (state.lastRaw != null) {
      setText(state.lastRaw);
    }
    state.lastRaw = null;
    state.status = '';
    resetFlight();
  }

  /* 双通道投递之「消息通道」：进度 + 回填（后台主动推） */
  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || !msg.type) return;
    if (msg.type === 'OPT_STATUS') {
      if (state.running) setStatus(msg.text);
      if (sendResponse) sendResponse({ ok: true });
      return true;
    }
    if (msg.type === 'OPT_BACKFILL') {
      /* 救援回填：用户在临时聊天页点了「填回原页面」，这里无条件覆盖并给确认条 */
      state.lastRaw = state.lastRaw || getText(getComposer());
      applyResult(msg.text, true);
      if (sendResponse) sendResponse({ ok: true });
      return true;
    }
  });

  /* 打开/刷新页面时补一次：上一轮的结果还在，但当时页面已经关了或刷新了。
     只向后台"领"（后台会确认这就是发起优化的那个标签页）。 */
  function pickupPendingResult() {
    try {
      if (!getComposer() || getText(getComposer()).trim()) return;
      chrome.runtime.sendMessage({ type: 'OPT_CLAIM_RESULT' }).then(function (r) {
        if (!r || !r.text) return;
        const box = getComposer();
        if (!box || getText(box).trim()) return; // 用户已经自己写了东西，别动
        applyResult(r.text, true);
      }).catch(function () { });
    } catch (e) { /* 忽略 */ }
  }

  /* Esc 取消（运行中） */
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && state.running) { e.preventDefault(); cancelOptimize(); }
  }, true);
  /* Alt+O 触发优化 */
  document.addEventListener('keydown', function (e) {
    if (e.altKey && !e.ctrlKey && !e.metaKey && e.key.toLowerCase() === 'o') {
      const box = getComposer();
      if (box && (document.activeElement === box || (box.contains && box.contains(document.activeElement)))) {
        e.preventDefault();
        doOptimize();
      }
    }
  }, true);

  /* ---------------- 临时聊天页（worker）：救援回填按钮 ----------------
     优化失败时临时聊天页会被保留，用户可以直接在那一页点按钮把回复填回发起页，
     不用手动复制粘贴。 */
  let rescue = null;
  function isWorkerPage() {
    if (location.search.indexOf('temporary-chat=true') >= 0) return true;
    return !!(document.documentElement.getAttribute &&
      document.documentElement.getAttribute('data-opt-worker'));
  }
  function lastAssistantText() {
    const turns = $qa('div[data-message-author-role="assistant"]');
    if (!turns.length) return '';
    const last = turns[turns.length - 1];
    const body = last.querySelector(SEL.turnBody.join(',')) || last;
    return ((body.innerText || '').trim());
  }
  function attachRescue() {
    if (rescue && rescue.parentElement) return;
    if (!document.body) return;
    rescue = document.createElement('button');
    rescue.id = 'opt-rescue';
    rescue.type = 'button';
    rescue.textContent = '↩ 填回原页面';
    rescue.title = '把本页最后一条回复填回发起优化的那个标签页输入框';
    rescue.addEventListener('click', function () {
      const text = lastAssistantText();
      if (!text) { toast('本页还没有回复内容可回填。'); return; }
      rescue.disabled = true;
      rescue.textContent = '↩ 正在回填…';
      chrome.runtime.sendMessage({ type: 'OPT_RESCUE', text: text }).then(function (r) {
        if (!rescue) return;
        rescue.disabled = false;
        if (r && r.ok) {
          rescue.textContent = '✓ 已填回原页面';
        } else {
          rescue.textContent = '↩ 填回原页面';
          toast('回填失败：' + ((r && r.error) || '发起页可能已关闭'));
        }
        setTimeout(function () { if (rescue && !rescue.disabled) rescue.textContent = '↩ 填回原页面'; }, 2500);
      }).catch(function () {
        if (!rescue) return;
        rescue.disabled = false;
        rescue.textContent = '↩ 填回原页面';
        toast('回填失败：后台无响应');
      });
    });
    document.body.appendChild(rescue);
  }

  /* ---------------- 启动 ---------------- */
  function boot() {
    // 临时聊天页（后台驱动的 worker）：只放救援按钮，不注入优化按钮
    if (isWorkerPage()) {
      attachRescue();
      setInterval(attachRescue, 2000);
      return;
    }
    attachFab();
    pickupPendingResult();
    // 每 2 秒：跟上输入框重渲染；若页面被标记为优化 worker（手动进入临时聊天）则换成救援按钮
    setInterval(function () {
      if (isWorkerPage()) {
        if (fab && fab.parentElement) fab.remove();
        if (chip && chip.parentElement) chip.remove();
        attachRescue();
        return;
      }
      attachFab();
    }, 2000);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();