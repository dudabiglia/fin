-- Contas bancárias e cartões de crédito
CREATE TABLE accounts (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT    NOT NULL,
  kind            TEXT    NOT NULL CHECK (kind IN ('bank', 'card')),
  initial_balance INTEGER NOT NULL DEFAULT 0,   -- centavos (contas)
  credit_limit    INTEGER,                      -- centavos (cartões)
  closing_day     INTEGER,                      -- dia de fechamento (cartões)
  due_day         INTEGER,                      -- dia de vencimento (cartões)
  color           TEXT,
  archived        INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Lançamentos (entradas e saídas)
CREATE TABLE transactions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id   INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  type         TEXT    NOT NULL CHECK (type IN ('in', 'out')),
  amount       INTEGER NOT NULL CHECK (amount > 0),   -- centavos, sempre positivo
  description  TEXT    NOT NULL,
  category     TEXT,
  date         TEXT    NOT NULL,                      -- YYYY-MM-DD
  invoice      TEXT,                                  -- YYYY-MM (mês de vencimento da fatura; só cartões)
  group_id     TEXT,                                  -- liga parcelas ou os dois lados de uma transferência
  installment  INTEGER,                               -- nº da parcela
  installments INTEGER,                               -- total de parcelas
  transfer     INTEGER NOT NULL DEFAULT 0,            -- 1 = transferência / pagamento de fatura
  note         TEXT,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_tx_account_date    ON transactions (account_id, date);
CREATE INDEX idx_tx_account_invoice ON transactions (account_id, invoice);
CREATE INDEX idx_tx_date            ON transactions (date);
CREATE INDEX idx_tx_group           ON transactions (group_id);
