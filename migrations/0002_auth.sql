-- Login simples de um único usuário (senha) + sessões
CREATE TABLE auth (
  id              INTEGER PRIMARY KEY CHECK (id = 1),   -- só existe uma linha
  password_hash   TEXT    NOT NULL,                      -- PBKDF2-SHA256, base64
  salt            TEXT    NOT NULL,                      -- base64
  iterations      INTEGER NOT NULL,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until    TEXT,                                  -- ISO; bloqueio após muitas tentativas
  created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE sessions (
  token_hash  TEXT PRIMARY KEY,                          -- SHA-256 do token do cookie
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at  TEXT NOT NULL
);
