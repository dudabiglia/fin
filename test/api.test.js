// Testes da API: `npm test` (requer Node 22.5+)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import worker, { invoiceFor, addMonths } from '../src/index.js';
import { createD1 } from './d1-mock.js';

const MIG = fileURLToPath(new URL('../migrations', import.meta.url));
const TODAY = '2026-11-22';

function client(env) {
  let cookie = '';
  const api = async (method, path, body) => {
    const sep = path.includes('?') ? '&' : '?';
    const res = await worker.fetch(new Request(`https://x.test${path}${sep}today=${TODAY}`, {
      method, body: body ? JSON.stringify(body) : undefined,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    }), env);
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0].endsWith('=') ? '' : set.split(';')[0];
    const data = await res.json();
    if (res.status >= 400) { const e = new Error(data.error); e.status = res.status; throw e; }
    return data;
  };
  api.cookie = () => cookie;
  api.setCookie = (c) => { cookie = c; };
  return api;
}

test('cálculo de fatura', () => {
  // fecha dia 3, vence dia 10
  assert.equal(invoiceFor('2026-11-02', 3, 10), '2026-11');
  assert.equal(invoiceFor('2026-11-03', 3, 10), '2026-12');
  // fecha dia 25, vence dia 5 (mês seguinte)
  assert.equal(invoiceFor('2026-11-20', 25, 5), '2026-12');
  assert.equal(invoiceFor('2026-11-26', 25, 5), '2027-01');
  assert.equal(invoiceFor('2026-12-28', 25, 5), '2027-02');
  // fechamento 31 em mês de 30 dias
  assert.equal(invoiceFor('2026-11-30', 31, 10), '2027-01');
  assert.equal(addMonths('2026-12', 1), '2027-01');
  assert.equal(addMonths('2027-01', -1), '2026-12');
});

