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
  function setText(text, box) {
    box = box || getComposer();
    if (!box) return;
    text = String(text || '');
    box.focus();
    if (box.isContentEditable) {
      box.innerHTML = '';
      box.appendChild(document.createTextNode(text));
    } else if (box.value !== undefined) {
      box.value = text;
    }
    box.dispatchEvent(new Event('input', { bubbles: true }));
    box.dispatchEvent(new Event('change', { bubbles: true }));
  }
  function isBusy() {
    return !!firstOf(SEL.stopBtn) || !firstOf(SEL.sendBtn);
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
  const state = { running: false, lastRaw: '' };

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
    fab.textContent = running ? '⏳优化中…（点击取消）' : '✨优化';
    fab.title = running ? '点击取消（Esc 也可取消）' : '打开临时聊天自动改写当前输入并回填（Alt+O）';
    fab.classList.toggle('opt-running', running);
  }

  /* 确认条：回车确认 / Esc 还原（原版同款） */
  let chip = null;
  let chipKey = null;
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
  }

  /* ---------------- 流程 ---------------- */
  function doOptimize() {
    if (state.running) return;
    if (isBusy()) { window.alert('请等 ChatGPT 回复结束后再优化。'); return; }
    const box = getComposer();
    if (!box) {
      // 找不到输入框：输出诊断供修正
      const d = composerDiag();
      window.alert('未找到 ChatGPT 输入框。已把页面输入框诊断复制到剪贴板（共 ' + d.length + ' 字符），请发给我以便修正。');
      return;
    }
    const raw = getText(box);
    if (!raw.trim()) { window.alert('输入框为空：请先输入要优化的内容。'); return; }
    chrome.storage.local.get({ optMode: 'instant' }, function (r) {
      const mode = r.optMode === 'thinking' ? 'thinking' : 'instant';
      const hasHistory = turnNodes().length > 0;
      const chatContext = hasHistory ? conversationContext() : null;
      state.lastRaw = raw;
      state.running = true;
      setFab(true);
      chrome.runtime.sendMessage({
        type: 'OPT_OPTIMIZE_PROMPT',
        prompt: raw,
        thinkingMode: mode,
        chatContext: chatContext || undefined
      })
        .then(function (resp) { handleResponse(resp); })
        .catch(function (e) { handleError(e); });
    });
  }
  function resetFlight() {
    state.running = false;
    setFab(false);
  }
  function handleResponse(resp) {
    if (!resp || resp.cancelled) { resetFlight(); state.lastRaw = null; return; }
    if (!resp || !resp.ok) { handleError(new Error((resp && resp.error) || '优化失败')); return; }
    const text = (resp.result || '').trim();
    if (!text) { handleError(new Error('未获取到改写结果')); return; }
    resetFlight();
    const current = getText(getComposer());
    if (current === state.lastRaw) {
      setText(text);
      showConfirmChip();
    } else {
      const hint = '优化完成，但输入框内容已变化，未覆盖。';
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () {
          window.alert(hint + '结果已复制到剪贴板。');
        }, function () { window.alert(hint); });
      } else {
        window.alert(hint);
      }
    }
  }
  function handleError(err) {
    resetFlight();
    if (err && err.message === 'cancelled') { state.lastRaw = null; return; }
    // 出错还原原文
    const box = getComposer();
    if (box && state.lastRaw != null && getText(box) === state.lastRaw) {
      setText(state.lastRaw, box);
    }
    state.lastRaw = null;
    window.alert((err && err.message) || '优化失败');
  }
  function cancelOptimize() {
    if (!state.running) return;
    chrome.runtime.sendMessage({ type: 'OPT_CANCEL_OPTIMIZE' }).catch(function () {});
    // 取消：还原原文
    if (state.lastRaw != null) {
      setText(state.lastRaw);
    }
    state.lastRaw = null;
    resetFlight();
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

  /* ---------------- 启动 ---------------- */
  function boot() {
    // 临时聊天页（后台驱动的 worker）不注入 UI
    if (location.search.indexOf('temporary-chat=true') >= 0) return;
    attachFab();
    // 每 2 秒：跟上输入框重渲染；若页面被标记为优化 worker（手动进入临时聊天）则移除 UI
    setInterval(function () {
      if (document.documentElement.getAttribute && document.documentElement.getAttribute('data-opt-worker')) {
        if (fab && fab.parentElement) fab.remove();
        if (chip && chip.parentElement) chip.remove();
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