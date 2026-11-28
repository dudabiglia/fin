// Finanças — Cloudflare Worker (API + arquivos estáticos)
// Valores monetários são sempre inteiros em centavos.

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) {
      return env.ASSETS ? env.ASSETS.fetch(request) : new Response('Not found', { status: 404 });
    }
    try {
      if (url.pathname.startsWith('/api/auth/')) return await authRoute(request, env, url);
      if (!(await currentSession(request, env))) throw new HttpError(401, 'Faça login para continuar');
      return await route(request, env, url);
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message }, err.status);
      console.error(err);
      return json({ error: 'Erro interno no servidor' }, 500);
    }
  },
};

// ───────────────────────── utilidades ─────────────────────────

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}

const pad = (n) => String(n).padStart(2, '0');
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-\d{2}$/;

export function addMonths(ym, k) {
  const [y, m] = ym.split('-').map(Number);
  const total = y * 12 + (m - 1) + k;
  return `${Math.floor(total / 12)}-${pad((total % 12) + 1)}`;
}

function daysInMonth(ym) {
  const [y, m] = ym.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function addMonthsToDate(date, k) {
  const ym = addMonths(date.slice(0, 7), k);
  const d = Math.min(Number(date.slice(8, 10)), daysInMonth(ym));
  return `${ym}-${pad(d)}`;
}

function dayIn(ym, day) {
  return `${ym}-${pad(Math.min(day, daysInMonth(ym)))}`;
}

// Fatura = mês em que ela FECHA. Compras a partir do dia de fechamento vão para a fatura do mês seguinte.
// O vencimento cai no mesmo mês (se o dia de vencimento for depois do fechamento) ou no mês seguinte.
export function invoiceFor(date, closingDay, dueDay) {
  const ym = date.slice(0, 7);
  const d = Number(date.slice(8, 10));
  return addMonths(ym, d >= Math.min(closingDay, daysInMonth(ym)) ? 1 : 0);
}

function invoiceDates(invoice, closingDay, dueDay) {
  const dueMonth = dueDay > closingDay ? invoice : addMonths(invoice, 1);
  return { closing_date: dayIn(invoice, closingDay), due_date: dayIn(dueMonth, dueDay) };
}

function todayParam(url) {
  const t = url.searchParams.get('today');
  if (t && DATE_RE.test(t)) return t;
  // fallback: horário de Brasília
  return new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
}

async function readBody(request) {
  try {
    return await request.json();
  } catch {
    throw new HttpError(400, 'JSON inválido');
  }
}

function req(cond, msg) {
  if (!cond) throw new HttpError(400, msg);
}

function cents(v, field, { allowZero = false, allowNegative = false } = {}) {
  const n = Number(v);
  req(Number.isInteger(n), `${field}: valor inválido`);
  if (!allowNegative) req(allowZero ? n >= 0 : n > 0, `${field}: precisa ser maior que zero`);
  return n;
}

function str(v, field, { required = false, max = 200 } = {}) {
  if (v === undefined || v === null || String(v).trim() === '') {
    req(!required, `${field} é obrigatório`);
    return null;
  }
  const s = String(v).trim();
  req(s.length <= max, `${field} muito longo`);
  return s;
}

function day(v, field) {
  const n = Number(v);
  req(Number.isInteger(n) && n >= 1 && n <= 31, `${field} deve ser entre 1 e 31`);
  return n;
}

async function getAccount(env, id) {
  const acc = await env.DB.prepare('SELECT * FROM accounts WHERE id = ?').bind(Number(id)).first();
  if (!acc) throw new HttpError(404, 'Conta não encontrada');
  return acc;
}

const SIGNED = "CASE t.type WHEN 'in' THEN t.amount ELSE -t.amount END";

// ───────────────────────── rotas ─────────────────────────

async function route(request, env, url) {
  const p = url.pathname.replace(/\/+$/, '');
  const m = request.method;
  let r;

  if (p === '/api/summary' && m === 'GET') return json(await summary(env, url));
  if (p === '/api/accounts' && m === 'GET') return json(await listAccounts(env, todayParam(url)));
  if (p === '/api/accounts' && m === 'POST') return json(await saveAccount(env, null, await readBody(request)), 201);
  if ((r = p.match(/^\/api\/accounts\/(\d+)$/))) {
    if (m === 'PUT') return json(await saveAccount(env, r[1], await readBody(request)));
    if (m === 'DELETE') return json(await deleteAccount(env, r[1]));
  }
  if ((r = p.match(/^\/api\/accounts\/(\d+)\/statement$/)) && m === 'GET') return json(await statement(env, r[1], url));
  if ((r = p.match(/^\/api\/accounts\/(\d+)\/invoice$/)) && m === 'GET') return json(await invoice(env, r[1], url));

  if (p === '/api/transactions' && m === 'GET') return json(await searchTransactions(env, url));
  if (p === '/api/transactions' && m === 'POST') return json(await createTransaction(env, await readBody(request)), 201);
  if ((r = p.match(/^\/api\/transactions\/(\d+)$/))) {
    if (m === 'GET') return json(await getTransaction(env, r[1]));
    if (m === 'PUT') return json(await updateTransaction(env, r[1], await readBody(request)));
    if (m === 'DELETE') return json(await deleteTransaction(env, r[1], url.searchParams.get('all') === '1'));
  }
  if (p === '/api/transfers' && m === 'POST') return json(await createTransfer(env, await readBody(request)), 201);
  if (p === '/api/categories' && m === 'GET') return json(await categories(env));
  if (p === '/api/export' && m === 'GET') return json(await exportAll(env));
  if (p === '/api/notes' && m === 'GET') return json(await listNotes(env));
  if (p === '/api/notes' && m === 'POST') return json(await saveNote(env, null, await readBody(request)), 201);
  if ((r = p.match(/^\/api\/notes\/(\d+)$/))) {
    if (m === 'PUT') return json(await saveNote(env, r[1], await readBody(request)));
    if (m === 'DELETE') return json(await deleteNote(env, r[1]));
  }

  throw new HttpError(404, 'Rota não encontrada');
}

// ───────────────────────── contas ─────────────────────────

async function listAccounts(env, today) {
  const { results: rows } = await env.DB.prepare(
    `SELECT a.*,
       COALESCE(SUM(CASE WHEN t.date <= ?1 THEN ${SIGNED} END), 0) AS sum_today,
       COALESCE(SUM(${SIGNED}), 0) AS sum_all
     FROM accounts a LEFT JOIN transactions t ON t.account_id = a.id
     GROUP BY a.id
     ORDER BY a.archived, a.kind, a.name COLLATE NOCASE`
  ).bind(today).all();

  const { results: inv } = await env.DB.prepare(
    `SELECT t.account_id, t.invoice, SUM(CASE t.type WHEN 'out' THEN t.amount ELSE -t.amount END) AS total
     FROM transactions t JOIN accounts a ON a.id = t.account_id
     WHERE a.kind = 'card' AND t.invoice IS NOT NULL
     GROUP BY t.account_id, t.invoice`
  ).all();

  return rows.map((a) => {
    const base = {
      id: a.id, name: a.name, kind: a.kind, color: a.color, archived: !!a.archived,
    };
    if (a.kind === 'bank') {
      return {
        ...base,
        initial_balance: a.initial_balance,
        balance: a.initial_balance + a.sum_today,
        projected_balance: a.initial_balance + a.sum_all,
      };
    }
    const current = today.slice(0, 7); // resumos mostram sempre a fatura do mês atual
    const curTotal = inv.find((i) => i.account_id === a.id && i.invoice === current)?.total ?? 0;
    const outstanding = -a.sum_all;
    return {
      ...base,
      credit_limit: a.credit_limit,
      closing_day: a.closing_day,
      due_day: a.due_day,
      current_invoice: current,
      current_invoice_total: curTotal,
      ...invoiceDates(current, a.closing_day, a.due_day),
      outstanding,
      available_limit: a.credit_limit != null ? a.credit_limit - outstanding : null,
    };
  });
}

async function saveAccount(env, id, b) {
  const existing = id ? await getAccount(env, id) : null;
  const kind = existing ? existing.kind : b.kind;
  req(kind === 'bank' || kind === 'card', 'Tipo deve ser "bank" ou "card"');

  const name = str(b.name, 'Nome', { required: true, max: 60 });
  const color = str(b.color, 'Cor', { max: 20 });
  const archived = b.archived ? 1 : 0;
  let initial = 0, limit = null, closing = null, due = null;
  if (kind === 'bank') {
    initial = b.initial_balance == null || b.initial_balance === '' ? 0
      : cents(b.initial_balance, 'Saldo inicial', { allowNegative: true });
  } else {
    limit = b.credit_limit == null || b.credit_limit === '' ? null : cents(b.credit_limit, 'Limite', { allowZero: true });
    closing = day(b.closing_day, 'Dia de fechamento');
    due = day(b.due_day, 'Dia de vencimento');
  }

  if (existing) {
    await env.DB.prepare(
      `UPDATE accounts SET name=?, color=?, archived=?, initial_balance=?, credit_limit=?, closing_day=?, due_day=? WHERE id=?`
    ).bind(name, color, archived, initial, limit, closing, due, existing.id).run();
    return getAccount(env, existing.id);
  }
  const res = await env.DB.prepare(
    `INSERT INTO accounts (name, kind, color, archived, initial_balance, credit_limit, closing_day, due_day)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(name, kind, color, archived, initial, limit, closing, due).run();
  return getAccount(env, res.meta.last_row_id);
}

async function deleteAccount(env, id) {
  const acc = await getAccount(env, id);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM transactions WHERE account_id = ?').bind(acc.id),
    env.DB.prepare('DELETE FROM accounts WHERE id = ?').bind(acc.id),
  ]);
  return { ok: true };
}

// Extrato mensal de uma conta bancária, com saldo corrente
async function statement(env, id, url) {
  const acc = await getAccount(env, id);
  const month = url.searchParams.get('month');
  req(month && MONTH_RE.test(month), 'Parâmetro month (YYYY-MM) obrigatório');
  const from = `${month}-01`;
  const to = `${month}-${pad(daysInMonth(month))}`;

  const before = await env.DB.prepare(
    `SELECT COALESCE(SUM(${SIGNED}), 0) AS s FROM transactions t WHERE t.account_id = ? AND t.date < ?`
  ).bind(acc.id, from).first();
  const { results } = await env.DB.prepare(
    `SELECT * FROM transactions WHERE account_id = ? AND date BETWEEN ? AND ? ORDER BY date, id`
  ).bind(acc.id, from, to).all();

  const opening = acc.kind === 'bank' ? acc.initial_balance + before.s : before.s;
  let running = opening, income = 0, expense = 0;
  const items = results.map((t) => {
    if (t.type === 'in') { running += t.amount; income += t.amount; } else { running -= t.amount; expense += t.amount; }
    return { ...t, running_balance: running };
  });
  return { account: acc, month, opening_balance: opening, income, expense, closing_balance: running, items: items.reverse() };
}

// Fatura de um cartão
async function invoice(env, id, url) {
  const acc = await getAccount(env, id);
  req(acc.kind === 'card', 'Esta conta não é um cartão');
  const inv = url.searchParams.get('invoice') || todayParam(url).slice(0, 7);
  req(MONTH_RE.test(inv), 'Fatura inválida (YYYY-MM)');
  const { results } = await env.DB.prepare(
    `SELECT * FROM transactions WHERE account_id = ? AND invoice = ? ORDER BY date DESC, id DESC`
  ).bind(acc.id, inv).all();

  let purchases = 0, credits = 0, payments = 0;
  for (const t of results) {
    if (t.type === 'out') purchases += t.amount;
    else if (t.transfer) payments += t.amount;
    else credits += t.amount;
  }
  const total = purchases - credits - payments;
  const out = await env.DB.prepare(
    `SELECT COALESCE(SUM(CASE type WHEN 'out' THEN amount ELSE -amount END), 0) AS s FROM transactions WHERE account_id = ?`
  ).bind(acc.id).first();

  return {
    account: acc,
    invoice: inv,
    ...invoiceDates(inv, acc.closing_day, acc.due_day),
    purchases, credits, payments,
    amount_due: purchases - credits,
    total,
    paid: purchases - credits > 0 && total <= 0,
    outstanding: out.s,
    available_limit: acc.credit_limit != null ? acc.credit_limit - out.s : null,
    items: results,
  };
}

// ───────────────────────── lançamentos ─────────────────────────

async function getTransaction(env, id) {
  const t = await env.DB.prepare(
    `SELECT t.*, a.name AS account_name, a.kind AS account_kind FROM transactions t
     JOIN accounts a ON a.id = t.account_id WHERE t.id = ?`
  ).bind(Number(id)).first();
  if (!t) throw new HttpError(404, 'Lançamento não encontrado');
  return t;
}

function validateTx(b) {
  req(b.type === 'in' || b.type === 'out', 'Tipo deve ser "in" ou "out"');
  req(DATE_RE.test(b.date || ''), 'Data inválida (YYYY-MM-DD)');
  if (b.invoice != null && b.invoice !== '') req(MONTH_RE.test(b.invoice), 'Fatura inválida (YYYY-MM)');
  return {
    type: b.type,
    amount: cents(b.amount, 'Valor'),
    description: str(b.description, 'Descrição', { required: true, max: 120 }),
    category: str(b.category, 'Categoria', { max: 40 }),
    date: b.date,
    note: str(b.note, 'Observação', { max: 500 }),
    invoice: b.invoice || null,
  };
}

async function createTransaction(env, b) {
  const acc = await getAccount(env, b.account_id);
  const t = validateTx(b);
  const n = b.installments == null || b.installments === '' ? 1 : Number(b.installments);
  req(Number.isInteger(n) && n >= 1 && n <= 72, 'Parcelas deve ser entre 1 e 72');

  const isCard = acc.kind === 'card';
  const baseInvoice = isCard ? (t.invoice || invoiceFor(t.date, acc.closing_day, acc.due_day)) : null;
  const groupId = n > 1 ? crypto.randomUUID() : null;
  const per = Math.floor(t.amount / n);
  req(per > 0, 'Valor pequeno demais para o número de parcelas');
  const first = t.amount - per * (n - 1);

  const stmts = [];
  for (let k = 0; k < n; k++) {
    stmts.push(env.DB.prepare(
      `INSERT INTO transactions (account_id, type, amount, description, category, date, invoice, group_id, installment, installments, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      acc.id, t.type, k === 0 ? first : per, t.description, t.category,
      isCard ? t.date : addMonthsToDate(t.date, k),
      isCard ? addMonths(baseInvoice, k) : null,
      groupId, n > 1 ? k + 1 : null, n > 1 ? n : null, t.note
    ));
  }
  const res = await env.DB.batch(stmts);
  return getTransaction(env, res[0].meta.last_row_id);
}

