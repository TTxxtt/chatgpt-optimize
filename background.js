'use strict';
/* ChatGPT 提示词优化（独立版）- 后台引擎
 * 原版同款架构：收到优化请求 → 前台打开官方临时聊天（?temporary-chat=true，
 * 不留历史）→ scripting 遥控（等输入框 → thinking pill → 填模板 → 发送）
 * → 抓 SSE 收集回答 → 切回发起页 → 回传结果。取消则关临时聊天。
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

function fillTemplate(tpl, vars) {
  return String(tpl).replace(/\{\{(\w+)\}\}/g, function (m, n) {
    return (vars && vars[n] !== undefined) ? vars[n] : m;
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function scriptExec(tabId, func, args) {
  try {
    const res = await chrome.scripting.executeScript({
      target: { tabId: tabId },
      world: 'MAIN',
      func: func,
      args: args || []
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

/* 切 thinking/instant pill（注入 MAIN world，自包含） */
async function setWorkerThinking(tabId, wantThinking) {
  const fn = async function (want) {
    const sleepFn = (ms) => new Promise((r) => setTimeout(r, ms));
    const find = () => {
      const ls = Array.from(document.querySelectorAll('button.__composer-pill[aria-pressed]'))
        .filter((b) => !b.getAttribute('aria-haspopup'));
      return ls.find((b) => /think/i.test((b.textContent || '').trim())) || (ls.length === 1 ? ls[0] : null);
    };
    let p = find();
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
    const p2 = Array.from(document.querySelectorAll('button.__composer-pill'))
      .find((b) => /^(instant|thinking)\b/i.test((b.textContent || '').trim()));
    if (p2) {
      const on = /^thinking\b/i.test((p2.textContent || '').trim());
      if (on !== want) {
        ['pointerdown', 'pointerup', 'click'].forEach((k) =>
          p2.dispatchEvent(new PointerEvent(k, { bubbles: true, cancelable: true, pointerType: 'mouse' })));
        await sleepFn(1200);
      }
      return 'ok';
    }
    return 'none';
  };
  return scriptExec(tabId, fn, [!!wantThinking]);
}

/* 临时聊天页内装 fetch hook：收集 SSE 文本、标记本页（自包含） */
async function installFetchHook(tabId) {
  const fn = function () {
    if (window.__optHooked) return 'already';
    window.__optHooked = true;
    window.__optSseChunks = [];
    window.__optSseDone = false;
    const orig = window.fetch.bind(window);
    const re = /\/backend-api\/f\/conversation(?:\?|$)/i;
    window.fetch = async function (input, init) {
      const url = (typeof input === 'string' ? input : (input && input.url)) || '';
      const method = ((init && init.method) || (typeof input !== 'string' && input && input.method) || 'GET').toUpperCase();
      const isPost = method === 'POST' && re.test(url);
      let resp;
      try {
        resp = await orig.apply(this, arguments);
      } catch (e) {
        if (isPost) window.__optSseDone = true;
        throw e;
      }
      if (isPost && resp && resp.body) {
        window.__optSseChunks = [];
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
      }
      return resp;
    };
    document.documentElement.setAttribute('data-opt-worker', '1');
    return 'hooked';
  };
  return scriptExec(tabId, fn);
}

/* 解析 SSE：取最后一个助手回复文本 */
async function parseResult(tabId) {
  const fn = function () {
    const raw = (window.__optSseChunks || []).join('');
    let last = '';
    let got = false;
    for (const line of raw.split('\n')) {
      const s = line.trim();
      if (s.indexOf('data:') !== 0) continue;
      const data = s.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      let o;
      try { o = JSON.parse(data); } catch (e) { continue; }
      if (o && o.message && o.message.role === 'assistant' && o.message.content && o.message.content.parts) {
        got = true;
        last = o.message.content.parts.join('');
      }
    }
    return got ? last : '';
  };
  return scriptExec(tabId, fn);
}

/* DOM 兜底：最后一条助手消息正文 */
async function domFallback(tabId) {
  const fn = function () {
    const els = Array.from(document.querySelectorAll('div[data-message-author-role="assistant"]'));
    const last = els[els.length - 1];
    if (!last) return '';
    const body = last.querySelector('div.markdown.prose') || last;
    return (body.innerText || '').trim();
  };
  return scriptExec(tabId, fn);
}

