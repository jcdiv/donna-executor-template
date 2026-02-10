# Donna Executor Template

Deploy autonomous protocol execution to your own Cloudflare Workers account. No vendor lock-in. Your account, your data, your protocols.

**MCP tools die when chats end. Deploy this Worker. They run forever.**

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/jake-c-devine/donna-executor-template)

## What is this?

A standalone execution engine that runs multi-step automation protocols on Cloudflare's edge. It gives you:

- **15 composable primitives** — HTTP, LLM (Claude/GPT/Grok), data transforms, control flow, logging
- **KV-based API registry** — Register any REST API, call it with enforced auth and validation
- **Protocol storage** — Save and run multi-step workflows via simple JSON
- **Cron scheduling** — Run protocols on a schedule
- **Execution logs** — Every run logged to D1 with full traceability
- **Template resolution** — Reference previous step results with `{{step_1.field}}` syntax

## Quick Start

### 1. Deploy

Click the button above, or manually:

```bash
git clone https://github.com/jake-c-devine/donna-executor-template.git
cd donna-executor-template
npm install
```

Create KV namespace and D1 database:

```bash
npx wrangler kv namespace create REGISTRY_KV
npx wrangler d1 create donna-executor-db
```

Update `wrangler.toml` with the IDs from the output above, then:

```bash
npx wrangler d1 execute donna-executor-db --remote --file migrations/0001_executions.sql
```

### 2. Set secrets

```bash
npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put ANTHROPIC_API_KEY
```

### 3. Deploy

```bash
npx wrangler deploy
```

### 4. Test it

```bash
# Check health
curl https://your-worker.workers.dev/health

# Save a protocol
curl -X POST https://your-worker.workers.dev/protocols \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d @examples/hello-world.json

# Run it
curl -X POST https://your-worker.workers.dev/run \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"protocol_key": "hello_world"}'

# Check logs
curl https://your-worker.workers.dev/executions \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN"
```

## API Reference

### Public endpoints (no auth)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Primitive list, version, status |
| GET | `/authoring-context` | Machine-readable schemas for LLM protocol authoring |

### Authenticated endpoints (Bearer token)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/run` | Execute protocol by key from KV |
| POST | `/exec` | Execute single primitive |
| POST | `/batch` | Execute raw steps array |
| POST | `/registry` | Upsert registry entry |
| POST | `/registry/import` | Bulk import entries |
| GET | `/registry` | List all registry entries |
| GET | `/registry/:op_key` | Get single registry entry |
| POST | `/protocols` | Save protocol to KV |
| GET | `/protocols` | List all protocols |
| GET | `/protocols/:key` | Get single protocol |
| GET | `/executions` | Recent execution logs |

All authenticated endpoints require `Authorization: Bearer {ADMIN_TOKEN}`.

## Writing Protocols

Protocols are JSON arrays of steps. Each step calls a primitive and can reference previous results:

```json
{
  "protocol_key": "my_protocol",
  "name": "My Protocol",
  "steps": [
    {
      "step": 1,
      "primitive": "util.time",
      "args": { "operation": "now" }
    },
    {
      "step": 2,
      "primitive": "llm.generate",
      "args": {
        "model": "claude-haiku-4-5-20251001",
        "max_tokens": 500,
        "prompt": "Current time: {{step_1.timestamp}}. Generate a summary."
      }
    },
    {
      "step": 3,
      "primitive": "memory.log",
      "args": {
        "event": "my_protocol_completed",
        "payload": { "result": "{{step_2}}" }
      }
    }
  ]
}
```

### Template syntax

| Pattern | Resolves to |
|---------|-------------|
| `{{step_1}}` | Step 1 result data |
| `{{step_1.field}}` | Nested field in step 1 result |
| `{{step_1.data[0].name}}` | Array indexing |
| `{{item}}` | Current item (inside `util.foreach`) |
| `{{index}}` | Current index (inside `util.foreach`) |
| `{{context.key}}` | Outer value passed to `util.foreach` |
| `\{\{literal\}\}` | Escaped — outputs `{{literal}}` |