async function updateTransaction(env, id, b) {
  const cur = await getTransaction(env, id);
  req(!cur.transfer, 'Transferências não podem ser editadas; exclua e crie de novo');
  const acc = await getAccount(env, b.account_id ?? cur.account_id);
  const t = validateTx({ ...cur, ...b });
  let inv = null;
  if (acc.kind === 'card') {
    const dateChanged = b.date && b.date !== cur.date;
    inv = b.invoice || (!dateChanged && cur.invoice && cur.account_id === acc.id ? cur.invoice : null)
      || invoiceFor(t.date, acc.closing_day, acc.due_day);
  }
  await env.DB.prepare(
    `UPDATE transactions SET account_id=?, type=?, amount=?, description=?, category=?, date=?, invoice=?, note=? WHERE id=?`
  ).bind(acc.id, t.type, t.amount, t.description, t.category, t.date, inv, t.note, cur.id).run();
  return getTransaction(env, cur.id);
}

async function deleteTransaction(env, id, all) {
  const cur = await getTransaction(env, id);
  if (cur.group_id && (all || cur.transfer)) {
    const r = await env.DB.prepare('DELETE FROM transactions WHERE group_id = ?').bind(cur.group_id).run();
    return { ok: true, deleted: r.meta.changes };
  }
  await env.DB.prepare('DELETE FROM transactions WHERE id = ?').bind(cur.id).run();
  return { ok: true, deleted: 1 };
}

