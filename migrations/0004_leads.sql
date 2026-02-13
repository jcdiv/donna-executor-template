CREATE TABLE IF NOT EXISTS leads (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  source TEXT DEFAULT 'demo',
  ip TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_leads_email ON leads(email);
CREATE INDEX IF NOT EXISTS idx_leads_created ON leads(created_at);