test('fluxo completo', async () => {
  const env = { DB: createD1(MIG) };
  const api = client(env);
  await api('POST', '/api/auth/setup', { password: 'minha-senha-123' });

  const nubank = await api('POST', '/api/accounts', { name: 'Nubank', kind: 'bank', initial_balance: 100000 });
  const itau = await api('POST', '/api/accounts', { name: 'Itaú', kind: 'bank' });
  const card = await api('POST', '/api/accounts', { name: 'Visa', kind: 'card', credit_limit: 500000, closing_day: 25, due_day: 5 });
  assert.equal(card.kind, 'card');

  await assert.rejects(api('POST', '/api/accounts', { name: 'X', kind: 'card', closing_day: 40, due_day: 5 }), /fechamento/);

  // lançamentos em conta
  await api('POST', '/api/transactions', { account_id: nubank.id, type: 'in', amount: 500000, description: 'Salário', category: 'Salário', date: '2026-11-05' });
  await api('POST', '/api/transactions', { account_id: nubank.id, type: 'out', amount: 12345, description: 'Mercado Extra', category: 'Mercado', date: '2026-11-10' });
  await api('POST', '/api/transactions', { account_id: nubank.id, type: 'out', amount: 5000, description: 'Futuro', category: 'Outros', date: '2026-11-30' });

  // compra parcelada no cartão: 3x de R$ 100,00 (R$ 300,01 → 100,03 + 100,00 + 100,00... confere resto)
  const p = await api('POST', '/api/transactions', { account_id: card.id, type: 'out', amount: 30001, description: 'Fone', category: 'Compras', date: '2026-11-20', installments: 3 });
  assert.equal(p.installment, 1);
  assert.equal(p.invoice, '2026-12');
  await api('POST', '/api/transactions', { account_id: card.id, type: 'out', amount: 4990, description: 'Netflix', category: 'Assinaturas', date: '2026-11-26' });

  const s = await api('GET', '/api/summary');
  const nb = s.accounts.find((a) => a.id === nubank.id);
  assert.equal(nb.balance, 100000 + 500000 - 12345);           // até hoje
  assert.equal(nb.projected_balance, 100000 + 500000 - 12345 - 5000);
  const vc = s.accounts.find((a) => a.id === card.id);
  assert.equal(vc.current_invoice, '2026-12');
  assert.equal(vc.current_invoice_total, 10001);
  assert.equal(vc.outstanding, 30001 + 4990);
  assert.equal(vc.available_limit, 500000 - 34991);
  assert.equal(vc.closing_date, '2026-11-25');
  assert.equal(vc.due_date, '2026-12-05');
  assert.equal(s.expense, 12345 + 5000 + 30001 + 4990);
  assert.equal(s.income, 500000);

  // faturas
  let inv = await api('GET', `/api/accounts/${card.id}/invoice?invoice=2027-01`);
  assert.equal(inv.total, 10000 + 4990);
  assert.deepEqual(inv.items.map((i) => i.installment).filter(Boolean), [2]);
  inv = await api('GET', `/api/accounts/${card.id}/invoice?invoice=2027-02`);
  assert.equal(inv.total, 10000);

  // pagar fatura de dezembro com a conta Nubank
  await api('POST', '/api/transfers', { from_id: nubank.id, to_id: card.id, amount: 10001, date: '2026-12-05', invoice: '2026-12' });
  inv = await api('GET', `/api/accounts/${card.id}/invoice?invoice=2026-12`);
  assert.equal(inv.total, 0);
  assert.equal(inv.paid, true);
  assert.equal(inv.amount_due, 10001);

  // transferência entre contas não conta como despesa/receita
  await api('POST', '/api/transfers', { from_id: nubank.id, to_id: itau.id, amount: 20000, date: '2026-11-15' });
  const s2 = await api('GET', '/api/summary');
  assert.equal(s2.expense, s.expense);
  assert.equal(s2.accounts.find((a) => a.id === itau.id).balance, 20000);

  // extrato mensal
  const st = await api('GET', `/api/accounts/${nubank.id}/statement?month=2026-11`);
  assert.equal(st.opening_balance, 100000);
  assert.equal(st.closing_balance, 100000 + 500000 - 12345 - 5000 - 20000);
  assert.equal(st.items[0].description, 'Futuro'); // mais recente primeiro
  const dec = await api('GET', `/api/accounts/${nubank.id}/statement?month=2026-12`);
  assert.equal(dec.opening_balance, st.closing_balance);
  assert.equal(dec.closing_balance, st.closing_balance - 10001);

  // busca
  let r = await api('GET', '/api/transactions?q=merc');
  assert.equal(r.count, 1);
  assert.equal(r.items[0].account_name, 'Nubank');
  r = await api('GET', '/api/transactions?type=out&transfers=0&from=2026-11-01&to=2026-11-30');
  assert.equal(r.total_out, 12345 + 5000 + 30001 + 4990); // as 3 parcelas mantêm a data da compra
  r = await api('GET', `/api/transactions?account_id=${card.id}&invoice=2027-01`);
  assert.equal(r.count, 2);
  r = await api('GET', '/api/transactions?category=Compras');
  assert.equal(r.count, 3);

  // editar e excluir
  const merc = (await api('GET', '/api/transactions?q=Mercado')).items[0];
  const ed = await api('PUT', `/api/transactions/${merc.id}`, { amount: 20000, category: 'Alimentação' });
  assert.equal(ed.amount, 20000);
  assert.equal(ed.description, 'Mercado Extra');
  // mover compra do cartão para outra data recalcula a fatura
  const net = (await api('GET', '/api/transactions?q=Netflix')).items[0];
  const moved = await api('PUT', `/api/transactions/${net.id}`, { date: '2026-11-10' });
  assert.equal(moved.invoice, '2026-12');
  const forced = await api('PUT', `/api/transactions/${net.id}`, { invoice: '2027-03' });
  assert.equal(forced.invoice, '2027-03');

  // transferência não editável; excluir um lado apaga os dois
  const tr = (await api('GET', `/api/transactions?account_id=${itau.id}`)).items[0];
  await assert.rejects(api('PUT', `/api/transactions/${tr.id}`, { amount: 1 }), /Transferências/);
  const del = await api('DELETE', `/api/transactions/${tr.id}`);
  assert.equal(del.deleted, 2);

  // excluir todas as parcelas
  const parc = (await api('GET', '/api/transactions?q=Fone')).items[0];
  assert.equal((await api('DELETE', `/api/transactions/${parc.id}?all=1`)).deleted, 3);

  const cats = await api('GET', '/api/categories');
  assert.ok(cats.some((c) => c.name === 'Salário'));
  assert.ok(!cats.some((c) => c.name === 'Transferência'));

  // validações
  await assert.rejects(api('POST', '/api/transactions', { account_id: nubank.id, type: 'out', amount: 0, description: 'x', date: '2026-11-01' }), /maior que zero/);
  await assert.rejects(api('POST', '/api/transactions', { account_id: 999, type: 'out', amount: 1, description: 'x', date: '2026-11-01' }), (e) => e.status === 404);

  // excluir conta
  await api('DELETE', `/api/accounts/${itau.id}`);
  const exp = await api('GET', '/api/export');
  assert.equal(exp.accounts.length, 2);
});

