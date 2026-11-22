// Finanças — frontend (JavaScript puro, sem build)

const $ = (s, el = document) => el.querySelector(s);
const view = $('#view');
const modal = $('#modal');

const state = { accounts: null, categories: null, ctx: {}, filters: null, renderId: 0 };

const DEFAULT_CATEGORIES = [
  'Alimentação', 'Mercado', 'Transporte', 'Moradia', 'Contas', 'Saúde', 'Educação', 'Lazer',
  'Compras', 'Assinaturas', 'Viagem', 'Pets', 'Presentes', 'Impostos', 'Salário', 'Investimentos', 'Outros',
];
const COLORS = ['#0f9d58', '#1a73e8', '#8430ce', '#e8710a', '#d93025', '#12b5cb', '#e52592', '#5f6368'];

// ───────────── formatação ─────────────
const BRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const money = (c) => BRL.format((c || 0) / 100);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const pad = (n) => String(n).padStart(2, '0');
const today = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const thisMonth = () => today().slice(0, 7);
const daysInMonth = (ym) => { const [y, m] = ym.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).getUTCDate(); };
function addMonths(ym, k) {
  const [y, m] = ym.split('-').map(Number);
  const t = y * 12 + (m - 1) + k;
  return `${Math.floor(t / 12)}-${pad((t % 12) + 1)}`;
}
function invoiceFor(date, closingDay, dueDay) {
  const ym = date.slice(0, 7);
  const d = Number(date.slice(8, 10));
  const close = d >= Math.min(closingDay, daysInMonth(ym)) ? 1 : 0;
  return addMonths(ym, close + (dueDay > closingDay ? 0 : 1));
}
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const MONTHS = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const monthLabel = (ym) => { const [y, m] = ym.split('-').map(Number); return `${MONTHS[m - 1]} de ${y}`; };
const shortMonth = (ym) => { const [y, m] = ym.split('-').map(Number); return `${MONTHS[m - 1].slice(0, 3)}/${String(y).slice(2)}`; };
const shortDate = (d) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;
const dayLabel = (d) => {
  const label = new Date(`${d}T12:00:00Z`).toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long', timeZone: 'UTC' });
  return d === today() ? `Hoje · ${label}` : cap(label);
};
function parseMoney(s) {
  s = String(s || '').replace(/[R$\s]/g, '');
  if (!s) return NaN;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 100) : NaN;
}
const moneyInput = (c) => (c == null ? '' : (c / 100).toFixed(2).replace('.', ','));
const initial = (name) => esc((name || '?').trim().charAt(0).toUpperCase());
const accColor = (a) => a?.color || (a?.kind === 'card' ? '#8430ce' : '#0f9d58');

// ───────────── API ─────────────
async function api(path, { method = 'GET', body } = {}) {
  const sep = path.includes('?') ? '&' : '?';
  const url = method === 'GET' ? `${path}${sep}today=${today()}` : path;
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
  } catch {
    throw new Error('Sem conexão ou sessão expirada. Recarregue a página.');
  }
  const type = res.headers.get('content-type') || '';
  if (!type.includes('application/json')) throw new Error('Sessão expirada. Recarregue a página para entrar de novo.');
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Erro ${res.status}`);
  return data;
}

async function ensureAccounts(force = false) {
  if (force || !state.accounts) state.accounts = await api('/api/accounts');
  return state.accounts;
}
async function ensureCategories(force = false) {
  if (force || !state.categories) {
    const used = (await api('/api/categories')).map((c) => c.name);
    state.categories = [...new Set([...used, ...DEFAULT_CATEGORIES])];
  }
  return state.categories;
}

// ───────────── UI util ─────────────
let toastTimer;
function toast(msg, err = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = `show${err ? ' err' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = ''; }, err ? 4000 : 2200);
}

function setHeader(title, { back = false, actions = [] } = {}) {
  $('#title').textContent = title;
  document.title = title === 'Finanças' ? 'Finanças' : `${title} · Finanças`;
  $('#back').hidden = !back;
  const box = $('#top-actions');
  box.innerHTML = '';
  for (const [label, fn] of actions) {
    const b = document.createElement('button');
    b.className = 'top-link';
    b.textContent = label;
    b.onclick = fn;
    box.append(b);
  }
}

function groupByDate(items, rowFn) {
  if (!items.length) return '<div class="empty">Nenhum lançamento</div>';
  let html = '', last = null;
  for (const t of items) {
    if (t.date !== last) {
      if (last !== null) html += '</div>';
      html += `<div class="day-h">${esc(dayLabel(t.date))}</div><div class="card list">`;
      last = t.date;
    }
    html += rowFn(t);
  }
  return `${html}</div>`;
}