// Transferência entre contas ou pagamento de fatura (conta → cartão)
async function createTransfer(env, b) {
  const from = await getAccount(env, b.from_id);
  const to = await getAccount(env, b.to_id);
  req(from.id !== to.id, 'Escolha contas diferentes');
  req(DATE_RE.test(b.date || ''), 'Data inválida (YYYY-MM-DD)');
  const amount = cents(b.amount, 'Valor');
  if (b.invoice) req(MONTH_RE.test(b.invoice), 'Fatura inválida (YYYY-MM)');
  const description = str(b.description, 'Descrição', { max: 120 })
    || (to.kind === 'card' ? `Pagamento fatura ${to.name}` : `Transferência ${from.name} → ${to.name}`);
  const invFor = (acc) => acc.kind === 'card'
    ? (b.invoice || invoiceFor(b.date, acc.closing_day, acc.due_day)) : null;
  const groupId = crypto.randomUUID();
  const sql = `INSERT INTO transactions (account_id, type, amount, description, category, date, invoice, group_id, transfer)
               VALUES (?, ?, ?, ?, 'Transferência', ?, ?, ?, 1)`;
  await env.DB.batch([
    env.DB.prepare(sql).bind(from.id, 'out', amount, description, b.date, invFor(from), groupId),
    env.DB.prepare(sql).bind(to.id, 'in', amount, description, b.date, invFor(to), groupId),
  ]);
  return { ok: true, group_id: groupId };
}

