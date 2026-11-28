// fin — post-its flutuantes
// O texto e a cor ficam no banco (iguais em todos os aparelhos).
// Posição, tamanho e minimizado ficam neste aparelho (localStorage).

const LAYOUT_KEY = 'fin-notes-layout';
const COLORS = ['yellow', 'pink', 'green', 'blue'];
const MIN_W = 180, MIN_H = 120, HEAD_H = 38;

let deps;            // { api, ask, icon, toast }
let layer;           // container dos post-its
let topZ = 1;
const notes = new Map();   // id -> { data, el, timer }

// ───────── layout salvo neste aparelho ─────────
function loadLayout() {
  try { return JSON.parse(localStorage.getItem(LAYOUT_KEY)) || {}; } catch { return {}; }
}
function saveLayout() {
  const out = {};
  for (const [id, n] of notes) out[id] = n.layout;
  try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(out)); } catch { /* sem armazenamento */ }
}

function defaultLayout(index) {
  const vw = window.innerWidth;
  const w = Math.min(260, vw - 24);
  const h = 220;
  const off = (index % 6) * 26;
  return { x: Math.max(12, vw - w - 18 - off), y: 70 + off, w, h, min: false };
}

function clamp(l) {
  const vw = window.innerWidth, vh = window.innerHeight;
  l.w = Math.max(MIN_W, Math.min(l.w, vw - 8));
  l.h = Math.max(MIN_H, Math.min(l.h, vh - 8));
  const visH = l.min ? HEAD_H : l.h;
  // mantém o post-it inteiro dentro da tela
  l.x = Math.max(4, Math.min(l.x, vw - l.w - 4));
  l.y = Math.max(4, Math.min(l.y, vh - visH - 4));
  return l;
}

// ───────── desenho ─────────
const titleOf = (text) => (text || '').split('\n').find((l) => l.trim())?.trim() || 'Post-it';

function applyLayout(n) {
  const { el, layout: l } = n;
  el.style.left = `${l.x}px`;
  el.style.top = `${l.y}px`;
  el.style.width = `${l.w}px`;
  el.style.height = l.min ? '' : `${l.h}px`;
  el.classList.toggle('min', l.min);
  const btn = el.querySelector('[data-act=min]');
  btn.innerHTML = deps.icon(l.min ? 'arrows-out-simple' : 'minus');
  btn.title = l.min ? 'Maximizar' : 'Minimizar';
  btn.setAttribute('aria-label', btn.title);
  el.querySelector('.pi-title').textContent = l.min ? titleOf(n.data.content) : '';
}

function bringToFront(n) {
  n.el.style.zIndex = String(++topZ);
}