function txRow(t, { showAccount = false, showBalance = false, showInvoice = false } = {}) {
  const sub = [esc(t.category || 'Sem categoria')];
  if (showAccount && t.account_name) sub.push(esc(t.account_name));
  if (showInvoice && t.invoice) sub.push(`fatura ${shortMonth(t.invoice)}`);
  if (t.note) sub.push(esc(t.note));
  const parc = t.installments ? ` <span class="muted">(${t.installment}/${t.installments})</span>` : '';
  const sign = t.type === 'in' ? '+' : '−';
  return `<div class="row click" data-tx="${t.id}">
    <div class="main"><div class="t">${esc(t.description)}${parc}</div><div class="s">${sub.join(' · ')}</div></div>
    <div class="v ${t.type}">${sign} ${money(t.amount)}${showBalance ? `<small>saldo ${money(t.running_balance)}</small>` : ''}</div>
  </div>`;
}

function accountOptions(accounts, selected, { includeCards = true, extraId = null } = {}) {
  const list = accounts.filter((a) => (!a.archived || a.id === extraId || a.id === Number(selected)) && (includeCards || a.kind === 'bank'));
  const opt = (a) => `<option value="${a.id}" ${a.id === Number(selected) ? 'selected' : ''}>${esc(a.name)}</option>`;
  const banks = list.filter((a) => a.kind === 'bank').map(opt).join('');
  const cards = list.filter((a) => a.kind === 'card').map(opt).join('');
  return `${banks ? `<optgroup label="Contas">${banks}</optgroup>` : ''}${cards ? `<optgroup label="Cartões">${cards}</optgroup>` : ''}`;
}

function invoiceOptions(center, selected) {
  const months = new Set();
  for (let k = -3; k <= 8; k++) months.add(addMonths(center, k));
  if (selected) months.add(selected);
  return [...months].sort().map((ym) =>
    `<option value="${ym}" ${ym === selected ? 'selected' : ''}>Fatura de ${monthLabel(ym)}</option>`).join('');
}

function openModal(html, onReady) {
  modal.innerHTML = html;
  modal.showModal();
  onReady?.(modal);
  const first = modal.querySelector('[autofocus]');
  if (first && matchMedia('(hover: hover)').matches) first.focus();
}
modal.addEventListener('click', (e) => { if (e.target === modal) modal.close(); });

async function afterChange(msg) {
  modal.close();
  toast(msg);
  state.accounts = null;
  state.categories = null;
  await render();
}