// Busca/consulta com filtros
async function searchTransactions(env, url) {
  const q = url.searchParams;
  const where = [];
  const args = [];
  const add = (sql, ...v) => { where.push(sql); args.push(...v); };

  if (q.get('q')) {
    const like = `%${q.get('q').trim()}%`;
    add('(t.description LIKE ? OR t.category LIKE ? OR t.note LIKE ?)', like, like, like);
  }
  if (q.get('account_id')) add('t.account_id = ?', Number(q.get('account_id')));
  if (q.get('kind')) add('a.kind = ?', q.get('kind'));
  if (q.get('type') === 'in' || q.get('type') === 'out') add('t.type = ?', q.get('type'));
  if (q.get('category')) add('t.category = ?', q.get('category'));
  if (q.get('from') && DATE_RE.test(q.get('from'))) add('t.date >= ?', q.get('from'));
  if (q.get('to') && DATE_RE.test(q.get('to'))) add('t.date <= ?', q.get('to'));
  if (q.get('invoice') && MONTH_RE.test(q.get('invoice'))) add('t.invoice = ?', q.get('invoice'));
  if (q.get('transfers') === '0') add('t.transfer = 0');

  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const limit = Math.min(Number(q.get('limit')) || 300, 1000);
  const offset = Math.max(Number(q.get('offset')) || 0, 0);

  const [list, totals] = await env.DB.batch([
    env.DB.prepare(
      `SELECT t.*, a.name AS account_name, a.kind AS account_kind, a.color AS account_color
       FROM transactions t JOIN accounts a ON a.id = t.account_id ${w}
       ORDER BY t.date DESC, t.id DESC LIMIT ? OFFSET ?`
    ).bind(...args, limit, offset),
    env.DB.prepare(
      `SELECT COUNT(*) AS count,
         COALESCE(SUM(CASE WHEN t.type = 'in' THEN t.amount END), 0) AS total_in,
         COALESCE(SUM(CASE WHEN t.type = 'out' THEN t.amount END), 0) AS total_out
       FROM transactions t JOIN accounts a ON a.id = t.account_id ${w}`
    ).bind(...args),
  ]);
  return { items: list.results, ...totals.results[0], limit, offset };
}

