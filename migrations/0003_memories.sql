CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  run_id TEXT,
  event TEXT NOT NULL,
  content TEXT NOT NULL,
  metadata TEXT,
  embedding TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memories_event ON memories(event);
CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(created_at);