/* ---------------- 消息 ---------------- */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;

  if (msg.type === 'OPT_OPTIMIZE_PROMPT') {
    const openerTab = sender && sender.tab;
    _openerTabId = openerTab && typeof openerTab.id === 'number' ? openerTab.id : null;
    _abort = false;
    (async () => {
      try {
        const st = await chrome.storage.local.get({ optTplNew: null, optTplInChat: null });
        const tplNew = st.optTplNew || DEFAULT_OPT_TEMPLATE_NEW;
        const tplIn = st.optTplInChat || DEFAULT_OPT_TEMPLATE_IN_CHAT;
        let finalMsg;
        if (msg.chatContext) {
          finalMsg = fillTemplate(tplIn, {
            prompt: msg.prompt,
            firstUser: msg.chatContext.firstUser || '',
            lastUser: msg.chatContext.lastUser || '',
            lastAssistant: msg.chatContext.lastAssistant || ''
          });
        } else {
          finalMsg = fillTemplate(tplNew, { prompt: msg.prompt });
        }
        // 1) 前台可见打开临时聊天，紧挨发起页
        const createOpts = { url: OPT_WORKER_URL, active: true };
        if (openerTab) {
          createOpts.index = openerTab.index + 1;
          createOpts.windowId = openerTab.windowId;
        }
        const tab = await chrome.tabs.create(createOpts);
        _workerTabId = tab.id;
        // 2) 等加载 + 输入框出现
        await waitTabLoad(tab.id, 30000);
        if (_abort) { await closeWorker(); return sendResponse({ cancelled: true }); }
        await sleep(800);
        await scriptPoll(tab.id, () => (
          !!(document.querySelector('div[contenteditable="true"].ProseMirror[role="textbox"]') ||
             document.querySelector('textarea[aria-label="Chat with ChatGPT"]') ||
             document.querySelector('#prompt-textarea')) || null
        ), { timeout: 15000, interval: 400 });
        if (_abort) { await closeWorker(); return sendResponse({ cancelled: true }); }
        // 3) thinking pill + 装 SSE 捕获
        await setWorkerThinking(tab.id, msg.thinkingMode === 'thinking');
        await installFetchHook(tab.id);
        if (_abort) { await closeWorker(); return sendResponse({ cancelled: true }); }
        // 4) 填模板文本
        await scriptExec(tab.id, function (txt) {
          const el = document.querySelector('div[contenteditable="true"].ProseMirror[role="textbox"]') ||
                    document.querySelector('textarea[aria-label="Chat with ChatGPT"]') ||
                    document.querySelector('#prompt-textarea');
          if (!el) throw new Error('composer not found');
          el.focus();
          document.execCommand('selectAll');
          document.execCommand('insertText', false, txt);
          return true;
        }, [finalMsg]);
        // 5) 点发送
        const clicked = await scriptExec(tab.id, function () {
          const b = document.querySelector('button[data-testid="send-button"]') ||
                    Array.from(document.querySelectorAll('button[aria-label]'))
                      .find((x) => /send/i.test(x.getAttribute('aria-label') || '') && !/voice|dictation/i.test(x.getAttribute('aria-label') || ''));
          if (!b) return false;
          b.click();
          return true;
        });
        if (!clicked) {
          await scriptExec(tab.id, function () {
            const el = document.querySelector('div[contenteditable="true"].ProseMirror[role="textbox"]') ||
                      document.querySelector('textarea[aria-label="Chat with ChatGPT"]') ||
                      document.querySelector('#prompt-textarea');
            if (el) el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
            return true;
          });
        }
        // 6) 等 SSE 完成 → 解析；失败走 DOM
        let result = '';
        try {
          await scriptPoll(tab.id, () => (window.__optSseDone ? true : null), { timeout: 120000, interval: 500 });
          result = (await parseResult(tab.id)) || '';
        } catch (e) { /* 超时走 DOM */ }
        if (!result) {
          try {
            await scriptPoll(tab.id, function () {
              const els = document.querySelectorAll('div[data-message-author-role="assistant"]');
              const last = els[els.length - 1];
              return last ? (last.innerText || '').trim() : null;
            }, { timeout: 120000, interval: 600 });
          } catch (e) { /* 忽略 */ }
          result = await domFallback(tab.id);
        }
        // 7) 保留临时聊天供回看；若它仍是活动标签则切回发起页；回传
        try {
          const act = await chrome.tabs.query({ active: true, currentWindow: true });
          if (_workerTabId != null && act[0] && act[0].id === _workerTabId && _openerTabId != null) {
            chrome.tabs.update(_openerTabId, { active: true }).catch(() => {});
          }
        } catch (e) { /* 忽略 */ }
        _workerTabId = null;
        sendResponse({ ok: true, result: (result || '').trim() });
      } catch (e) {
        await closeWorker().catch(() => {});
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      }
    })();
    return true;
  }

  if (msg.type === 'OPT_CANCEL_OPTIMIZE') {
    _abort = true;
    closeWorker().then(() => sendResponse && sendResponse({ ok: true }));
    return true;
  }
});