async function categories(env) {
  const { results } = await env.DB.prepare(
    `SELECT category AS name, COUNT(*) AS uses FROM transactions
     WHERE category IS NOT NULL AND transfer = 0 GROUP BY category ORDER BY uses DESC, name`
  ).all();
  return results;
}

// Painel inicial: contas, cartões e resumo do mês
async function summary(env, url) {
  const today = todayParam(url);
  const month = url.searchParams.get('month') && MONTH_RE.test(url.searchParams.get('month'))
    ? url.searchParams.get('month') : today.slice(0, 7);
  const from = `${month}-01`;
  const to = `${month}-${pad(daysInMonth(month))}`;
  const accounts = await listAccounts(env, today);

  const [tot, cats] = await env.DB.batch([
    env.DB.prepare(
      `SELECT COALESCE(SUM(CASE WHEN type='in' THEN amount END),0) AS income,
              COALESCE(SUM(CASE WHEN type='out' THEN amount END),0) AS expense
       FROM transactions WHERE transfer = 0 AND date BETWEEN ? AND ?`
    ).bind(from, to),
    env.DB.prepare(
      `SELECT COALESCE(category, 'Sem categoria') AS name, SUM(amount) AS total
       FROM transactions WHERE transfer = 0 AND type = 'out' AND date BETWEEN ? AND ?
       GROUP BY 1 ORDER BY total DESC LIMIT 8`
    ).bind(from, to),
  ]);

  const banks = accounts.filter((a) => a.kind === 'bank' && !a.archived);
  return {
    today,
    month,
    accounts,
    total_balance: banks.reduce((s, a) => s + a.balance, 0),
    total_projected: banks.reduce((s, a) => s + a.projected_balance, 0),
    income: tot.results[0].income,
    expense: tot.results[0].expense,
    top_categories: cats.results,
  };
}

