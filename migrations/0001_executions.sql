CREATE TABLE IF NOT EXISTS executions (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  protocol_key TEXT,
  source TEXT DEFAULT 'manual',
  status TEXT DEFAULT 'success',
  started_at TEXT NOT NULL,
  completed_at TEXT,
  duration_ms INTEGER,
  step_count INTEGER,
  notes TEXT
);
CREATE INDEX IF NOT EXISTS idx_exec_run ON executions(run_id);
CREATE INDEX IF NOT EXISTS idx_exec_proto ON executions(protocol_key);
CREATE INDEX IF NOT EXISTS idx_exec_time ON executions(started_at);
