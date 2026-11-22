// Mock mínimo da API do Cloudflare D1 usando node:sqlite (Node 22.5+), só para testes locais.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';

class Stmt {
  constructor(db, sql, args = []) { this.db = db; this.sql = sql; this.args = args; }
  bind(...args) { return new Stmt(this.db, this.sql, args); }
  _norm() { return this.args.map((a) => (a === undefined ? null : a)); }
  // node:sqlite não aceita ?1 repetido como D1; converte ?N para parâmetros nomeados
  _prep() {
    if (/\?\d/.test(this.sql)) {
      const sql = this.sql.replace(/\?(\d+)/g, ':p$1');
      const named = {};
      this._norm().forEach((v, i) => { named[`p${i + 1}`] = v; });
      return [this.db.prepare(sql), [named]];
    }
    return [this.db.prepare(this.sql), this._norm()];
  }
  async all() { const [s, a] = this._prep(); return { results: s.all(...a).map((r) => ({ ...r })), success: true, meta: {} }; }
  async first(col) { const [s, a] = this._prep(); const r = s.get(...a); if (!r) return null; return col ? r[col] : { ...r }; }
  async run() {
    const [s, a] = this._prep();
    const isSelect = /^\s*SELECT/i.test(this.sql);
    if (isSelect) return { results: s.all(...a).map((r) => ({ ...r })), success: true, meta: {} };
    const r = s.run(...a);
    return { success: true, results: [], meta: { last_row_id: Number(r.lastInsertRowid), changes: r.changes } };
  }
}

export function createD1(migrationsDir) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  for (const f of readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()) {
    db.exec(readFileSync(`${migrationsDir}/${f}`, 'utf8'));
  }
  return {
    prepare: (sql) => new Stmt(db, sql),
    async batch(stmts) {
      db.exec('BEGIN');
      try {
        const out = [];
        for (const s of stmts) out.push(await s.run());
        db.exec('COMMIT');
        return out;
      } catch (e) { db.exec('ROLLBACK'); throw e; }
    },
  };
}