// ───────────── rotas ─────────────
function parseHash() {
  const h = location.hash.replace(/^#/, '') || '/';
  const [path, qs] = h.split('?');
  return { path, q: new URLSearchParams(qs || '') };
}
const go = (hash) => { location.hash = hash; };

async function render() {
  const id = ++state.renderId;
  const { path, q } = parseHash();
  let m;
  state.ctx = {};
  document.querySelectorAll('.tabbar a').forEach((a) => a.classList.remove('active'));
  try {
    if ((m = path.match(/^\/conta\/(\d+)$/))) await bankView(id, Number(m[1]), q);
    else if ((m = path.match(/^\/cartao\/(\d+)$/))) await cardView(id, Number(m[1]), q);
    else if (path === '/lancamentos') { $('[data-tab=search]').classList.add('active'); await searchView(id); }
    else { $('[data-tab=home]').classList.add('active'); await homeView(id); }
    if (!stale(id)) renderSidebar(path);
  } catch (e) {
    if (id === state.renderId) view.innerHTML = `<div class="empty">${esc(e.message)}<br><br><button class="btn small" onclick="location.reload()">Recarregar</button></div>`;
  }
}

const stale = (id) => id !== state.renderId;

// ───────────── barra lateral ─────────────
const sidebar = $('#sidebar');
const scrim = $('#scrim');
function toggleMenu(open) {
  sidebar.classList.toggle('open', open);
  scrim.classList.toggle('show', open);
}
async function renderSidebar(path = parseHash().path) {
  let accounts;
  try { accounts = await ensureAccounts(); } catch { return; }
  const active = accounts.filter((a) => !a.archived);
  const banks = active.filter((a) => a.kind === 'bank');
  const cards = active.filter((a) => a.kind === 'card');
  const link = (href, inner) => `<a class="sb-link${path === href.slice(1) ? ' active' : ''}" href="${href}">${inner}</a>`;
  sidebar.innerHTML = `
    <div class="sb-brand">Finanças</div>
    ${link('#/', '<span class="sb-ic">⌂</span><span class="nm">Início</span>')}
    ${link('#/lancamentos', '<span class="sb-ic">☰</span><span class="nm">Lançamentos</span>')}
    <div class="sb-sec">Contas</div>
    ${banks.map((a) => link(`#/conta/${a.id}`, `<span class="sb-dot" style="background:${esc(accColor(a))}"></span><span class="nm">${esc(a.name)}</span><span class="amt${a.balance < 0 ? ' out' : ''}">${money(a.balance)}</span>`)).join('')}
    <a class="sb-link sb-add" href="javascript:void 0" data-sb-new="bank"><span class="sb-ic">+</span>Nova conta</a>
    <div class="sb-sec">Cartões de crédito</div>
    ${cards.map((a) => link(`#/cartao/${a.id}`, `<span class="sb-dot" style="background:${esc(accColor(a))}"></span><span class="nm">${esc(a.name)}</span><span class="amt${a.current_invoice_total > 0 ? ' out' : ''}">${money(a.current_invoice_total)}</span>`)).join('')}
    <a class="sb-link sb-add" href="javascript:void 0" data-sb-new="card"><span class="sb-ic">+</span>Novo cartão</a>
    <div class="sb-foot">
      <a class="sb-link" href="#" data-sb-transfer><span class="sb-ic">⇄</span>Transferência</a>
      <a class="sb-link" href="/api/export" download="financas-backup.json"><span class="sb-ic">⤓</span>Baixar backup</a>
    </div>`;
  sidebar.querySelectorAll('[data-sb-new]').forEach((b) => {
    b.onclick = (e) => { e.preventDefault(); toggleMenu(false); accountForm(null, b.dataset.sbNew); };
  });
  sidebar.querySelector('[data-sb-transfer]').onclick = (e) => { e.preventDefault(); toggleMenu(false); transferForm(); };
}
$('#menu').onclick = () => toggleMenu(!sidebar.classList.contains('open'));
scrim.onclick = () => toggleMenu(false);
sidebar.addEventListener('click', (e) => { if (e.target.closest('a[href^="#/"]')) toggleMenu(false); });

// ───────────── Início ─────────────
async function homeView(id) {
  setHeader('Finanças');
  if (!view.innerHTML) view.innerHTML = '<div class="loading">Carregando…</div>';
  const s = await api('/api/summary');
  if (stale(id)) return;
  state.accounts = s.accounts;
  const banks = s.accounts.filter((a) => a.kind === 'bank' && !a.archived);
  const cards = s.accounts.filter((a) => a.kind === 'card' && !a.archived);
  const archived = s.accounts.filter((a) => a.archived);
  const maxCat = Math.max(1, ...s.top_categories.map((c) => c.total));

  const bankRows = banks.map((a) => `
    <a class="row click" href="#/conta/${a.id}">
      <div class="dot" style="background:${esc(accColor(a))}">${initial(a.name)}</div>
      <div class="main"><div class="t">${esc(a.name)}</div>
        ${a.projected_balance !== a.balance ? `<div class="s">previsto ${money(a.projected_balance)}</div>` : ''}</div>
      <div class="v ${a.balance < 0 ? 'out' : ''}">${money(a.balance)}</div>
    </a>`).join('');

  const cardRows = cards.map((a) => `
    <a class="row click" href="#/cartao/${a.id}">
      <div class="dot" style="background:${esc(accColor(a))}">${initial(a.name)}</div>
      <div class="main"><div class="t">${esc(a.name)}</div>
        <div class="s">Fatura ${shortMonth(a.current_invoice)} · vence ${shortDate(a.due_date)}${a.available_limit != null ? ` · disponível ${money(a.available_limit)}` : ''}</div></div>
      <div class="v ${a.current_invoice_total > 0 ? 'out' : ''}">${money(a.current_invoice_total)}</div>
    </a>`).join('');

  view.innerHTML = `
    <div class="card hero">
      <div class="label">Saldo atual em contas</div>
      <div class="big ${s.total_balance < 0 ? 'out' : ''}">${money(s.total_balance)}</div>
      ${s.total_projected !== s.total_balance ? `<div class="sub">Previsto até o fim dos lançamentos: ${money(s.total_projected)}</div>` : ''}
    </div>

    <div class="card">
      <h2>Contas <button class="link" data-new="bank">+ Conta</button></h2>
      ${bankRows || '<div class="empty">Cadastre sua primeira conta bancária</div>'}
    </div>

    <div class="card">
      <h2>Cartões de crédito <button class="link" data-new="card">+ Cartão</button></h2>
      ${cardRows || '<div class="empty">Nenhum cartão cadastrado</div>'}
    </div>

    <div class="card">
      <h2>${esc(cap(monthLabel(s.month)))}</h2>
      <div class="stats">
        <div><div class="k">Receitas</div><div class="n in">${money(s.income)}</div></div>
        <div><div class="k">Despesas</div><div class="n out">${money(s.expense)}</div></div>
      </div>
      ${s.top_categories.length ? `<div style="margin-top:12px">${s.top_categories.map((c) => `
        <a class="row click" href="#/lancamentos" data-cat="${esc(c.name)}">
          <div class="main"><div class="t">${esc(c.name)}</div><div class="bar"><i style="width:${(c.total / maxCat) * 100}%"></i></div></div>
          <div class="v">${money(c.total)}</div>
        </a>`).join('')}</div>` : ''}
    </div>

    ${archived.length ? `<div class="card"><h2>Arquivadas</h2>${archived.map((a) => `
      <a class="row click" href="#/${a.kind === 'bank' ? 'conta' : 'cartao'}/${a.id}">
        <div class="dot" style="background:#9aa0a6">${initial(a.name)}</div>
        <div class="main"><div class="t">${esc(a.name)}</div></div>
        <div class="v muted">${a.kind === 'bank' ? money(a.balance) : ''}</div></a>`).join('')}</div>` : ''}

    <footer class="foot"><a href="/api/export" download="financas-backup.json">Baixar backup (JSON)</a></footer>
  `;

  view.querySelectorAll('[data-new]').forEach((b) => { b.onclick = () => accountForm(null, b.dataset.new); });
  view.querySelectorAll('[data-cat]').forEach((a) => {
    a.onclick = () => {
      const m = s.month;
      state.filters = { ...defaultFilters(), from: `${m}-01`, to: `${m}-${pad(daysInMonth(m))}`, category: a.dataset.cat === 'Sem categoria' ? '' : a.dataset.cat, type: 'out' };
    };
  });
}

// ───────────── Conta bancária (extrato mensal) ─────────────
async function bankView(id, accId, q) {
  const month = q.get('m') || thisMonth();
  state.ctx = { account_id: accId };
  const st = await api(`/api/accounts/${accId}/statement?month=${month}`);
  if (stale(id)) return;
  const acc = st.account;
  if (acc.kind === 'card') return go(`#/cartao/${accId}`);
  setHeader(acc.name, { back: true, actions: [['Editar', () => accountForm(acc)]] });

  view.innerHTML = `
    <div class="monthnav">
      <button data-m="${addMonths(month, -1)}" aria-label="Mês anterior">‹</button>
      <span>${esc(cap(monthLabel(month)))}</span>
      <button data-m="${addMonths(month, 1)}" aria-label="Próximo mês">›</button>
    </div>
    <div class="card">
      <div class="stats">
        <div><div class="k">Saldo inicial</div><div class="n">${money(st.opening_balance)}</div></div>
        <div><div class="k">Saldo final do mês</div><div class="n ${st.closing_balance < 0 ? 'out' : ''}">${money(st.closing_balance)}</div></div>
        <div><div class="k">Entradas</div><div class="n in">${money(st.income)}</div></div>
        <div><div class="k">Saídas</div><div class="n out">${money(st.expense)}</div></div>
      </div>
      <div class="btns" style="margin-top:12px">
        <button class="btn small" id="b-new">+ Lançamento</button>
        <button class="btn small ghost" id="b-tr">Transferir</button>
      </div>
    </div>
    ${groupByDate(st.items, (t) => txRow(t, { showBalance: true }))}
  `;
  view.querySelectorAll('[data-m]').forEach((b) => { b.onclick = () => go(`#/conta/${accId}?m=${b.dataset.m}`); });
  $('#b-new').onclick = () => txForm(null, { account_id: accId, date: month === thisMonth() ? today() : `${month}-01` });
  $('#b-tr').onclick = () => transferForm({ from_id: accId });
}

// ───────────── Cartão (fatura) ─────────────
async function cardView(id, accId, q) {
  const f = q.get('f');
  const inv = await api(`/api/accounts/${accId}/invoice${f ? `?invoice=${f}` : ''}`);
  if (stale(id)) return;
  const acc = inv.account;
  if (acc.kind !== 'card') return go(`#/conta/${accId}`);
  state.ctx = { account_id: accId, invoice: inv.invoice };
  setHeader(acc.name, { back: true, actions: [['Editar', () => accountForm(acc)]] });

  const t = today();
  let badge;
  if (inv.paid) badge = '<span class="badge">Paga</span>';
  else if (t >= inv.closing_date && inv.total > 0) badge = `<span class="badge warn">${t > inv.due_date ? 'Vencida' : 'Fechada'}</span>`;
  else if (t >= inv.closing_date) badge = '<span class="badge">Fechada</span>';
  else badge = '<span class="badge" style="color:var(--muted);background:var(--bg)">Aberta</span>';

  view.innerHTML = `
    <div class="monthnav">
      <button data-f="${addMonths(inv.invoice, -1)}" aria-label="Fatura anterior">‹</button>
      <span>Fatura de ${esc(monthLabel(inv.invoice))}</span>
      <button data-f="${addMonths(inv.invoice, 1)}" aria-label="Próxima fatura">›</button>
    </div>
    <div class="card hero">
      <div class="label">${inv.paid ? 'Valor da fatura' : 'Valor a pagar'} ${badge}</div>
      <div class="big ${inv.total > 0 ? 'out' : ''}">${money(inv.paid ? inv.amount_due : inv.total)}</div>
      <div class="sub">Fecha em ${shortDate(inv.closing_date)} · Vence em ${shortDate(inv.due_date)}</div>
      ${inv.payments ? `<div class="sub">Pagamentos: ${money(inv.payments)}${inv.credits ? ` · Estornos: ${money(inv.credits)}` : ''}</div>` : (inv.credits ? `<div class="sub">Estornos/créditos: ${money(inv.credits)}</div>` : '')}
      ${inv.available_limit != null ? `<div class="sub">Limite disponível: ${money(inv.available_limit)} de ${money(acc.credit_limit)}</div>` : ''}
      <div class="btns" style="justify-content:center;margin-top:12px">
        <button class="btn small" id="b-new">+ Lançamento</button>
        ${inv.total > 0 ? '<button class="btn small ghost" id="b-pay">Pagar fatura</button>' : ''}
      </div>
    </div>
    ${groupByDate(inv.items, (x) => txRow(x))}
  `;
  view.querySelectorAll('[data-f]').forEach((b) => { b.onclick = () => go(`#/cartao/${accId}?f=${b.dataset.f}`); });
  $('#b-new').onclick = () => txForm(null, { account_id: accId, type: 'out' });
  const pay = $('#b-pay');
  if (pay) pay.onclick = () => transferForm({ to_id: accId, invoice: inv.invoice, amount: inv.total, date: t });
}

// ───────────── Lançamentos (busca) ─────────────
function defaultFilters() {
  const m = thisMonth();
  return { q: '', account_id: '', type: '', category: '', from: `${m}-01`, to: `${m}-${pad(daysInMonth(m))}`, transfers: '0' };
}

async function searchView(id) {
  setHeader('Lançamentos');
  const [accounts, cats] = await Promise.all([ensureAccounts(), ensureCategories()]);
  if (stale(id)) return;
  const f = state.filters || (state.filters = defaultFilters());

  view.innerHTML = `
    <div class="card">
      <div class="filters">
        <input class="full" type="search" id="f-q" placeholder="Buscar descrição, categoria ou observação" value="${esc(f.q)}">
        <select id="f-acc" class="full"><option value="">Todas as contas e cartões</option>${accountOptions(accounts, f.account_id, { extraId: Number(f.account_id) })}</select>
        <select id="f-type">
          <option value="">Todos os tipos</option>
          <option value="out" ${f.type === 'out' ? 'selected' : ''}>Só saídas</option>
          <option value="in" ${f.type === 'in' ? 'selected' : ''}>Só entradas</option>
        </select>
        <select id="f-cat"><option value="">Categoria</option>${cats.map((c) => `<option ${c === f.category ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>
        <div><label>De</label><input type="date" id="f-from" value="${esc(f.from)}"></div>
        <div><label>Até</label><input type="date" id="f-to" value="${esc(f.to)}"></div>
        <label class="check full"><input type="checkbox" id="f-tr" ${f.transfers === '0' ? '' : 'checked'}> Incluir transferências e pagamentos de fatura</label>
      </div>
      <div class="btns" style="margin-top:10px">
        <button class="btn small ghost" data-p="month">Este mês</button>
        <button class="btn small ghost" data-p="last">Mês passado</button>
        <button class="btn small ghost" data-p="year">Este ano</button>
        <button class="btn small ghost" data-p="all">Tudo</button>
      </div>
    </div>
    <div id="results"><div class="loading">Carregando…</div></div>
  `;

  const read = () => {
    Object.assign(f, {
      q: $('#f-q').value.trim(), account_id: $('#f-acc').value, type: $('#f-type').value,
      category: $('#f-cat').value, from: $('#f-from').value, to: $('#f-to').value,
      transfers: $('#f-tr').checked ? '' : '0',
    });
  };
  let timer;
  const run = async () => {
    read();
    const params = new URLSearchParams(Object.entries(f).filter(([, v]) => v !== ''));
    const box = $('#results');
    try {
      const r = await api(`/api/transactions?${params}`);
      if (stale(id) || !box.isConnected) return;
      box.innerHTML = `
        <div class="card"><div class="stats">
          <div><div class="k">Entradas</div><div class="n in">${money(r.total_in)}</div></div>
          <div><div class="k">Saídas</div><div class="n out">${money(r.total_out)}</div></div>
        </div><div class="hint" style="text-align:center;margin-top:8px">${r.count} lançamento${r.count === 1 ? '' : 's'} · resultado ${money(r.total_in - r.total_out)}${r.count > r.items.length ? ` · mostrando ${r.items.length}` : ''}</div></div>
        ${groupByDate(r.items, (t) => txRow(t, { showAccount: true, showInvoice: true }))}`;
    } catch (e) {
      box.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
    }
  };
  $('#f-q').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 300); });
  ['#f-acc', '#f-type', '#f-cat', '#f-from', '#f-to', '#f-tr'].forEach((s) => $(s).addEventListener('change', run));
  view.querySelectorAll('[data-p]').forEach((b) => {
    b.onclick = () => {
      const t = today(), m = thisMonth(), y = t.slice(0, 4);
      const lm = addMonths(m, -1);
      const ranges = {
        month: [`${m}-01`, `${m}-${pad(daysInMonth(m))}`],
        last: [`${lm}-01`, `${lm}-${pad(daysInMonth(lm))}`],
        year: [`${y}-01-01`, `${y}-12-31`],
        all: ['', ''],
      };
      [$('#f-from').value, $('#f-to').value] = ranges[b.dataset.p];
      run();
    };
  });
  run();
}

// ───────────── Formulário de lançamento ─────────────
async function openTx(id) {
  try {
    const tx = await api(`/api/transactions/${id}`);
    if (tx.transfer) return transferInfo(tx);
    txForm(tx);
  } catch (e) { toast(e.message, true); }
}

async function txForm(tx = null, preset = {}) {
  let accounts, cats;
  try { [accounts, cats] = await Promise.all([ensureAccounts(), ensureCategories()]); } catch (e) { return toast(e.message, true); }
  const active = accounts.filter((a) => !a.archived);
  if (!active.length) { toast('Cadastre uma conta ou cartão primeiro'); return accountForm(null, 'bank'); }

  const v = tx || {
    type: preset.type || 'out', amount: null, description: '', category: '', note: '',
    date: preset.date || today(), account_id: preset.account_id || active[0].id, invoice: preset.invoice || null,
  };
  let type = v.type;
  let invoiceTouched = !!(tx?.invoice || preset.invoice);
  const byId = (aid) => accounts.find((a) => a.id === Number(aid));

  openModal(`
    <form id="txf">
      <h3>${tx ? 'Editar lançamento' : 'Novo lançamento'}</h3>
      <div class="seg" style="margin-top:8px">
        <button type="button" data-v="out">Despesa</button>
        <button type="button" data-v="in">Receita</button>
      </div>
      <label>Valor${tx?.installments ? ' desta parcela' : ''}</label>
      <input class="amount-input" id="t-amount" inputmode="decimal" placeholder="0,00" value="${moneyInput(v.amount)}" autofocus required>
      <label>Descrição</label>
      <input id="t-desc" value="${esc(v.description)}" maxlength="120" required placeholder="Ex.: Mercado">
      <label>Categoria</label>
      <input id="t-cat" list="cat-list" value="${esc(v.category)}" maxlength="40" placeholder="Escolha ou digite">
      <datalist id="cat-list">${cats.map((c) => `<option value="${esc(c)}">`).join('')}</datalist>
      <div class="grid2">
        <div><label>Data</label><input type="date" id="t-date" value="${esc(v.date)}" required></div>
        <div><label>Conta / cartão</label><select id="t-acc">${accountOptions(accounts, v.account_id, { extraId: Number(v.account_id) })}</select></div>
      </div>
      <div id="t-card-box">
        <label>Fatura</label>
        <select id="t-inv"></select>
      </div>
      ${tx ? (tx.installments ? `<div class="note">Parcela ${tx.installment} de ${tx.installments}. Alterações valem só para esta parcela.</div>` : '') : `
        <label>Parcelas</label>
        <select id="t-inst">${Array.from({ length: 24 }, (_, i) => `<option value="${i + 1}">${i === 0 ? 'À vista' : `${i + 1}x`}</option>`).join('')}</select>
        <div class="hint" id="t-inst-hint"></div>`}
      <label>Observação</label>
      <input id="t-note" value="${esc(v.note)}" maxlength="500" placeholder="Opcional">
      <div class="actions">
        ${tx ? '<button type="button" class="btn danger" id="t-del">Excluir</button>' : ''}
        ${tx?.installments ? '<button type="button" class="btn danger" id="t-del-all">Excluir todas</button>' : ''}
        <span class="spacer"></span>
        <button type="button" class="btn ghost" id="t-cancel">Cancelar</button>
        <button class="btn" type="submit">Salvar</button>
      </div>
    </form>`, () => {
    const seg = modal.querySelectorAll('.seg button');
    const setType = (t) => { type = t; seg.forEach((b) => b.classList.toggle('on', b.dataset.v === t)); };
    seg.forEach((b) => { b.onclick = () => setType(b.dataset.v); });
    setType(type);

    const accSel = $('#t-acc'), dateIn = $('#t-date'), invSel = $('#t-inv'), cardBox = $('#t-card-box');
    const refreshInvoice = () => {
      const acc = byId(accSel.value);
      const isCard = acc?.kind === 'card';
      cardBox.hidden = !isCard;
      if (!isCard) return;
      const computed = invoiceFor(dateIn.value || today(), acc.closing_day, acc.due_day);
      const sel = invoiceTouched && invSel.value ? invSel.value : (invoiceTouched && v.invoice ? v.invoice : computed);
      invSel.innerHTML = invoiceOptions(computed, sel);
      if (!invSel.value) invSel.value = computed;
    };
    accSel.onchange = () => { invoiceTouched = false; refreshInvoice(); };
    dateIn.onchange = () => { invoiceTouched = false; refreshInvoice(); };
    invSel.onchange = () => { invoiceTouched = true; };
    refreshInvoice();

    const inst = $('#t-inst');
    if (inst) {
      const hint = () => {
        const n = Number(inst.value), c = parseMoney($('#t-amount').value);
        const acc = byId(accSel.value);
        $('#t-inst-hint').textContent = n > 1
          ? `Valor total dividido em ${n}x${c > 0 ? ` de ~${money(Math.floor(c / n))}` : ''}${acc?.kind === 'card' ? ', uma por fatura' : ', uma por mês'}.`
          : '';
      };
      inst.onchange = hint;
      $('#t-amount').addEventListener('input', hint);
    }

    $('#t-cancel').onclick = () => modal.close();
    if (tx) {
      $('#t-del').onclick = async () => {
        if (!confirm('Excluir este lançamento?')) return;
        try { await api(`/api/transactions/${tx.id}`, { method: 'DELETE' }); await afterChange('Lançamento excluído'); } catch (e) { toast(e.message, true); }
      };
      const delAll = $('#t-del-all');
      if (delAll) delAll.onclick = async () => {
        if (!confirm(`Excluir todas as ${tx.installments} parcelas?`)) return;
        try { await api(`/api/transactions/${tx.id}?all=1`, { method: 'DELETE' }); await afterChange('Parcelas excluídas'); } catch (e) { toast(e.message, true); }
      };
    }

    $('#txf').onsubmit = async (e) => {
      e.preventDefault();
      const amount = parseMoney($('#t-amount').value);
      if (!(amount > 0)) return toast('Informe um valor válido', true);
      const acc = byId(accSel.value);
      const body = {
        type, amount,
        description: $('#t-desc').value.trim(),
        category: $('#t-cat').value.trim(),
        date: dateIn.value,
        account_id: Number(accSel.value),
        invoice: acc?.kind === 'card' ? invSel.value : null,
        note: $('#t-note').value.trim(),
      };
      if (!tx && inst) body.installments = Number(inst.value);
      try {
        if (tx) await api(`/api/transactions/${tx.id}`, { method: 'PUT', body });
        else await api('/api/transactions', { method: 'POST', body });
        await afterChange(tx ? 'Lançamento atualizado' : 'Lançamento salvo');
      } catch (err) { toast(err.message, true); }
    };
  });
}

function transferInfo(tx) {
  openModal(`
    <form>
      <h3>${tx.account_kind === 'card' || /fatura/i.test(tx.description) ? 'Pagamento / transferência' : 'Transferência'}</h3>
      <div class="note">
        <b>${esc(tx.description)}</b><br>
        ${money(tx.amount)} · ${esc(tx.date.split('-').reverse().join('/'))}<br>
        ${tx.type === 'out' ? 'Saída de' : 'Entrada em'} ${esc(tx.account_name)}
      </div>
      <p class="hint">Transferências não podem ser editadas. Para corrigir, exclua e crie de novo (os dois lados são removidos juntos).</p>
      <div class="actions">
        <button type="button" class="btn danger" id="tr-del">Excluir</button>
        <span class="spacer"></span>
        <button type="button" class="btn ghost" id="tr-close">Fechar</button>
      </div>
    </form>`, () => {
    $('#tr-close').onclick = () => modal.close();
    $('#tr-del').onclick = async () => {
      if (!confirm('Excluir esta transferência (os dois lados)?')) return;
      try { await api(`/api/transactions/${tx.id}`, { method: 'DELETE' }); await afterChange('Transferência excluída'); } catch (e) { toast(e.message, true); }
    };
  });
}

// ───────────── Transferência / pagamento de fatura ─────────────
async function transferForm(preset = {}) {
  let accounts;
  try { accounts = await ensureAccounts(); } catch (e) { return toast(e.message, true); }
  const active = accounts.filter((a) => !a.archived);
  const banks = active.filter((a) => a.kind === 'bank');
  if (!banks.length) return toast('Cadastre uma conta bancária primeiro', true);
  const fromId = preset.from_id || banks[0].id;
  const toId = preset.to_id || active.find((a) => a.id !== fromId)?.id;
  const isPay = !!preset.invoice;
  const byId = (aid) => accounts.find((a) => a.id === Number(aid));

  openModal(`
    <form id="trf">
      <h3>${isPay ? 'Pagar fatura' : 'Transferência'}</h3>
      <label>Valor</label>
      <input class="amount-input" id="r-amount" inputmode="decimal" placeholder="0,00" value="${moneyInput(preset.amount)}" autofocus required>
      <div class="grid2">
        <div><label>De</label><select id="r-from">${accountOptions(accounts, fromId, { includeCards: false })}</select></div>
        <div><label>Para</label><select id="r-to">${accountOptions(accounts, toId)}</select></div>
      </div>
      <div id="r-card-box"><label>Fatura</label><select id="r-inv"></select></div>
      <label>Data</label>
      <input type="date" id="r-date" value="${esc(preset.date || today())}" required>
      <label>Descrição</label>
      <input id="r-desc" maxlength="120" placeholder="Automática se vazio">
      <div class="actions">
        <span class="spacer"></span>
        <button type="button" class="btn ghost" id="r-cancel">Cancelar</button>
        <button class="btn" type="submit">${isPay ? 'Pagar' : 'Transferir'}</button>
      </div>
    </form>`, () => {
    const toSel = $('#r-to'), invSel = $('#r-inv'), box = $('#r-card-box');
    const refresh = (keep) => {
      const acc = byId(toSel.value);
      box.hidden = acc?.kind !== 'card';
      if (box.hidden) return;
      const center = keep || invoiceFor(today(), acc.closing_day, acc.due_day);
      invSel.innerHTML = invoiceOptions(center, center);
    };
    toSel.onchange = () => refresh();
    refresh(preset.invoice);
    $('#r-cancel').onclick = () => modal.close();
    $('#trf').onsubmit = async (e) => {
      e.preventDefault();
      const amount = parseMoney($('#r-amount').value);
      if (!(amount > 0)) return toast('Informe um valor válido', true);
      const body = {
        from_id: Number($('#r-from').value), to_id: Number(toSel.value), amount,
        date: $('#r-date').value, description: $('#r-desc').value.trim(),
        invoice: box.hidden ? null : invSel.value,
      };
      try {
        await api('/api/transfers', { method: 'POST', body });
        await afterChange(isPay ? 'Fatura paga' : 'Transferência feita');
      } catch (err) { toast(err.message, true); }
    };
  });
}

// ───────────── Formulário de conta / cartão ─────────────
function accountForm(acc = null, kind = acc?.kind || 'bank') {
  const isCard = kind === 'card';
  const color = acc?.color || (isCard ? COLORS[2] : COLORS[0]);
  openModal(`
    <form id="af">
      <h3>${acc ? 'Editar' : 'Novo'} ${isCard ? 'cartão' : 'conta'}</h3>
      <label>Nome</label>
      <input id="a-name" value="${esc(acc?.name)}" maxlength="60" required placeholder="${isCard ? 'Ex.: Nubank Visa' : 'Ex.: Itaú'}" autofocus>
      ${isCard ? `
        <label>Limite (opcional)</label>
        <input id="a-limit" inputmode="decimal" placeholder="0,00" value="${moneyInput(acc?.credit_limit)}">
        <div class="grid2">
          <div><label>Dia de fechamento</label><input id="a-close" type="number" min="1" max="31" required value="${acc?.closing_day ?? ''}"></div>
          <div><label>Dia de vencimento</label><input id="a-due" type="number" min="1" max="31" required value="${acc?.due_day ?? ''}"></div>
        </div>
        <div class="hint">Compras feitas a partir do dia de fechamento entram na fatura seguinte. A fatura leva o nome do mês do vencimento.</div>
      ` : `
        <label>Saldo inicial</label>
        <input id="a-init" inputmode="decimal" placeholder="0,00" value="${moneyInput(acc?.initial_balance ?? null)}">
        <div class="hint">Saldo da conta antes do primeiro lançamento que você vai registrar. Use "-" para negativo.</div>
      `}
      <label>Cor</label>
      <input type="color" id="a-color" value="${esc(color)}">
      ${acc ? `<label class="check" style="margin-top:14px"><input type="checkbox" id="a-arch" ${acc.archived ? 'checked' : ''}> Arquivar (esconde da tela inicial)</label>` : ''}
      <div class="actions">
        ${acc ? '<button type="button" class="btn danger" id="a-del">Excluir</button>' : ''}
        <span class="spacer"></span>
        <button type="button" class="btn ghost" id="a-cancel">Cancelar</button>
        <button class="btn" type="submit">Salvar</button>
      </div>
    </form>`, () => {
    $('#a-cancel').onclick = () => modal.close();
    if (acc) {
      $('#a-del').onclick = async () => {
        if (!confirm(`Excluir "${acc.name}" e TODOS os seus lançamentos? Isso não pode ser desfeito.\n\nDica: se quiser só esconder, use "Arquivar".`)) return;
        try {
          await api(`/api/accounts/${acc.id}`, { method: 'DELETE' });
          modal.close();
          go('#/');
          await afterChange('Excluído');
        } catch (e) { toast(e.message, true); }
      };
    }
    $('#af').onsubmit = async (e) => {
      e.preventDefault();
      const body = { kind, name: $('#a-name').value.trim(), color: $('#a-color').value, archived: !!$('#a-arch')?.checked };
      if (isCard) {
        const lim = $('#a-limit').value.trim();
        body.credit_limit = lim ? parseMoney(lim) : null;
        if (lim && !(body.credit_limit >= 0)) return toast('Limite inválido', true);
        body.closing_day = Number($('#a-close').value);
        body.due_day = Number($('#a-due').value);
      } else {
        const ini = $('#a-init').value.trim();
        body.initial_balance = ini ? parseMoney(ini) : 0;
        if (Number.isNaN(body.initial_balance)) return toast('Saldo inicial inválido', true);
      }
      try {
        const saved = await api(acc ? `/api/accounts/${acc.id}` : '/api/accounts', { method: acc ? 'PUT' : 'POST', body });
        if (!acc) go(`#/${isCard ? 'cartao' : 'conta'}/${saved.id}`);
        await afterChange(acc ? 'Salvo' : `${isCard ? 'Cartão' : 'Conta'} criado`);
      } catch (err) { toast(err.message, true); }
    };
  });
}

// ───────────── eventos globais ─────────────
view.addEventListener('click', (e) => {
  const row = e.target.closest('[data-tx]');
  if (row) openTx(row.dataset.tx);
});
$('#back').onclick = () => (history.length > 1 ? history.back() : go('#/'));
$('#fab').onclick = () => txForm(null, { ...state.ctx });
window.addEventListener('hashchange', () => { modal.open && modal.close(); toggleMenu(false); render(); });

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

render();