async function exportAll(env) {
  const [a, t, n] = await env.DB.batch([
    env.DB.prepare('SELECT * FROM accounts ORDER BY id'),
    env.DB.prepare('SELECT * FROM transactions ORDER BY id'),
    env.DB.prepare('SELECT * FROM notes ORDER BY id'),
  ]);
  return { exported_at: new Date().toISOString(), accounts: a.results, transactions: t.results, notes: n.results };
}

// ───────────────────────── post-its ─────────────────────────

const NOTE_COLORS = ['yellow', 'pink', 'green', 'blue'];

async function listNotes(env) {
  const { results } = await env.DB.prepare('SELECT * FROM notes ORDER BY id').all();
  return results;
}

async function saveNote(env, id, b) {
  const cur = id ? await env.DB.prepare('SELECT * FROM notes WHERE id = ?').bind(Number(id)).first() : null;
  if (id && !cur) throw new HttpError(404, 'Post-it não encontrado');
  const content = b.content === undefined ? (cur?.content ?? '') : String(b.content ?? '');
  req(content.length <= 20000, 'Texto muito longo (máx. 20.000 caracteres)');
  const color = b.color === undefined ? (cur?.color ?? 'yellow') : b.color;
  req(NOTE_COLORS.includes(color), 'Cor inválida');
  if (cur) {
    await env.DB.prepare("UPDATE notes SET content = ?, color = ?, updated_at = datetime('now') WHERE id = ?")
      .bind(content, color, cur.id).run();
    return env.DB.prepare('SELECT * FROM notes WHERE id = ?').bind(cur.id).first();
  }
  const res = await env.DB.prepare('INSERT INTO notes (content, color) VALUES (?, ?)').bind(content, color).run();
  return env.DB.prepare('SELECT * FROM notes WHERE id = ?').bind(res.meta.last_row_id).first();
}

async function deleteNote(env, id) {
  const r = await env.DB.prepare('DELETE FROM notes WHERE id = ?').bind(Number(id)).run();
  if (!r.meta.changes) throw new HttpError(404, 'Post-it não encontrado');
  return { ok: true };
}

// ───────────────────────── Login (senha única, guardada no D1) ─────────────────────────

const COOKIE = 'fin_session';
const SESSION_DAYS = 90;
const PBKDF2_ITERATIONS = 40000;   // limitado pelo tempo de CPU do plano gratuito
const MAX_ATTEMPTS = 5;
const LOCK_MINUTES = 15;

const enc = new TextEncoder();
const toB64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function hashPassword(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  return toB64(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256));
}
const sha256 = async (s) => toB64(await crypto.subtle.digest('SHA-256', enc.encode(s)));

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

function getCookie(request, name) {
  for (const part of (request.headers.get('cookie') || '').split(/;\s*/)) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i) === name) return part.slice(i + 1);
  }
  return null;
}