### Available primitives

| Primitive | Purpose |
|-----------|---------|
| `http.fetch` | Raw HTTP requests |
| `http.registry_fetch` | Registry-enforced HTTP with auto-auth |
| `llm.generate` | Claude, GPT, or Grok text generation |
| `memory.log` | Log events to D1 |
| `validate.schema` | Pre-flight data validation |
| `util.foreach` | Array iteration with nested steps |
| `util.conditional` | If/else ternary logic |
| `util.halt` | Early protocol termination |
| `util.time` | Timestamps and date math |
| `util.math` | Arithmetic operations |
| `util.json.parse` | Parse JSON strings |
| `util.json.stringify` | Serialize to JSON |
| `util.regex` | Pattern matching and extraction |
| `data.match` | Join two datasets by key |
| `data.map` | Deterministic value transformations |

Hit `GET /authoring-context` for full schemas and examples.

## Adding APIs

### Manual

```bash
curl -X POST https://your-worker.workers.dev/registry \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "op_key": "slack.chat.postMessage",
    "service": "slack",
    "method": "POST",
    "path": "/api/chat.postMessage",
    "base_url": "https://slack.com",
    "auth_scheme": "bearer",
    "auth_env": "SLACK_BOT_TOKEN",
    "required_params": ["channel", "text"],
    "optional_params": ["thread_ts"],
    "status": "active"
  }'
```

Then add the secret: `npx wrangler secret put SLACK_BOT_TOKEN`

### Bulk import

```bash
node scripts/seed-registry.js \
  --url https://your-worker.workers.dev \
  --token YOUR_ADMIN_TOKEN \
  --file examples/registry-entries.json
```

### MCP import

If you have MCP servers configured (e.g., from Claude Desktop), auto-discover and import:

```bash
python scripts/import-mcp.py \
  --url https://your-worker.workers.dev \
  --token YOUR_ADMIN_TOKEN \
  --server github
```

## Cron Scheduling

The worker runs a cron job (default: hourly). To configure which protocols run:

```bash
# Set protocols to run on cron
curl -X PUT https://your-worker.workers.dev/registry \
  ... # or use wrangler KV directly:

npx wrangler kv key put --binding REGISTRY_KV "config:cron" '["daily_summary","inbox_check"]'
```

All listed protocols execute on every cron tick. Control frequency in `wrangler.toml`:

```toml
[triggers]
crons = ["0 */4 * * *"]  # Every 4 hours
```

## Architecture

```
                    +------------------+
                    |  Cloudflare KV   |
                    |  - registry:*    |
                    |  - protocol:*    |
                    |  - config:cron   |
                    +--------+---------+
                             |
+----------+     +-----------+-----------+     +----------+
|  Client  +---->|   Worker (worker.js)  +---->| External |
|  (curl)  |     |                       |     |   APIs   |
+----------+     |  15 primitives        |     +----------+
                 |  Template resolution  |
                 |  Batch execution      |     +----------+
                 |  Validation           +---->| Cloudflare|
                 |  Auth middleware      |     |    D1    |
                 +-----------+-----------+     +----------+
                             |
                    +--------+---------+
                    |   Cron Trigger    |
                    |  (wrangler.toml)  |
                    +------------------+
```

## Secrets Reference

| Secret | Required | Purpose |
|--------|----------|---------|
| `ADMIN_TOKEN` | Yes | Auth for all admin endpoints |
| `ANTHROPIC_API_KEY` | If using Claude | `llm.generate` with `claude-*` models |
| `OPENAI_API_KEY` | If using GPT | `llm.generate` with `gpt-*` models |
| `XAI_API_KEY` | If using Grok | `llm.generate` with `grok-*` models |
| `{SERVICE}_TOKEN` | Per-service | Whatever `auth_env` your registry entries reference |

## License

MIT
