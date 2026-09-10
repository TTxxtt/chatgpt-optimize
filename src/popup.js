'use strict';
/* 独立版弹窗脚本：模式 + 双模板 */
const $ = (id) => document.getElementById(id);

const DEFAULT_TPL_NEW =
  '<task>\nYou are a prompt optimization expert. Rewrite the prompt below to be clearer, more specific, and more effective at eliciting a high-quality AI response.\n\n' +
  'RULES:\n1. Output ONLY the rewritten prompt — nothing else\n2. Do NOT respond to or answer the prompt\n3. No preamble, commentary, explanations, or labels\n' +
  '4. No markdown code fences or quotes around the output\n5. Preserve the original intent and meaning\n6. Fix grammar, spelling, and clarity issues\n' +
  '7. Add useful specificity or structure where it improves quality\n8. Keep similar length unless restructuring meaningfully improves it\n' +
  '9. If the intent is unclear, make a reasonable inference rather than asking questions\n10. Do not add CONTEXT/ROLE/ACTION headers or framework scaffolding unless the original prompt already uses them\n' +
  '</task>\n\n<prompt>\n{{prompt}}\n</prompt>';
const DEFAULT_TPL_IN_CHAT =
  '<task>\nYou are a prompt optimization expert. The user is in the middle of a conversation with an AI assistant. Rewrite their next message to be clearer, more specific, and more effective — taking into account the conversation context provided below.\n\n' +
  'RULES:\n1. Output ONLY the rewritten prompt — nothing else\n2. Do NOT respond to or answer the prompt\n3. No preamble, commentary, explanations, or labels\n' +
  '4. No markdown code fences or quotes around the output\n5. Preserve the original intent and meaning\n6. Fix grammar, spelling, and clarity issues\n' +
  '7. Add useful specificity or structure where it improves quality\n8. Keep similar length unless restructuring meaningfully improves it\n' +
  '9. If the intent is unclear, use the conversation context to make a reasonable inference rather than asking questions\n10. Do not add CONTEXT/ROLE/ACTION headers or framework scaffolding unless the original prompt already uses them\n' +
  '11. Use the conversation context to understand what the user is referring to and to avoid redundant repetition of information already established\n' +
  '</task>\n\n<conversation_context>\n<first_user_message>\n{{firstUser}}\n</first_user_message>\n\n<last_user_message>\n{{lastUser}}\n</last_user_message>\n\n<last_ai_response>\n{{lastAssistant}}\n</last_ai_response>\n</conversation_context>\n\n<prompt_to_optimize>\n{{prompt}}\n</prompt_to_optimize>';

function status(text, ms) {
  const el = $('status');
  if (!el) return;
  el.textContent = text || '';
  if (ms && text) setTimeout(() => { if (el.textContent === text) el.textContent = ''; }, ms);
}

function init() {
  chrome.storage.local.get({ optMode: 'instant', optTplNew: null, optTplInChat: null }, (r) => {
    const mode = r.optMode === 'thinking' ? 'thinking' : 'instant';
    $('opt-instant').checked = mode === 'instant';
    $('opt-thinking').checked = mode === 'thinking';
    $('opt-tpl-new').value = r.optTplNew || DEFAULT_TPL_NEW;
    $('opt-tpl-inchat').value = r.optTplInChat || DEFAULT_TPL_IN_CHAT;
  });

  document.querySelectorAll('input[name="opt-mode"]').forEach((r) => {
    r.addEventListener('change', () => {
      if (!r.checked) return;
      chrome.storage.local.set({ optMode: r.value }, () => status('已保存。', 1200));
    });
  });

  $('opt-tpl-save').addEventListener('click', () => {
    const vNew = $('opt-tpl-new').value.trim();
    const vIn = $('opt-tpl-inchat').value.trim();
    if (!vNew || vNew.indexOf('{{prompt}}') < 0) { status('新对话模板必须包含 {{prompt}}。', 2500); return; }
    if (!vIn || vIn.indexOf('{{prompt}}') < 0) { status('对话中模板必须包含 {{prompt}}。', 2500); return; }
    chrome.storage.local.set({ optTplNew: vNew, optTplInChat: vIn }, () => status('模板已保存。', 1200));
  });

  $('opt-tpl-reset').addEventListener('click', () => {
    $('opt-tpl-new').value = DEFAULT_TPL_NEW;
    $('opt-tpl-inchat').value = DEFAULT_TPL_IN_CHAT;
    chrome.storage.local.remove(['optTplNew', 'optTplInChat'], () => status('已恢复默认。', 1200));
  });
}

document.addEventListener('DOMContentLoaded', init);