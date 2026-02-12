# Donna Executor Template

Deploy autonomous protocol execution to your own Cloudflare Workers account. No vendor lock-in. Your account, your data, your protocols.

**MCP tools die when chats end. Deploy this Worker. They run forever.**

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/jake-c-devine/donna-executor-template)

## What is this?

A standalone execution engine that runs multi-step automation protocols on Cloudflare's edge. It gives you:

- **16 composable primitives** — HTTP, LLM (Claude/GPT/Grok), semantic memory, data transforms, control flow, logging
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
npx wrangler d1 execute donna-executor-db --remote --file migrations/0002_llm_usage.sql
npx wrangler d1 execute donna-executor-db --remote --file migrations/0003_memories.sql
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
| `memory.log` | Log events to D1 + semantic memory |
| `memory.search` | Semantic search over stored memories |
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
+----------+     |  16 primitives        |     +----------+
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

## Donna Loops Demo: Visible Compounding in 90 Seconds

This demo shows the core differentiator: **protocols that remember**. Run a content refinement protocol twice — the second run finds the first run's self-evaluation and makes *different* improvements. No prompt injection. Real semantic memory.

### Setup (one-time)

After deploying (steps above), run the memories migration and save the demo protocol:

```bash
# Run memories migration
npx wrangler d1 execute donna-executor-db --remote --file migrations/0003_memories.sql

# Save the content refinement protocol
curl -X POST https://your-worker.workers.dev/protocols \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d @examples/content-refine.json
```

### Run 1: First Pass

```bash
curl -X POST https://your-worker.workers.dev/run \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "protocol_key": "content_refine",
    "context": {
      "identity": "I am a developer advocate who writes technical blog posts for a startup audience. I value clarity over cleverness and prefer concrete examples over abstract theory.",
      "text": "Our new API lets you do stuff with data. It has endpoints for getting things and putting things. The authentication uses tokens. Contact us for more info."
    }
  }'
```

Run 1 outputs: refined text, improvements made, and a self-evaluation noting what's still weak. This gets logged to semantic memory.

### Run 2: Compounding

Run the **exact same command** again. The protocol:

1. Searches memory for prior refinements of similar content
2. Finds Run 1's self-evaluation and `what_id_do_differently_next_time`
3. Explicitly references what the prior run noted
4. Makes *different* improvements addressing the prior self-critique

Compare the two outputs side-by-side. Run 2 will say something like: "In my previous refinement, I noted that [X]. This time I specifically addressed that by [Y]."

### What's happening under the hood

```
Run 1:                                Run 2:
  util.time                             util.time
  memory.search → (empty)               memory.search → finds Run 1
  llm.generate → refine + self-eval     llm.generate → reads prior eval, refines differently
  validate.schema                       validate.schema
  memory.log → saves to D1              memory.log → saves to D1
```

The identity anchor matters: change "developer advocate" to "startup CEO writing investor updates" and the refinements shift entirely. Same protocol, different person, different output.

### Try your own content

Change `text` and `identity` to anything. The protocol adapts to who you are and what you're writing. Run it three times — each run builds on all prior runs.

## License

MIT