function buildNote(data, layout) {
  const el = document.createElement('section');
  el.className = 'postit';
  el.dataset.color = data.color;
  el.setAttribute('aria-label', 'Post-it');
  el.innerHTML = `
    <header class="pi-head">
      <span class="pi-title"></span>
      <button class="pi-btn" data-act="color" title="Mudar cor" aria-label="Mudar cor">${deps.icon('palette')}</button>
      <button class="pi-btn" data-act="min"></button>
      <button class="pi-btn" data-act="del" title="Excluir" aria-label="Excluir post-it">${deps.icon('trash')}</button>
    </header>
    <textarea class="pi-text" placeholder="Escreva aqui…" spellcheck="true"></textarea>
    <div class="pi-resize" title="Redimensionar" aria-hidden="true"></div>`;
  const ta = el.querySelector('textarea');
  ta.value = data.content;

  const n = { data, el, layout: clamp({ ...layout }), timer: null };
  notes.set(String(data.id), n);
  layer.append(el);
  applyLayout(n);
  bringToFront(n);

  // salvar texto (com atraso) e ao sair do campo
  const flush = async () => {
    clearTimeout(n.timer);
    n.timer = null;
    if (ta.value === n.data.content) return;
    const content = ta.value;
    try {
      n.data = await deps.api(`/api/notes/${data.id}`, { method: 'PUT', body: { content } });
      el.classList.remove('unsaved');
    } catch (e) { deps.toast(e.message, true); }
  };
  ta.addEventListener('input', () => {
    el.classList.add('unsaved');
    clearTimeout(n.timer);
    n.timer = setTimeout(flush, 700);
  });
  ta.addEventListener('blur', flush);
  n.flush = flush;

  el.addEventListener('pointerdown', () => bringToFront(n), true);

  // botões
  el.querySelector('[data-act=min]').onclick = () => toggleMin(n);
  el.querySelector('.pi-head').addEventListener('dblclick', (e) => { if (!e.target.closest('button')) toggleMin(n); });
  el.querySelector('[data-act=color]').onclick = async () => {
    const next = COLORS[(COLORS.indexOf(n.data.color) + 1) % COLORS.length];
    el.dataset.color = next;
    try { n.data = await deps.api(`/api/notes/${data.id}`, { method: 'PUT', body: { color: next } }); }
    catch (e) { el.dataset.color = n.data.color; deps.toast(e.message, true); }
  };
  el.querySelector('[data-act=del]').onclick = async () => {
    const preview = titleOf(ta.value);
    if (!await deps.ask(ta.value.trim() ? `Excluir o post-it "${preview.slice(0, 40)}"?` : 'Excluir este post-it?')) return;
    try {
      clearTimeout(n.timer);
      await deps.api(`/api/notes/${data.id}`, { method: 'DELETE' });
      el.remove();
      notes.delete(String(data.id));
      saveLayout();
    } catch (e) { deps.toast(e.message, true); }
  };

  // arrastar pelo cabeçalho
  drag(el.querySelector('.pi-head'), n, (l, dx, dy, start) => { l.x = start.x + dx; l.y = start.y + dy; });
  // redimensionar pelo canto
  drag(el.querySelector('.pi-resize'), n, (l, dx, dy, start) => { l.w = start.w + dx; l.h = start.h + dy; });
  return n;
}

function drag(handle, n, apply) {
  handle.addEventListener('pointerdown', (e) => {
    if (e.button > 0 || e.target.closest('button')) return;
    if (handle.classList.contains('pi-resize') && n.layout.min) return;
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    const sx = e.clientX, sy = e.clientY;
    const start = { ...n.layout };
    n.el.classList.add('dragging');
    const move = (ev) => {
      apply(n.layout, ev.clientX - sx, ev.clientY - sy, start);
      clamp(n.layout);
      applyLayout(n);
    };
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      n.el.classList.remove('dragging');
      saveLayout();
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  });
}

function toggleMin(n) {
  n.layout.min = !n.layout.min;
  if (n.layout.min) n.flush?.();
  clamp(n.layout);
  applyLayout(n);
  bringToFront(n);
  saveLayout();
  if (!n.layout.min) n.el.querySelector('textarea').focus({ preventScroll: true });
}

// ───────── API pública ─────────
export function initNotes(d) {
  deps = d;
  layer = document.createElement('div');
  layer.id = 'postits';
  document.body.append(layer);
  window.addEventListener('resize', () => {
    for (const n of notes.values()) { clamp(n.layout); applyLayout(n); }
  });
  // salva texto pendente se a página for fechada/ocultada
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') for (const n of notes.values()) if (n.timer) n.flush();
  });
}

export async function loadNotes() {
  clearNotes();
  let list;
  try { list = await deps.api('/api/notes'); } catch { return; }
  const saved = loadLayout();
  list.forEach((data, i) => buildNote(data, saved[data.id] || defaultLayout(i)));
}

export function clearNotes() {
  for (const n of notes.values()) n.el.remove();
  notes.clear();
}

export async function newNote() {
  try {
    const data = await deps.api('/api/notes', { method: 'POST', body: {} });
    const n = buildNote(data, defaultLayout(notes.size));
    saveLayout();
    n.el.querySelector('textarea').focus({ preventScroll: true });
  } catch (e) { deps.toast(e.message, true); }
}