const cookieHeader = (token, maxAge) =>
  `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;

async function currentSession(request, env) {
  const token = getCookie(request, COOKIE);
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
  const h = await sha256(token);
  const row = await env.DB.prepare(
    "SELECT token_hash FROM sessions WHERE token_hash = ? AND expires_at > datetime('now')"
  ).bind(h).first();
  return row ? h : null;
}

async function startSession(env, body = { ok: true }) {
  const token = [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join('');
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sessions WHERE expires_at <= datetime('now')"),
    env.DB.prepare(`INSERT INTO sessions (token_hash, expires_at) VALUES (?, datetime('now', '+${SESSION_DAYS} days'))`)
      .bind(await sha256(token)),
  ]);
  return json(body, 200, { 'set-cookie': cookieHeader(token, SESSION_DAYS * 86400) });
}

function checkNewPassword(p) {
  req(typeof p === 'string' && p.length >= 8, 'A senha precisa ter pelo menos 8 caracteres');
  req(p.length <= 200, 'Senha muito longa');
}

async function verifyPassword(env, row, password) {
  if (row.locked_until && row.locked_until > new Date().toISOString()) {
    const min = Math.ceil((Date.parse(row.locked_until) - Date.now()) / 60000);
    throw new HttpError(429, `Muitas tentativas. Tente de novo em ${min} min.`);
  }
  const ok = typeof password === 'string'
    && safeEqual(await hashPassword(password, fromB64(row.salt), row.iterations), row.password_hash);
  if (ok) {
    if (row.failed_attempts) await env.DB.prepare('UPDATE auth SET failed_attempts = 0, locked_until = NULL WHERE id = 1').run();
    return;
  }
  const fails = row.failed_attempts + 1;
  if (fails >= MAX_ATTEMPTS) {
    const until = new Date(Date.now() + LOCK_MINUTES * 60000).toISOString();
    await env.DB.prepare('UPDATE auth SET failed_attempts = 0, locked_until = ? WHERE id = 1').bind(until).run();
    throw new HttpError(429, `Muitas tentativas. Login bloqueado por ${LOCK_MINUTES} min.`);
  }
  await env.DB.prepare('UPDATE auth SET failed_attempts = ? WHERE id = 1').bind(fails).run();
  throw new HttpError(401, 'Senha incorreta');
}

async function authRoute(request, env, url) {
  const p = url.pathname.replace(/\/+$/, '');
  const m = request.method;
  const row = await env.DB.prepare('SELECT * FROM auth WHERE id = 1').first();

  if (p === '/api/auth/status' && m === 'GET') {
    return json({ configured: !!row, authenticated: !!(await currentSession(request, env)) });
  }

  // Primeiro acesso: cria a senha (só funciona enquanto não existir nenhuma)
  if (p === '/api/auth/setup' && m === 'POST') {
    if (row) throw new HttpError(409, 'A senha já foi criada');
    const { password } = await readBody(request);
    checkNewPassword(password);
    const salt = crypto.getRandomValues(new Uint8Array(16));
    try {
      await env.DB.prepare('INSERT INTO auth (id, password_hash, salt, iterations) VALUES (1, ?, ?, ?)')
        .bind(await hashPassword(password, salt, PBKDF2_ITERATIONS), toB64(salt), PBKDF2_ITERATIONS).run();
    } catch {
      throw new HttpError(409, 'A senha já foi criada');
    }
    return startSession(env);
  }

  if (p === '/api/auth/login' && m === 'POST') {
    if (!row) throw new HttpError(409, 'Crie uma senha primeiro');
    const { password } = await readBody(request);
    await verifyPassword(env, row, password);
    return startSession(env);
  }

  if (p === '/api/auth/logout' && m === 'POST') {
    const s = await currentSession(request, env);
    if (s) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(s).run();
    return json({ ok: true }, 200, { 'set-cookie': cookieHeader('', 0) });
  }

  // Trocar senha: encerra as outras sessões (outros aparelhos)
  if (p === '/api/auth/password' && m === 'POST') {
    const s = await currentSession(request, env);
    if (!s) throw new HttpError(401, 'Faça login para continuar');
    const { current, password } = await readBody(request);
    await verifyPassword(env, row, current);
    checkNewPassword(password);
    const salt = crypto.getRandomValues(new Uint8Array(16));
    await env.DB.batch([
      env.DB.prepare('UPDATE auth SET password_hash = ?, salt = ?, iterations = ? WHERE id = 1')
        .bind(await hashPassword(password, salt, PBKDF2_ITERATIONS), toB64(salt), PBKDF2_ITERATIONS),
      env.DB.prepare('DELETE FROM sessions WHERE token_hash <> ?').bind(s),
    ]);
    return json({ ok: true });
  }

  throw new HttpError(404, 'Rota não encontrada');
}