test('login com senha', async () => {
  const env = { DB: createD1(MIG) };
  const api = client(env);

  // sem senha criada: nada da API funciona
  assert.deepEqual(await api('GET', '/api/auth/status'), { configured: false, authenticated: false });
  await assert.rejects(api('GET', '/api/accounts'), (e) => e.status === 401);
  await assert.rejects(api('POST', '/api/auth/login', { password: 'x' }), (e) => e.status === 409);
  await assert.rejects(api('POST', '/api/auth/setup', { password: 'curta' }), /8 caracteres/);

  // primeiro acesso cria a senha e já entra
  await api('POST', '/api/auth/setup', { password: 'senha-forte-1' });
  assert.match(api.cookie(), /^fin_session=[0-9a-f]{64}$/);
  assert.deepEqual(await api('GET', '/api/auth/status'), { configured: true, authenticated: true });
  assert.deepEqual(await api('GET', '/api/accounts'), []);

  // ninguém mais consegue "criar" a senha
  const stranger = client(env);
  await assert.rejects(stranger('POST', '/api/auth/setup', { password: 'outra-senha-1' }), (e) => e.status === 409);
  await assert.rejects(stranger('GET', '/api/accounts'), (e) => e.status === 401);
  stranger.setCookie('fin_session=' + 'a'.repeat(64));
  await assert.rejects(stranger('GET', '/api/accounts'), (e) => e.status === 401);

  // sair invalida a sessão
  const old = api.cookie();
  await api('POST', '/api/auth/logout');
  assert.equal(api.cookie(), '');
  api.setCookie(old);
  await assert.rejects(api('GET', '/api/accounts'), (e) => e.status === 401);

  // login errado / certo
  const c = client(env);
  await assert.rejects(c('POST', '/api/auth/login', { password: 'errada' }), /incorreta/);
  await c('POST', '/api/auth/login', { password: 'senha-forte-1' });
  assert.deepEqual(await c('GET', '/api/accounts'), []);

  // troca de senha derruba as outras sessões
  const other = client(env);
  await other('POST', '/api/auth/login', { password: 'senha-forte-1' });
  await assert.rejects(c('POST', '/api/auth/password', { current: 'errada', password: 'nova-senha-1' }), /incorreta/);
  await c('POST', '/api/auth/password', { current: 'senha-forte-1', password: 'nova-senha-1' });
  await assert.rejects(other('GET', '/api/accounts'), (e) => e.status === 401);
  assert.deepEqual(await c('GET', '/api/accounts'), []);
  await assert.rejects(client(env)('POST', '/api/auth/login', { password: 'senha-forte-1' }), /incorreta/);

  // bloqueio após 5 tentativas erradas seguidas (a tentativa logo acima já foi a 1ª)
  const bad = client(env);
  for (let i = 0; i < 3; i++) await assert.rejects(bad('POST', '/api/auth/login', { password: 'x' }), (e) => e.status === 401);
  await assert.rejects(bad('POST', '/api/auth/login', { password: 'x' }), (e) => e.status === 429);
  await assert.rejects(bad('POST', '/api/auth/login', { password: 'nova-senha-1' }), (e) => e.status === 429);
});
