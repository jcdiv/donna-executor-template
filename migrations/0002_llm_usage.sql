CREATE TABLE IF NOT EXISTS llm_usage (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  estimated_cost_usd REAL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_llm_usage_date ON llm_usage(created_at);
CREATE INDEX IF NOT EXISTS idx_llm_usage_model ON llm_usage(model);
