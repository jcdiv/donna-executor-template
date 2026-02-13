/**
 * Donna Executor Template
 * Standalone protocol execution engine for Cloudflare Workers
 *
 * Deploy to your own account: KV-based registry, D1 execution logs,
 * 15 composable primitives, template resolution, cron scheduling.
 */

// ===== UTILITIES =====

function validateRunId(runId) {
  return runId && typeof runId === 'string' && runId.length > 0;
}

function validateUrl(url) {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

function createOperationHash(primitive, args) {
  const hashInput = JSON.stringify({ primitive, args });
  let hash = 0;
  for (let i = 0; i < hashInput.length; i++) {
    const char = hashInput.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(16);
}

function createIdempotencyKey(runId, primitive, args) {
  const argsHash = createOperationHash(primitive, args);
  return `${runId}:${primitive}:${argsHash}`;
}

function redactSecrets(obj) {
  if (typeof obj === 'string') {
    return obj.replace(/Bearer\s+[A-Za-z0-9_-]+/gi, 'Bearer [REDACTED]')
             .replace(/sk-[A-Za-z0-9_-]+/gi, '[REDACTED]')
             .replace(/xoxb-[A-Za-z0-9_-]+/gi, '[REDACTED]');
  }
  if (Array.isArray(obj)) {
    return obj.map(item => redactSecrets(item));
  }
  if (obj && typeof obj === 'object') {
    const redacted = {};
    for (const [key, value] of Object.entries(obj)) {
      const lowerKey = key.toLowerCase();
      if ((lowerKey.includes('token') ||
           lowerKey.includes('secret') ||
           lowerKey.includes('authorization') ||
           (lowerKey.includes('key') && lowerKey !== 'op_key' && lowerKey !== 'protocol_key'))) {
        redacted[key] = '[REDACTED]';
      } else {
        redacted[key] = redactSecrets(value);
      }
    }
    return redacted;
  }
  return obj;
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getRetryDelay(attempt, baseDelay = 300) {
  const exponentialDelay = baseDelay * Math.pow(2, attempt);
  const jitter = Math.random() * 0.3 * exponentialDelay;
  return exponentialDelay + jitter;
}

function substituteEnvVars(headers, env) {
  if (!headers || typeof headers !== 'object') return headers;
  const substituted = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === 'string') {
      substituted[key] = value.replace(/\{\{([A-Z_]+)\}\}/g, (match, varName) => {
        return env[varName] || match;
      });
    } else {
      substituted[key] = value;
    }
  }
  return substituted;
}

// ===== EMBEDDING HELPERS =====

function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

async function computeEmbedding(env, text) {
  if (!env.AI) return null;
  try {
    const truncated = typeof text === 'string' ? text.substring(0, 2000) : JSON.stringify(text).substring(0, 2000);
    const result = await env.AI.run('@cf/baai/bge-base-en-v1.5', { text: [truncated] });
    return result?.data?.[0] || null;
  } catch (err) {
    console.log('[embedding] Workers AI failed:', err.message);
    return null;
  }
}

// ===== SAFETY LIMITS =====

const MAX_FOREACH_ITERATIONS_HARD_CAP = 100;
const MAX_LLM_CALLS_PER_RUN = 25;
const DEFAULT_DAILY_LLM_BUDGET_USD = 10.00;

// ===== REGISTRY (KV-BASED) =====

async function getRegistryEntry(env, op_key) {
  const raw = await env.REGISTRY_KV.get(`registry:${op_key}`);
  if (!raw) return null;
  const entry = JSON.parse(raw);
  return entry.status === 'active' ? entry : null;
}

async function enforceRegistryOperation(env, op_key, params = {}) {
  const registryEntry = await getRegistryEntry(env, op_key);
  if (!registryEntry) {
    throw new Error(`Operation ${op_key} not found in registry`);
  }
  if (registryEntry.status !== 'active') {
    throw new Error(`Operation ${op_key} is ${registryEntry.status}`);
  }
  for (const requiredParam of registryEntry.required_params || []) {
    if (!(requiredParam in params)) {
      throw new Error(`Missing required parameter: ${requiredParam}`);
    }
  }
  return registryEntry;
}

// ===== MODEL CONTEXT WINDOWS =====

const MODEL_CONTEXT_WINDOWS = {
  // Anthropic
  'claude-opus-4-6-20250205': 1000000,
  'claude-opus-4-5-20251101': 200000,
  'claude-opus-4-1-20250805': 200000,
  'claude-sonnet-4-5-20250929': 200000,
  'claude-haiku-4-5-20251001': 200000,
  'claude-3-5-haiku-20241022': 200000,
  'claude-3-haiku-20240307': 200000,
  // OpenAI
  'gpt-5.2': 400000,
  'gpt-4.1': 1000000,
  'gpt-4.1-mini': 1000000,
  'gpt-4.1-nano': 1000000,
  'gpt-4o': 128000,
  'gpt-4o-mini': 128000,
  // xAI
  'grok-4-0709': 256000,
  'grok-4-1-fast-non-reasoning': 2000000,
  'grok-4-1-fast-reasoning': 2000000,
  'grok-4-fast-non-reasoning': 2000000,
  'grok-4-fast-reasoning': 2000000,
  'grok-code-fast-1': 2000000,
  'grok-3-beta': 131072,
  'grok-3-fast-beta': 131072,
  'grok-2': 131072,
  // OpenAI reasoning
  'o1': 200000,
  'o3': 200000,
  'o3-mini': 200000,
};

// ===== MODEL PRICING (per million tokens) =====

const MODEL_PRICING_PER_MILLION = {
  // Anthropic
  'claude-opus-4-6-20250205': { input: 15.0, output: 75.0 },
  'claude-opus-4-5-20251101': { input: 15.0, output: 75.0 },
  'claude-opus-4-1-20250805': { input: 15.0, output: 75.0 },
  'claude-sonnet-4-5-20250929': { input: 3.0, output: 15.0 },
  'claude-haiku-4-5-20251001': { input: 0.80, output: 4.0 },
  'claude-3-5-haiku-20241022': { input: 0.80, output: 4.0 },
  'claude-3-haiku-20240307': { input: 0.25, output: 1.25 },
  // OpenAI
  'gpt-5.2': { input: 2.0, output: 8.0 },
  'gpt-4.1': { input: 2.0, output: 8.0 },
  'gpt-4.1-mini': { input: 0.40, output: 1.60 },
  'gpt-4.1-nano': { input: 0.10, output: 0.40 },
  'gpt-4o': { input: 2.50, output: 10.0 },
  'gpt-4o-mini': { input: 0.15, output: 0.60 },
  'o1': { input: 15.0, output: 60.0 },
  'o3': { input: 10.0, output: 40.0 },
  'o3-mini': { input: 1.10, output: 4.40 },
  // xAI
  'grok-4-0709': { input: 3.0, output: 15.0 },
  'grok-3-beta': { input: 3.0, output: 15.0 },
  'grok-3-fast-beta': { input: 0.60, output: 3.0 },
  'grok-2': { input: 2.0, output: 10.0 },
};

// ===== BUDGET HELPERS =====

function estimateLLMCost(model, inputTokens, outputTokens) {
  const pricing = MODEL_PRICING_PER_MILLION[model];
  if (!pricing) return 0;
  return (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000;
}

async function getDailyLLMSpend(env) {
  const today = new Date().toISOString().slice(0, 10);
  try {
    const result = await env.DB.prepare(
      'SELECT COALESCE(SUM(estimated_cost_usd), 0) as total FROM llm_usage WHERE created_at >= ?'
    ).bind(`${today}T00:00:00.000Z`).first();
    return result?.total || 0;
  } catch {
    return 0;
  }
}

async function logLLMUsage(env, runId, model, inputTokens, outputTokens, costUsd) {
  try {
    const id = `llm-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
    await env.DB.prepare(
      'INSERT INTO llm_usage (id, run_id, model, input_tokens, output_tokens, estimated_cost_usd, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).bind(id, runId, model, inputTokens || 0, outputTokens || 0, costUsd, new Date().toISOString()).run();
  } catch (e) {
    console.log('[budget] Failed to log LLM usage:', e.message);
  }
}

// ===== LLM OUTPUT PROCESSING =====

function stripCodeFences(text) {
  if (!text || typeof text !== 'string') return text;
  let result = text.trim();
  const fenceMatch = result.match(/```(?:json|JSON)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch) {
    result = fenceMatch[1].trim();
  } else if (result.startsWith('```')) {
    result = result.replace(/^```(?:json|JSON)?\s*\n?/, '');
    result = result.replace(/\n?\s*```\s*$/, '');
    result = result.trim();
  }
  return result;
}

function processLLMOutput(text) {
  if (!text || typeof text !== 'string') return text;
  let cleanedText = stripCodeFences(text);
  try {
    return JSON.parse(cleanedText);
  } catch (e) {
    const jsonStartBrace = cleanedText.indexOf('{');
    const jsonStartBracket = cleanedText.indexOf('[');
    const jsonStart = jsonStartBrace === -1 ? jsonStartBracket :
                      jsonStartBracket === -1 ? jsonStartBrace :
                      Math.min(jsonStartBrace, jsonStartBracket);
    if (jsonStart !== -1) {
      const isArray = cleanedText[jsonStart] === '[';
      const closeChar = isArray ? ']' : '}';
      const jsonEnd = cleanedText.lastIndexOf(closeChar);
      if (jsonEnd > jsonStart) {
        let extracted = cleanedText.substring(jsonStart, jsonEnd + 1);
        try {
          return JSON.parse(extracted);
        } catch (e2) {
          const repaired = repairJSON(extracted);
          if (repaired !== extracted) {
            try {
              return JSON.parse(repaired);
            } catch (e3) {
              // Fall through
            }
          }
        }
      }
    }
    return cleanedText;
  }
}

function repairJSON(json) {
  let repaired = json;
  // Fix trailing commas
  repaired = repaired.replace(/,(\s*[}\]])/g, '$1');
  // Fix unescaped newlines inside strings
  repaired = repaired.replace(/"([^"\\]*(\\.[^"\\]*)*)"/g, (match) => {
    return match.replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
  });
  // Close truncated JSON
  let braceCount = 0, bracketCount = 0, inString = false, escaped = false;
  for (const char of repaired) {
    if (escaped) { escaped = false; continue; }
    if (char === '\\') { escaped = true; continue; }
    if (char === '"') { inString = !inString; continue; }
    if (!inString) {
      if (char === '{') braceCount++;
      else if (char === '}') braceCount--;
      else if (char === '[') bracketCount++;
      else if (char === ']') bracketCount--;
    }
  }
  if (inString) repaired += '"';
  while (bracketCount > 0) { repaired += ']'; bracketCount--; }
  while (braceCount > 0) { repaired += '}'; braceCount--; }
  return repaired;
}

// ===== PRIMITIVES =====

const PRIMITIVES = {

  // memory.log — D1-only execution logging
  async 'memory.log'(env, args, runId, executionContext) {
    const { event, payload, protocol_key, duration_ms, execution_status, source, error_details } = args;
    if (!event || typeof event !== 'string') {
      return { ok: false, error: 'Event name required (string)' };
    }
    const timestamp = new Date().toISOString();
    const detectedSource = source || (
      runId.startsWith('sched-') ? 'scheduled' :
      runId.startsWith('test-') ? 'test' :
      'manual'
    );

    let d1Result = { ok: false };
    if (env.DB) {
      try {
        const execId = `exec-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
        const eventProtocolKey = protocol_key || (event.endsWith('_complete') ? event.replace('_complete', '') : event);
        const notesStr = payload ? JSON.stringify(payload).substring(0, 10000) : null;
        const fullNotes = error_details
          ? (notesStr ? `${notesStr}\n\nError: ${error_details.substring(0, 1000)}` : `Error: ${error_details.substring(0, 1000)}`)
          : notesStr;

        await env.DB.prepare(`
          INSERT INTO executions (id, run_id, protocol_key, source, status, started_at, completed_at, duration_ms, notes)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          execId, runId, eventProtocolKey, detectedSource,
          (execution_status || 'success').toLowerCase(),
          timestamp, timestamp, duration_ms || null, fullNotes
        ).run();
        d1Result = { ok: true, id: execId };
      } catch (d1Error) {
        console.log('[memory.log] D1 write failed:', d1Error.message);
        d1Result = { ok: false, error: d1Error.message };
      }
    }

    // Also write to memories table for semantic search
    let memoryId = null;
    if (env.DB && payload) {
      try {
        memoryId = `mem-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
        const contentStr = typeof payload === 'string' ? payload : JSON.stringify(payload);
        const embedding = await computeEmbedding(env, contentStr);
        const embeddingStr = embedding ? JSON.stringify(embedding) : null;

        await env.DB.prepare(`
          INSERT INTO memories (id, run_id, event, content, metadata, embedding, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).bind(
          memoryId, runId, event, contentStr,
          JSON.stringify({ protocol_key: protocol_key || event }),
          embeddingStr, timestamp
        ).run();
      } catch (memErr) {
        console.log('[memory.log] Memories table write failed:', memErr.message);
        memoryId = null;
      }
    }

    return {
      ok: d1Result.ok,
      status: d1Result.ok ? 200 : 500,
      data: { d1_id: d1Result.id, memory_id: memoryId, timestamp },
      error: d1Result.ok ? undefined : d1Result.error
    };
  },

  // memory.search — Semantic search over stored memories
  async 'memory.search'(env, args, runId) {
    const { query, top_k = 5, event_filter } = args;
    if (!query || typeof query !== 'string') {
      return { ok: false, error: 'Query string required' };
    }
    if (!env.DB) {
      return { ok: true, status: 200, data: [] };
    }

    // Compute query embedding
    const queryEmbedding = await computeEmbedding(env, query);

    // Fetch memories (with optional event filter)
    let rows;
    try {
      if (event_filter) {
        const result = await env.DB.prepare(
          'SELECT id, run_id, event, content, metadata, embedding, created_at FROM memories WHERE event = ? ORDER BY created_at DESC LIMIT 200'
        ).bind(event_filter).all();
        rows = result.results || [];
      } else {
        const result = await env.DB.prepare(
          'SELECT id, run_id, event, content, metadata, embedding, created_at FROM memories ORDER BY created_at DESC LIMIT 200'
        ).all();
        rows = result.results || [];
      }
    } catch (dbErr) {
      return { ok: false, error: `Memory query failed: ${dbErr.message}` };
    }

    // If no AI binding or no query embedding, fall back to recency
    if (!queryEmbedding) {
      const fallback = rows.slice(0, top_k).map(r => {
        let content;
        try { content = JSON.parse(r.content); } catch { content = r.content; }
        return { id: r.id, event: r.event, content, similarity: null, created_at: r.created_at };
      });
      return { ok: true, status: 200, data: fallback };
    }

    // Score by cosine similarity
    const scored = rows
      .filter(r => r.embedding)
      .map(r => {
        let storedEmbedding;
        try { storedEmbedding = JSON.parse(r.embedding); } catch { return null; }
        const similarity = cosineSimilarity(queryEmbedding, storedEmbedding);
        let content;
        try { content = JSON.parse(r.content); } catch { content = r.content; }
        return { id: r.id, event: r.event, content, similarity, created_at: r.created_at };
      })
      .filter(Boolean)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, top_k);

    return { ok: true, status: 200, data: scored };
  },

  // http.fetch — Raw HTTP requests
  async 'http.fetch'(env, args, runId, executionContext) {
    const { url, method = 'GET', headers = {}, body } = args;
    if (!validateUrl(url)) {
      throw new Error('Invalid URL format');
    }
    const allowedMethods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
    if (!allowedMethods.includes(method.toUpperCase())) {
      throw new Error(`Method ${method} not allowed`);
    }
    try {
      let finalHeaders = { 'User-Agent': 'donna-executor/1.0', ...headers };
      finalHeaders = substituteEnvVars(finalHeaders, env);

      const response = await fetch(url, {
        method: method.toUpperCase(),
        headers: finalHeaders,
        body: body ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined
      });

      const responseText = await response.text();
      let responseData = responseText;
      try { responseData = JSON.parse(responseText); } catch { /* keep as text */ }

      return {
        status: response.status,
        ok: response.ok,
        headers: Object.fromEntries(response.headers.entries()),
        data: responseData,
        url: response.url
      };
    } catch (error) {
      throw new Error(`HTTP request failed: ${error.message}`);
    }
  },

  // http.registry_fetch — Registry-enforced HTTP
  async 'http.registry_fetch'(env, args, runId, executionContext) {
    const { op_key, params = {}, headers = {}, body } = args;
    if (!op_key || typeof op_key !== 'string') {
      throw new Error('op_key is required (string)');
    }
    try {
      const registryEntry = await enforceRegistryOperation(env, op_key, params);
      const baseUrl = registryEntry.base_url;
      if (!baseUrl) {
        throw new Error(`No base_url configured for service: ${registryEntry.service}`);
      }

      // Build URL with path param substitution
      let fullUrl = baseUrl + registryEntry.path;
      const bodyParams = { ...params };
      const pathParamMatches = registryEntry.path.matchAll(/\{([^}]+)\}/g);
      for (const match of pathParamMatches) {
        const paramName = match[1];
        if (params[paramName]) {
          fullUrl = fullUrl.replace(`{${paramName}}`, encodeURIComponent(params[paramName]));
          delete bodyParams[paramName];
        }
      }

      // GET: remaining params as query string
      if (registryEntry.method === 'GET' && Object.keys(bodyParams).length > 0) {
        const queryString = Object.entries(bodyParams)
          .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
          .join('&');
        fullUrl += (fullUrl.includes('?') ? '&' : '?') + queryString;
      }

      // Authentication
      let authHeaders = { ...headers };
      if (registryEntry.auth_scheme === 'bearer') {
        const token = registryEntry.auth_env ? env[registryEntry.auth_env] : null;
        if (token) {
          if (registryEntry.service === 'anthropic') {
            authHeaders['x-api-key'] = token;
            authHeaders['anthropic-version'] = '2023-06-01';
          } else {
            authHeaders['Authorization'] = `Bearer ${token}`;
          }
        }
      } else if (registryEntry.auth_scheme === 'api_key') {
        const token = registryEntry.auth_env ? env[registryEntry.auth_env] : null;
        if (token) {
          if (registryEntry.service === 'tavily') {
            Object.keys(bodyParams).forEach(key => delete bodyParams[key]);
            bodyParams.api_key = token;
            bodyParams.query = params.query;
            bodyParams.search_depth = params.search_depth || 'basic';
            bodyParams.max_results = params.max_results || 10;
            bodyParams.include_answer = params.include_answer !== false;
            Object.keys(params).forEach(key => {
              if (!(key in bodyParams)) bodyParams[key] = params[key];
            });
          } else {
            authHeaders['x-api-key'] = token;
            authHeaders['anthropic-version'] = '2023-06-01';
          }
        }
      }

      // User-Agent
      authHeaders['User-Agent'] = 'donna-executor/1.0';
      const requestOptions = { method: registryEntry.method, headers: authHeaders };

      // Body for POST/PUT/PATCH
      if (['POST', 'PUT', 'PATCH'].includes(registryEntry.method)) {
        requestOptions.headers['Content-Type'] = 'application/json';

        if (registryEntry.body_template) {
          const templateContext = { ...params, ...(executionContext?.context || {}) };
          const resolvedBodyTemplate = resolveStringTemplates(registryEntry.body_template, templateContext);
          try {
            const templateBody = JSON.parse(resolvedBodyTemplate);
            requestOptions.body = JSON.stringify(templateBody);
          } catch (parseError) {
            throw new Error(`Failed to parse body_template as JSON: ${parseError.message}`);
          }
        } else if (body) {
          requestOptions.body = typeof body === 'string' ? body : JSON.stringify(body);
        } else if (Object.keys(bodyParams).length > 0) {
          requestOptions.body = JSON.stringify(bodyParams);
        }
      }

      const response = await fetch(fullUrl, requestOptions);

      let responseData;
      const contentType = response.headers.get('content-type');
      if (contentType && contentType.includes('application/json')) {
        responseData = await response.json();
      } else {
        responseData = await response.text();
      }

      // Unwrap GraphQL responses
      if (registryEntry.path === '/graphql' && responseData?.data) {
        responseData = responseData.data;
      }

      return {
        status: response.status,
        ok: response.ok,
        headers: Object.fromEntries(response.headers.entries()),
        data: responseData,
        url: response.url,
        registry_entry: registryEntry
      };
    } catch (error) {
      throw new Error(`Registry operation failed: ${error.message}`);
    }
  },

  // llm.generate — Multi-provider LLM text generation
  async 'llm.generate'(env, args, runId, executionContext) {
    const { prompt, model, max_tokens = 4000, temperature = 1.0, input } = args;
    if (!prompt || typeof prompt !== 'string') {
      return { ok: false, error: 'prompt is required (string)' };
    }
    if (!model || typeof model !== 'string') {
      return { ok: false, error: 'model is required (string)' };
    }

    const finalPrompt = input ? `${prompt}\n\nInput:\n${typeof input === "object" ? JSON.stringify(input, null, 2) : input}` : prompt;

    // Token estimation — fail fast
    const estimatedTokens = Math.ceil(finalPrompt.length / 4);
    const contextWindow = MODEL_CONTEXT_WINDOWS[model];
    if (contextWindow) {
      const threshold = Math.floor(contextWindow * 0.9);
      if (estimatedTokens > threshold) {
        return {
          ok: false,
          error: `Prompt too large for ${model}: ~${estimatedTokens.toLocaleString()} estimated tokens exceeds 90% of ${contextWindow.toLocaleString()} context window.`
        };
      }
    }

    // Budget check — per-run call limit + daily spend cap
    if (executionContext?._budget) {
      const b = executionContext._budget;
      if (b.llmCallCount >= b.maxLLMCallsPerRun) {
        return { ok: false, error: `LLM call limit reached (max ${b.maxLLMCallsPerRun} per run). Reduce steps or increase limit via config:max_llm_calls_per_run.` };
      }
      if (b.dailySpendUsd >= b.dailyBudgetUsd) {
        return { ok: false, error: `Daily LLM budget exceeded: $${b.dailySpendUsd.toFixed(4)} spent of $${b.dailyBudgetUsd.toFixed(2)} limit. Adjust via config:daily_budget_usd.` };
      }
      b.llmCallCount++;
    } else if (env?.DB) {
      const dailySpend = await getDailyLLMSpend(env);
      const budgetRaw = await env.REGISTRY_KV?.get('config:daily_budget_usd');
      const budget = budgetRaw ? parseFloat(budgetRaw) : DEFAULT_DAILY_LLM_BUDGET_USD;
      if (dailySpend >= budget) {
        return { ok: false, error: `Daily LLM budget exceeded: $${dailySpend.toFixed(4)} spent of $${budget.toFixed(2)} limit. Adjust via config:daily_budget_usd.` };
      }
    }

    try {
      if (model.startsWith('claude-')) {
        const response = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'x-api-key': env.ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json'
          },
          body: JSON.stringify({ model, max_tokens, temperature, messages: [{ role: "user", content: finalPrompt }] })
        });
        if (!response.ok) {
          const errorText = await response.text();
          return { ok: false, error: `Anthropic API error: ${response.status} - ${errorText}` };
        }
        const result = await response.json();
        let finalData = result;
        if (result.content?.[0]?.text) {
          finalData = processLLMOutput(result.content[0].text);
        }
        const usage = result.usage ? {
          input_tokens: result.usage.input_tokens,
          output_tokens: result.usage.output_tokens,
          total_tokens: (result.usage.input_tokens || 0) + (result.usage.output_tokens || 0)
        } : null;
        if (usage && env?.DB) {
          const cost = estimateLLMCost(model, usage.input_tokens || 0, usage.output_tokens || 0);
          if (executionContext?._budget) executionContext._budget.dailySpendUsd += cost;
          await logLLMUsage(env, runId, model, usage.input_tokens || 0, usage.output_tokens || 0, cost);
        }
        return { ok: true, status: response.status, data: finalData, usage };

      } else if (model.startsWith('gpt-') || model.startsWith('o1') || model.startsWith('o3')) {
        const response = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, max_tokens, temperature, messages: [{ role: "user", content: finalPrompt }] })
        });
        if (!response.ok) {
          const errorText = await response.text();
          return { ok: false, error: `OpenAI API error: ${response.status} - ${errorText}` };
        }
        const result = await response.json();
        let finalData = result;
        const text = result.choices?.[0]?.message?.content;
        if (text) finalData = processLLMOutput(text);
        const usage = result.usage ? {
          input_tokens: result.usage.prompt_tokens,
          output_tokens: result.usage.completion_tokens,
          total_tokens: result.usage.total_tokens
        } : null;
        if (usage && env?.DB) {
          const cost = estimateLLMCost(model, usage.input_tokens || 0, usage.output_tokens || 0);
          if (executionContext?._budget) executionContext._budget.dailySpendUsd += cost;
          await logLLMUsage(env, runId, model, usage.input_tokens || 0, usage.output_tokens || 0, cost);
        }
        return { ok: true, status: response.status, data: finalData, usage };

      } else if (model.startsWith('grok-')) {
        const response = await fetch('https://api.x.ai/v1/chat/completions', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${env.XAI_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, temperature, stream: false, messages: [{ role: "user", content: finalPrompt }] })
        });
        if (!response.ok) {
          const errorText = await response.text();
          return { ok: false, error: `xAI API error: ${response.status} - ${errorText}` };
        }
        const result = await response.json();
        let finalData = result;
        const text = result.choices?.[0]?.message?.content;
        if (text) finalData = processLLMOutput(text);
        const usage = result.usage ? {
          input_tokens: result.usage.prompt_tokens,
          output_tokens: result.usage.completion_tokens,
          total_tokens: result.usage.total_tokens
        } : null;
        if (usage && env?.DB) {
          const cost = estimateLLMCost(model, usage.input_tokens || 0, usage.output_tokens || 0);
          if (executionContext?._budget) executionContext._budget.dailySpendUsd += cost;
          await logLLMUsage(env, runId, model, usage.input_tokens || 0, usage.output_tokens || 0, cost);
        }
        return { ok: true, status: response.status, data: finalData, usage };

      } else {
        return { ok: false, error: `Unknown model provider for: ${model}. Supported: claude-*, gpt-*, grok-*` };
      }
    } catch (error) {
      return { ok: false, error: `LLM generation failed: ${error.message}` };
    }
  },

  // validate.schema — Pre-flight data validation
  async 'validate.schema'(env, args, runId, executionContext) {
    const { data, schema, fallback = null, strict = false } = args;
    if (schema === undefined || schema === null) {
      return { ok: false, status: 400, error: 'schema is required' };
    }
    const failures = [];

    if (schema.type) {
      const actualType = Array.isArray(data) ? 'array' : typeof data;
      if (actualType !== schema.type) failures.push(`Expected type '${schema.type}', got '${actualType}'`);
    }
    if (Array.isArray(data)) {
      if (schema.min_length !== undefined && data.length < schema.min_length)
        failures.push(`Array length ${data.length} < min_length ${schema.min_length}`);
      if (schema.max_length !== undefined && data.length > schema.max_length)
        failures.push(`Array length ${data.length} > max_length ${schema.max_length}`);
      if (schema.array_item_length !== undefined) {
        for (let i = 0; i < data.length; i++) {
          if (!Array.isArray(data[i])) failures.push(`Row ${i}: Expected array, got ${typeof data[i]}`);
          else if (data[i].length !== schema.array_item_length) failures.push(`Row ${i}: Expected ${schema.array_item_length} columns, got ${data[i].length}`);
        }
      }
      if (schema.first_element_contains !== undefined && data.length > 0) {
        const first = data[0];
        let found = false;
        if (Array.isArray(first)) found = first.some(c => c !== null && c !== undefined && String(c).includes(schema.first_element_contains));
        else if (typeof first === 'string') found = first.includes(schema.first_element_contains);
        else found = first === schema.first_element_contains;
        if (!found) failures.push(`First element does not contain '${schema.first_element_contains}'`);
      }
      if (schema.contains !== undefined) {
        let found = false;
        const search = (arr) => {
          for (const item of arr) {
            if (Array.isArray(item)) search(item);
            else if (item === schema.contains || (typeof item === 'string' && item.includes(schema.contains))) { found = true; return; }
          }
        };
        search(data);
        if (!found) failures.push(`Array does not contain '${schema.contains}'`);
      }
    }
    if (typeof data === 'string') {
      if (schema.min_length !== undefined && data.length < schema.min_length) failures.push(`String length ${data.length} < min_length ${schema.min_length}`);
      if (schema.max_length !== undefined && data.length > schema.max_length) failures.push(`String length ${data.length} > max_length ${schema.max_length}`);
      if (schema.contains !== undefined && !data.includes(schema.contains)) failures.push(`String does not contain '${schema.contains}'`);
    }
    if (typeof data === 'object' && data !== null && !Array.isArray(data)) {
      if (schema.required_fields !== undefined) {
        for (const field of schema.required_fields) {
          if (!(field in data)) failures.push(`Missing required field '${field}'`);
        }
      }
    }

    if (failures.length === 0) return { ok: true, status: 200, data };

    const reason = failures.join('; ');
    if (strict) return { ok: false, status: 400, error: `Validation failed: ${reason}` };
    return { ok: false, status: 200, data: fallback, reason };
  },

  // util.foreach — Array iteration with nested step execution
  async 'util.foreach'(env, args, runId, executionContext) {
    const { array, steps, on_error = 'continue', context = {}, max_iterations } = args;

    if (array === null || array === undefined) {
      return { ok: true, status: 200, data: { iterations: [], total_count: 0, processed_count: 0, success_count: 0, error_count: 0, warning: 'array was null/undefined' } };
    }
    if (!Array.isArray(array)) return { ok: false, status: 400, error: `array must be an array, got ${typeof array}` };
    if (!Array.isArray(steps) || steps.length === 0) return { ok: false, status: 400, error: 'steps must be a non-empty array' };
    if (!['continue', 'halt'].includes(on_error)) return { ok: false, status: 400, error: "on_error must be 'continue' or 'halt'" };

    const iterations = [];
    const errors = [];
    let haltRequested = false;
    const effectiveLimit = Math.min(
      max_iterations ? Math.min(array.length, max_iterations) : array.length,
      MAX_FOREACH_ITERATIONS_HARD_CAP
    );

    for (let index = 0; index < effectiveLimit && !haltRequested; index++) {
      const item = array[index];
      const iterationResults = [];
      try {
        for (const step of steps) {
          const parentVariables = {};
          for (const [key, value] of Object.entries(executionContext || {})) {
            if (!key.startsWith('step_') && key !== 'previous_result') parentVariables[key] = value;
          }
          const iterationContext = {
            ...parentVariables, item, index,
            is_first: index === 0, is_last: index === effectiveLimit - 1,
            context
          };

          const resolvedStep = resolveTemplates(step, iterationResults, iterationContext);
          const resolvedArgs = resolvedStep.args || {};

          // skip_if in foreach
          if (resolvedStep.skip_if) {
            try {
              let skipCondition = resolvedStep.skip_if;
              const templateMatches = skipCondition.match(/\{\{([^}]+)\}\}/g) || [];
              for (const match of templateMatches) {
                const path = match.slice(2, -2);
                const parts = path.split('.');
                let value;
                if (parts[0].startsWith('step_')) {
                  const refStepNum = parseInt(parts[0].replace('step_', ''));
                  const stepResult = iterationResults.find(r => r.step === refStepNum);
                  if (stepResult) {
                    value = stepResult.result;
                    for (let i = 1; i < parts.length; i++) {
                      if (value && typeof value === 'object') value = value[parts[i]];
                      else { value = undefined; break; }
                    }
                    if (value === undefined && stepResult.result?.data) {
                      value = stepResult.result.data;
                      for (let i = 1; i < parts.length; i++) {
                        if (value && typeof value === 'object') value = value[parts[i]];
                        else { value = undefined; break; }
                      }
                    }
                  }
                }
                skipCondition = skipCondition.replace(match, value === undefined ? '' : String(value));
              }
              const eqIndex = skipCondition.indexOf('=');
              if (eqIndex !== -1) {
                if (skipCondition.substring(0, eqIndex).trim() === skipCondition.substring(eqIndex + 1).trim()) {
                  iterationResults.push({ step: step.step || iterationResults.length + 1, primitive: step.primitive, success: true, skipped: true, result: { ok: true, skipped: true, reason: `skip_if matched: ${step.skip_if}` } });
                  continue;
                }
              }
            } catch (skipError) {
              // On error, don't skip
            }
          }

          if (!PRIMITIVES[step.primitive]) throw new Error(`Primitive '${step.primitive}' not found`);
          const stepResult = await PRIMITIVES[step.primitive](env, resolvedArgs, `${runId}-iter${index}-${step.primitive}`, iterationContext);
          iterationResults.push({ step: step.step || iterationResults.length + 1, primitive: step.primitive, success: stepResult.ok !== false, result: stepResult });

          if (stepResult.ok === false && on_error === 'halt') {
            haltRequested = true;
            errors.push({ index, item, primitive: step.primitive, error: stepResult.error || 'Step failed' });
            break;
          }
        }
        iterations.push({ index, item, steps: iterationResults, success: iterationResults.every(r => r.success) });
      } catch (error) {
        errors.push({ index, item, error: error.message });
        if (on_error === 'halt') haltRequested = true;
      }
    }

    return {
      ok: errors.length === 0 || on_error === 'continue',
      status: 200,
      data: { iterations, total_count: array.length, processed_count: iterations.length, success_count: iterations.filter(i => i.success).length, error_count: errors.length, errors: errors.length > 0 ? errors : undefined }
    };
  },

  // util.conditional — Ternary logic
  async 'util.conditional'(env, args, runId, executionContext) {
    const { condition, if_true, if_false } = args;
    if (condition === undefined) return { ok: false, status: 400, error: 'condition is required' };
    if (if_true === undefined) return { ok: false, status: 400, error: 'if_true is required' };
    if (if_false === undefined) return { ok: false, status: 400, error: 'if_false is required' };

    let result;
    if (typeof condition === 'string') {
      const eqMatch = condition.match(/^(.+?)\s*===\s*['"]?(.+?)['"]?$/);
      if (eqMatch) { result = eqMatch[1].trim() === eqMatch[2].trim(); }
      else {
        const neqMatch = condition.match(/^(.+?)\s*!==\s*['"]?(.+?)['"]?$/);
        if (neqMatch) { result = neqMatch[1].trim() !== neqMatch[2].trim(); }
        else {
          const ltMatch = condition.match(/^(.+?)\s*<\s*(\d+(?:\.\d+)?)$/);
          if (ltMatch) { result = parseFloat(ltMatch[1].trim()) < parseFloat(ltMatch[2]); }
          else {
            const gtMatch = condition.match(/^(.+?)\s*>\s*(\d+(?:\.\d+)?)$/);
            if (gtMatch) { result = parseFloat(gtMatch[1].trim()) > parseFloat(gtMatch[2]); }
            else {
              const lteMatch = condition.match(/^(.+?)\s*<=\s*(\d+(?:\.\d+)?)$/);
              if (lteMatch) { result = parseFloat(lteMatch[1].trim()) <= parseFloat(lteMatch[2]); }
              else {
                const gteMatch = condition.match(/^(.+?)\s*>=\s*(\d+(?:\.\d+)?)$/);
                if (gteMatch) { result = parseFloat(gteMatch[1].trim()) >= parseFloat(gteMatch[2]); }
                else { result = !!condition.trim(); }
              }
            }
          }
        }
      }
    } else if (typeof condition === 'boolean') { result = condition; }
    else if (typeof condition === 'number') { result = condition !== 0; }
    else { result = !!condition; }

    return { ok: true, status: 200, data: { result: result ? if_true : if_false, condition_evaluated: result, original_condition: condition } };
  },

  // util.halt — Early protocol termination
  async 'util.halt'(env, args, runId, executionContext) {
    const { condition, reason = 'Protocol halted by util.halt' } = args;
    let shouldHalt = true;
    if (condition !== undefined) {
      if (typeof condition === 'string') {
        const eqMatch = condition.match(/^(.+?)\s*===\s*['"]?(.+?)['"]?$/);
        if (eqMatch) shouldHalt = eqMatch[1].trim() === eqMatch[2].trim();
        else {
          const gtMatch = condition.match(/^(.+?)\s*>\s*(\d+(?:\.\d+)?)$/);
          if (gtMatch) shouldHalt = parseFloat(gtMatch[1].trim()) > parseFloat(gtMatch[2]);
          else {
            const ltMatch = condition.match(/^(.+?)\s*<\s*(\d+(?:\.\d+)?)$/);
            if (ltMatch) shouldHalt = parseFloat(ltMatch[1].trim()) < parseFloat(ltMatch[2]);
            else shouldHalt = !condition.trim() || condition.trim() === '0' || condition.trim() === 'false';
          }
        }
      } else if (typeof condition === 'boolean') shouldHalt = condition;
      else if (typeof condition === 'number') shouldHalt = condition === 0;
      else shouldHalt = !condition;
    }
    return { ok: true, status: 200, data: { halted: shouldHalt, reason: shouldHalt ? reason : 'Condition not met, continuing', condition_evaluated: shouldHalt } };
  },

  // util.time — Timestamps and date math
  async 'util.time'(env, args, runId, executionContext) {
    const { operation, from = 'now', amount, unit, format = 'iso8601' } = args;
    if (!operation || !['now', 'subtract', 'add'].includes(operation)) {
      return { ok: false, error: "operation must be 'now', 'subtract', or 'add'" };
    }
    let baseDate = from === 'now' ? new Date() : new Date(from);
    if (isNaN(baseDate.getTime())) return { ok: false, error: `Invalid 'from' timestamp: ${from}` };

    if (operation === 'subtract' || operation === 'add') {
      if (typeof amount !== 'number' || amount < 0) return { ok: false, error: `'amount' must be a non-negative number` };
      if (!unit || !['hours', 'days', 'minutes', 'seconds'].includes(unit)) return { ok: false, error: `'unit' must be hours, days, minutes, or seconds` };
      const multipliers = { seconds: 1000, minutes: 60000, hours: 3600000, days: 86400000 };
      const ms = amount * multipliers[unit];
      baseDate = new Date(baseDate.getTime() + (operation === 'subtract' ? -ms : ms));
    }
    return { ok: true, status: 200, data: { timestamp: baseDate.toISOString(), operation, from: from === 'now' ? new Date().toISOString() : from, ...(amount !== undefined && { amount }), ...(unit && { unit }) } };
  },

  // util.math — Arithmetic operations
  async 'util.math'(env, args, runId, executionContext) {
    const { op, a, b, default_a = 0, default_b = 0, min, max, precision } = args;
    if (!op) return { ok: false, status: 400, error: 'op is required' };
    const valA = (a === null || a === undefined || a === '') ? default_a : parseFloat(a);
    const valB = (b === null || b === undefined || b === '') ? default_b : parseFloat(b);
    if (isNaN(valA)) return { ok: false, status: 400, error: `Invalid number for 'a': ${a}` };
    if (isNaN(valB) && op !== 'negate' && op !== 'abs') return { ok: false, status: 400, error: `Invalid number for 'b': ${b}` };

    let result;
    switch (op) {
      case 'add': result = valA + valB; break;
      case 'subtract': result = valA - valB; break;
      case 'multiply': result = valA * valB; break;
      case 'divide': if (valB === 0) return { ok: false, status: 400, error: 'Division by zero' }; result = valA / valB; break;
      case 'negate': result = -valA; break;
      case 'abs': result = Math.abs(valA); break;
      default: return { ok: false, status: 400, error: `Unknown op: ${op}` };
    }
    if (min !== undefined && result < min) result = min;
    if (max !== undefined && result > max) result = max;
    if (precision !== undefined) result = Math.round(result * Math.pow(10, precision)) / Math.pow(10, precision);
    return { ok: true, status: 200, data: { result, operation: op, inputs: { a: valA, b: valB } } };
  },

  // util.json.parse
  async 'util.json.parse'(env, args, runId, executionContext) {
    let jsonString = args.json_string;
    if (typeof jsonString !== 'string') return { ok: false, error: 'json_string must be a string' };
    jsonString = jsonString.trim();
    if (jsonString.startsWith('```')) {
      jsonString = jsonString.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?\s*```\s*$/, '').trim();
    }
    try {
      return { ok: true, status: 200, data: { parsed: JSON.parse(jsonString) } };
    } catch (error) {
      return { ok: false, status: 400, error: `JSON parse failed: ${error.message}` };
    }
  },

  // util.json.stringify
  async 'util.json.stringify'(env, args, runId, executionContext) {
    const { data, indent = 2 } = args;
    if (data === undefined) return { ok: false, error: 'data is required' };
    try {
      return { ok: true, status: 200, data: JSON.stringify(data, null, indent) };
    } catch (error) {
      return { ok: false, status: 400, error: `JSON stringify failed: ${error.message}` };
    }
  },

  // util.regex — Pattern matching and extraction
  async 'util.regex'(env, args, runId, executionContext) {
    const { input, pattern, output_template, find_by, find_value, field, flags = '' } = args;
    if (!pattern) return { ok: false, status: 400, error: 'pattern is required' };

    let targetString;
    if (Array.isArray(input) && find_by && find_value !== undefined) {
      const found = input.find(item => {
        const itemValue = find_by.split('.').reduce((obj, k) => obj?.[k], item);
        return itemValue === find_value;
      });
      if (!found) return { ok: true, status: 200, data: { result: null, matched: false, reason: 'No matching item found' } };
      targetString = field ? field.split('.').reduce((obj, k) => obj?.[k], found) : JSON.stringify(found);
    } else if (typeof input === 'string') {
      targetString = input;
    } else if (typeof input === 'object' && field) {
      targetString = field.split('.').reduce((obj, k) => obj?.[k], input);
    } else {
      return { ok: false, status: 400, error: 'input must be a string, array with find_by/find_value, or object with field' };
    }

    if (typeof targetString !== 'string') return { ok: true, status: 200, data: { result: null, matched: false, reason: 'Target field is not a string' } };

    try {
      const regex = new RegExp(pattern, flags);
      const match = targetString.match(regex);
      if (!match) return { ok: true, status: 200, data: { result: null, matched: false, input: targetString } };

      let result;
      if (output_template) {
        result = output_template.replace(/\$(\d+)/g, (_, n) => match[parseInt(n)] || '');
      } else {
        result = match[0];
      }
      return { ok: true, status: 200, data: { result: result.trim(), matched: true, groups: match.slice(1), full_match: match[0], input: targetString } };
    } catch (e) {
      return { ok: false, status: 400, error: `Invalid regex: ${e.message}` };
    }
  },

  // data.match — Join two datasets by key
  async 'data.match'(env, args, runId, executionContext) {
    const { left, right, left_key, right_key, normalize = true } = args;
    if (!Array.isArray(left)) return { ok: false, status: 400, error: 'left must be an array' };
    if (!Array.isArray(right)) return { ok: false, status: 400, error: 'right must be an array' };
    if (left_key === undefined || right_key === undefined) return { ok: false, status: 400, error: 'left_key and right_key are required' };

    function getKey(item, keyPath) {
      if (typeof keyPath === 'number') return Array.isArray(item) ? item[keyPath] : undefined;
      return String(keyPath).split('.').reduce((obj, k) => obj?.[k], item);
    }
    function normalizeKey(val) {
      if (val === null || val === undefined) return '';
      const s = String(val).trim();
      return normalize ? s.toLowerCase() : s;
    }

    const rightIsRows = Array.isArray(right[0]);
    const rightData = rightIsRows ? right.slice(1) : right;
    const rightHeader = rightIsRows ? right[0] : null;

    const rightIndex = new Map();
    for (let i = 0; i < rightData.length; i++) {
      const key = normalizeKey(getKey(rightData[i], right_key));
      if (key) rightIndex.set(key, { item: rightData[i], index: i });
    }

    const matched = [], leftOnly = [], matchedRightKeys = new Set();
    for (let i = 0; i < left.length; i++) {
      const key = normalizeKey(getKey(left[i], left_key));
      if (key && rightIndex.has(key)) {
        matched.push({ left: left[i], right: rightIndex.get(key).item, key: getKey(left[i], left_key) });
        matchedRightKeys.add(key);
      } else {
        leftOnly.push(left[i]);
      }
    }
    const rightOnly = [];
    for (let i = 0; i < rightData.length; i++) {
      const key = normalizeKey(getKey(rightData[i], right_key));
      if (!matchedRightKeys.has(key)) rightOnly.push(rightData[i]);
    }

    return { ok: true, status: 200, data: { matched, left_only: leftOnly, right_only: rightOnly, right_header: rightHeader, stats: { matched: matched.length, left_only: leftOnly.length, right_only: rightOnly.length } } };
  },

  // data.map — Deterministic value transformations
  async 'data.map'(env, args, runId, executionContext) {
    const { data, mappings, format = 'rows' } = args;
    if (!Array.isArray(data)) return { ok: false, status: 400, error: 'data must be an array' };
    if (!Array.isArray(mappings)) return { ok: false, status: 400, error: 'mappings must be an array' };

    function parseDate(val) {
      if (!val || val === '' || val === 'Pending') return null;
      const s = String(val).trim();
      if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
      if (/^\d{4}-\d{2}-\d{2}T/.test(s)) return s.slice(0, 10);
      const mdyMatch = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
      if (mdyMatch) { const [, m, d, y] = mdyMatch; return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`; }
      const mdyShort = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})$/);
      if (mdyShort) { const [, m, d, y] = mdyShort; return `${parseInt(y) > 50 ? '19' : '20'}${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`; }
      return null;
    }

    function applyMapping(value, mapping) {
      const { format: fmt, lookup, true_value, false_value, values } = mapping;
      if (lookup) { return lookup[String(value ?? '')] !== undefined ? lookup[String(value ?? '')] : value; }
      if (fmt === 'date') return parseDate(value);
      if (fmt === 'boolean') {
        const s = String(value ?? '').trim().toLowerCase();
        if (s === (true_value || 'yes').toLowerCase() || s === 'true') return true;
        if (s === '' || s === (false_value || 'no').toLowerCase() || s === 'false') return false;
        return null;
      }
      if (fmt === 'lowercase') return value ? String(value).toLowerCase() : value;
      if (fmt === 'uppercase') return value ? String(value).toUpperCase() : value;
      if (values) return values.includes(String(value ?? '').toLowerCase()) ? String(value).toLowerCase() : null;
      return value;
    }

    const result = data.map(item => {
      let transformed = Array.isArray(item) ? [...item] : { ...item };
      for (const mapping of mappings) {
        const { field } = mapping;
        if (field === undefined) continue;
        if (typeof field === 'number' && Array.isArray(transformed)) {
          transformed[field] = applyMapping(transformed[field], mapping);
        } else if (typeof field === 'string' && typeof transformed === 'object' && !Array.isArray(transformed)) {
          const keys = field.split('.');
          let obj = transformed;
          for (let i = 0; i < keys.length - 1; i++) obj = obj?.[keys[i]];
          if (obj) obj[keys[keys.length - 1]] = applyMapping(obj[keys[keys.length - 1]], mapping);
        }
      }
      return transformed;
    });
    return { ok: true, status: 200, data: result };
  }
};

// ===== PRIMITIVE MANIFEST =====

const PRIMITIVE_MANIFEST = {
  'memory.log': {
    description: 'Log events to D1 executions table and memories table with semantic embedding',
    input_schema: { required: ['event'], optional: ['payload', 'protocol_key', 'duration_ms', 'source', 'execution_status', 'error_details'],
      parameters: { event: { type: 'string', description: 'Event name' }, payload: { type: 'object', description: 'Event data' }, protocol_key: { type: 'string', description: 'Protocol key' }, duration_ms: { type: 'number', description: 'Duration in ms' }, source: { type: 'string', description: 'scheduled|manual|test' }, execution_status: { type: 'string', description: 'success|failed|halted' }, error_details: { type: 'string', description: 'Error message' } } }
  },
  'memory.search': {
    description: 'Semantic search over stored memories using Workers AI embeddings',
    input_schema: { required: ['query'], optional: ['top_k', 'event_filter'],
      parameters: { query: { type: 'string', description: 'Search query (matched by meaning)' }, top_k: { type: 'number', description: 'Number of results to return (default 5)' }, event_filter: { type: 'string', description: 'Filter by event type' } } }
  },
  'http.fetch': {
    description: 'Make raw HTTP requests',
    input_schema: { required: ['url'], optional: ['method', 'headers', 'body'],
      parameters: { url: { type: 'string', description: 'Target URL' }, method: { type: 'string', description: 'HTTP method' }, headers: { type: 'object', description: 'Request headers' }, body: { type: 'object', description: 'Request body' } } }
  },
  'http.registry_fetch': {
    description: 'Registry-enforced HTTP using KV registry entries',
    input_schema: { required: ['op_key'], optional: ['params', 'headers', 'body'],
      parameters: { op_key: { type: 'string', description: 'Registry operation key' }, params: { type: 'object', description: 'Operation parameters' }, headers: { type: 'object', description: 'Additional headers' }, body: { type: 'object', description: 'Request body override' } } }
  },
  'llm.generate': {
    description: 'Generate text via Claude, GPT, or Grok APIs',
    input_schema: { required: ['prompt', 'model'], optional: ['max_tokens', 'temperature', 'input'],
      parameters: { prompt: { type: 'string', description: 'The prompt' }, model: { type: 'string', description: 'Model ID (claude-*, gpt-*, grok-*)' }, max_tokens: { type: 'number', description: 'Max output tokens' }, temperature: { type: 'number', description: 'Sampling temperature' }, input: { type: 'string', description: 'Additional input data' } } }
  },
  'validate.schema': {
    description: 'Validate data structure before operations',
    input_schema: { required: ['data', 'schema'], optional: ['fallback', 'strict'],
      parameters: { data: { type: 'object', description: 'Data to validate' }, schema: { type: 'object', description: 'Validation schema' }, fallback: { type: 'object', description: 'Fallback value on failure' }, strict: { type: 'boolean', description: 'Fail hard on validation error' } } }
  },
  'util.foreach': {
    description: 'Iterate over array executing nested steps per item',
    input_schema: { required: ['array', 'steps'], optional: ['on_error', 'context', 'max_iterations'],
      parameters: { array: { type: 'array', description: 'Array to iterate' }, steps: { type: 'array', description: 'Steps to execute per item' }, on_error: { type: 'string', description: 'continue or halt' }, context: { type: 'object', description: 'Outer values accessible as {{context.key}}' }, max_iterations: { type: 'number', description: 'Max items to process' } } },
    validation_config: { skip_nested_steps: true }
  },
  'util.conditional': {
    description: 'Ternary if/else logic',
    input_schema: { required: ['condition', 'if_true', 'if_false'], optional: [],
      parameters: { condition: { type: 'string', description: 'Condition expression' }, if_true: { type: 'object', description: 'Value if true' }, if_false: { type: 'object', description: 'Value if false' } } }
  },
  'util.halt': {
    description: 'Early protocol termination',
    input_schema: { required: [], optional: ['condition', 'reason'],
      parameters: { condition: { type: 'string', description: 'Halt condition' }, reason: { type: 'string', description: 'Halt reason' } } }
  },
  'util.time': {
    description: 'Timestamps and date arithmetic',
    input_schema: { required: ['operation'], optional: ['from', 'amount', 'unit'],
      parameters: { operation: { type: 'string', description: 'now, add, or subtract' }, from: { type: 'string', description: 'Base timestamp (default: now)' }, amount: { type: 'number', description: 'Amount to add/subtract' }, unit: { type: 'string', description: 'hours, days, minutes, seconds' } } }
  },
  'util.math': {
    description: 'Arithmetic operations',
    input_schema: { required: ['op'], optional: ['a', 'b', 'default_a', 'default_b', 'min', 'max', 'precision'],
      parameters: { op: { type: 'string', description: 'add, subtract, multiply, divide, negate, abs' }, a: { type: 'number', description: 'First operand' }, b: { type: 'number', description: 'Second operand' } } }
  },
  'util.json.parse': {
    description: 'Parse JSON string to object',
    input_schema: { required: ['json_string'], optional: [],
      parameters: { json_string: { type: 'string', description: 'JSON string to parse' } } }
  },
  'util.json.stringify': {
    description: 'Serialize object to JSON string',
    input_schema: { required: ['data'], optional: ['indent'],
      parameters: { data: { type: 'object', description: 'Data to stringify' }, indent: { type: 'number', description: 'Indentation spaces' } } }
  },
  'util.regex': {
    description: 'Pattern matching and extraction',
    input_schema: { required: ['pattern'], optional: ['input', 'output_template', 'find_by', 'find_value', 'field', 'flags'],
      parameters: { pattern: { type: 'string', description: 'Regex pattern' }, input: { type: 'string', description: 'String to match against' }, output_template: { type: 'string', description: 'Template with $N group refs' }, flags: { type: 'string', description: 'Regex flags' } } }
  },
  'data.match': {
    description: 'Join two datasets by matching key',
    input_schema: { required: ['left', 'right', 'left_key', 'right_key'], optional: ['normalize'],
      parameters: { left: { type: 'array', description: 'Left dataset' }, right: { type: 'array', description: 'Right dataset' }, left_key: { type: 'string', description: 'Key field in left' }, right_key: { type: 'string', description: 'Key field in right' }, normalize: { type: 'boolean', description: 'Normalize keys for comparison' } } }
  },
  'data.map': {
    description: 'Apply deterministic value transformations',
    input_schema: { required: ['data', 'mappings'], optional: ['format'],
      parameters: { data: { type: 'array', description: 'Array of items to transform' }, mappings: { type: 'array', description: 'Transformation rules' }, format: { type: 'string', description: 'Output format' } } }
  }
};

// ===== TEMPLATE RESOLUTION SYSTEM =====

function getNestedProperty(obj, path) {
  if (!obj || typeof path !== 'string') return undefined;
  const parts = path.split('.').flatMap(part => {
    if (part.includes('[')) {
      const matches = part.match(/([^[]+)\[(\d+)\]/);
      return matches ? [matches[1], parseInt(matches[2])] : [part];
    }
    return [part];
  });
  let current = obj;
  for (const key of parts) {
    if (current === null || current === undefined) return undefined;
    current = current[key];
  }
  return current;
}

function get(obj, p) {
  return p.split('.').reduce((v, k) => v?.[k], obj);
}

function findFieldRecursively(obj, fieldName, currentPath = '', maxDepth = 5) {
  if (fieldName === 'id' && currentPath.length > 0) return null;
  if (currentPath.split('.').length > maxDepth) return null;
  if (obj && typeof obj === 'object') {
    if (obj[fieldName] !== undefined) return obj[fieldName];
    for (const [key, value] of Object.entries(obj)) {
      const newPath = currentPath ? `${currentPath}.${key}` : key;
      const result = findFieldRecursively(value, fieldName, newPath, maxDepth);
      if (result !== null && result !== undefined) return result;
    }
  }
  return null;
}

function resolve(path, ctx) {
  let resolvedValue;
  const stepMatch = path.match(/^step_(\d+)(_result)?(?:\.(.+))?$/);
  if (stepMatch) {
    const stepNum = stepMatch[1];
    const fieldPath = stepMatch[3];
    const stepResultKey = `step_${stepNum}_result`;
    const stepKey = `step_${stepNum}`;

    if (!fieldPath) {
      if (ctx[stepResultKey]) resolvedValue = ctx[stepResultKey].data !== undefined ? ctx[stepResultKey].data : ctx[stepResultKey];
      if (resolvedValue === undefined && ctx[stepKey]) resolvedValue = ctx[stepKey];
    } else {
      if (ctx[stepResultKey]?.data !== undefined) resolvedValue = getNestedProperty(ctx[stepResultKey].data, fieldPath);
      if (resolvedValue === undefined && ctx[stepResultKey]) resolvedValue = getNestedProperty(ctx[stepResultKey], fieldPath);
      if (resolvedValue === undefined && ctx[stepKey]) resolvedValue = getNestedProperty(ctx[stepKey], fieldPath);

      if (resolvedValue === undefined && fieldPath) {
        const finalFieldName = fieldPath.split('.').pop();
        if (ctx[stepResultKey]) resolvedValue = findFieldRecursively(ctx[stepResultKey], finalFieldName);
        if (resolvedValue === undefined && ctx[stepKey]) resolvedValue = findFieldRecursively(ctx[stepKey], finalFieldName);
      }
    }
    if (resolvedValue === undefined) return undefined;
  } else {
    resolvedValue = get(ctx, path);
    if (resolvedValue === undefined) return undefined;
  }
  if (resolvedValue === null) return "";
  return resolvedValue;
}

function resolveStringTemplates(str, resultLookup) {
  const templatePattern = /\{\{([^}]+)\}\}/g;
  const ESCAPED_OPEN = '__DONNA_ESCAPED_OPEN_BRACE__';
  const ESCAPED_CLOSE = '__DONNA_ESCAPED_CLOSE_BRACE__';

  let workingStr = str.replace(/\\\{\\\{/g, ESCAPED_OPEN).replace(/\\\}\\\}/g, ESCAPED_CLOSE);

  const singleTemplateMatch = workingStr.match(/^\{\{([^}]+)\}\}$/);
  if (singleTemplateMatch) {
    const resolvedValue = resolve(singleTemplateMatch[1].trim(), resultLookup);
    if (resolvedValue !== undefined) {
      if (typeof resolvedValue === 'string') {
        return resolvedValue.replace(new RegExp(ESCAPED_OPEN, 'g'), '{{').replace(new RegExp(ESCAPED_CLOSE, 'g'), '}}');
      }
      return resolvedValue;
    }
  }

  const isJsonContext = workingStr.trim().startsWith('{') || workingStr.trim().startsWith('[');
  const sanitizeResolved = (s) => s.replace(/\{\{/g, '{ {').replace(/\}\}/g, '} }');

  const resolved = workingStr.replace(templatePattern, (match, expression) => {
    const trimmed = expression.trim();
    const value = resolve(trimmed, resultLookup);
    if (value !== undefined) {
      if (typeof value === 'string') {
        if (isJsonContext) {
          return sanitizeResolved(value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t'));
        }
        return sanitizeResolved(value);
      }
      return sanitizeResolved(JSON.stringify(value));
    }
    return match;
  });

  return resolved.replace(new RegExp(ESCAPED_OPEN, 'g'), '{{').replace(new RegExp(ESCAPED_CLOSE, 'g'), '}}');
}

function checkUnresolvedTemplates(args, stepNumber) {
  const unresolvedPattern = /\{\{([^}]+)\}\}/g;
  function scanValue(value, path) {
    if (typeof value === 'string') {
      const match = unresolvedPattern.exec(value);
      if (match) { unresolvedPattern.lastIndex = 0; return { valid: false, arg: path, template: match[0], fullTemplate: match[1] }; }
      unresolvedPattern.lastIndex = 0;
    } else if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) { const r = scanValue(value[i], `${path}[${i}]`); if (!r.valid) return r; }
    } else if (value && typeof value === 'object') {
      for (const [key, val] of Object.entries(value)) { const r = scanValue(val, path ? `${path}.${key}` : key); if (!r.valid) return r; }
    }
    return { valid: true };
  }
  return scanValue(args, '');
}

function resolveTemplatesRecursive(obj, resultLookup) {
  if (typeof obj === 'string') return resolveStringTemplates(obj, resultLookup);
  if (Array.isArray(obj)) return obj.map(item => resolveTemplatesRecursive(item, resultLookup));
  if (obj && typeof obj === 'object') {
    const resolved = {};
    for (const [key, value] of Object.entries(obj)) resolved[key] = resolveTemplatesRecursive(value, resultLookup);
    return resolved;
  }
  return obj;
}

function resolveTemplates(step, executionResults, executionContext) {
  const resultLookup = {};
  Object.assign(resultLookup, executionContext);

  for (let i = 0; i < executionResults.length; i++) {
    const result = executionResults[i];
    if (result.result) {
      resultLookup[`step_${i + 1}_result`] = result.result;
      resultLookup[`step_${i + 1}`] = result.result.data || result.result;
      if (result.success) resultLookup['previous_result'] = result.result;
    }
  }

  const primitiveConfig = PRIMITIVE_MANIFEST[step.primitive];
  if (primitiveConfig?.validation_config?.skip_nested_steps && step.args?.steps) {
    const {steps: nestedSteps, ...argsWithoutSteps} = step.args;
    const resolvedArgsWithoutSteps = resolveTemplatesRecursive({args: argsWithoutSteps}, resultLookup).args;
    return { ...step, args: { ...resolvedArgsWithoutSteps, steps: nestedSteps } };
  }
  return resolveTemplatesRecursive(step, resultLookup);
}

// ===== VALIDATION =====

function extractTemplatesFromObject(obj, templates = []) {
  if (typeof obj === 'string') {
    const matches = obj.matchAll(/\{\{([^}]+)\}\}/g);
    for (const match of matches) templates.push(match[1]);
  } else if (Array.isArray(obj)) {
    obj.forEach(item => extractTemplatesFromObject(item, templates));
  } else if (obj && typeof obj === 'object') {
    Object.values(obj).forEach(value => extractTemplatesFromObject(value, templates));
  }
  return templates;
}

function validatePrimitiveStep(step, stepNumber) {
  if (!step.primitive || typeof step.primitive !== 'string') {
    return { valid: false, error: `Step ${stepNumber}: Missing or invalid 'primitive' field` };
  }
  const manifest = PRIMITIVE_MANIFEST[step.primitive];
  if (!manifest) {
    return { valid: false, error: `Step ${stepNumber}: Unknown primitive '${step.primitive}'. Available: ${Object.keys(PRIMITIVE_MANIFEST).join(', ')}` };
  }
  const args = step.args || {};
  const schema = manifest.input_schema;
  for (const requiredParam of schema.required) {
    if (!(requiredParam in args)) {
      return { valid: false, error: `Step ${stepNumber}: Missing required parameter '${requiredParam}' for '${step.primitive}'` };
    }
    const paramValue = args[requiredParam];
    const isTemplateString = typeof paramValue === 'string' && /\{\{[^}]+\}\}/.test(paramValue);
    if (isTemplateString) continue;
  }
  return { valid: true };
}

function validateBatchSteps(steps, env = {}) {
  for (let i = 0; i < steps.length; i++) {
    const validation = validatePrimitiveStep(steps[i], i + 1);
    if (!validation.valid) return validation;
  }
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const stepNum = i + 1;
    let argsToValidate = step.args;
    const primitiveConfig = PRIMITIVE_MANIFEST[step.primitive];
    if (primitiveConfig?.validation_config?.skip_nested_steps && step.args?.steps) {
      const {steps: nestedSteps, ...argsWithoutSteps} = step.args;
      argsToValidate = argsWithoutSteps;
    }
    const templates = extractTemplatesFromObject(argsToValidate);
    for (const template of templates) {
      const rootKey = template.split('.')[0].trim();
      const stepMatchRef = rootKey.match(/^(step_(\d+)(_result)?|previous_result)$/);
      if (stepMatchRef) {
        const refStepNum = stepMatchRef[2] ? parseInt(stepMatchRef[2]) : stepNum - 1;
        if (refStepNum >= stepNum) {
          return { valid: false, error: `Step ${stepNum}: Template {{${template}}} references future step ${refStepNum}` };
        }
      }
    }
  }
  return { valid: true };
}

// ===== BATCH EXECUTION ENGINE =====

async function executeBatch(env, run_id, steps, initialContext = {}) {
  if (!validateRunId(run_id)) throw new Error('run_id required (non-empty string)');
  if (!Array.isArray(steps) || steps.length === 0) throw new Error('steps required (non-empty array)');

  const validation = validateBatchSteps(steps, env);
  if (!validation.valid) throw new Error(`Validation failed: ${validation.error}`);

  const executionStartTime = Date.now();
  const executionResults = [];
  const executionContext = {
    context: initialContext,
    protocol_key: initialContext.protocol_key || null
  };

  // Initialize budget tracking
  let dailyBudget = DEFAULT_DAILY_LLM_BUDGET_USD;
  let maxLLMCalls = MAX_LLM_CALLS_PER_RUN;
  try {
    const budgetRaw = await env.REGISTRY_KV?.get('config:daily_budget_usd');
    if (budgetRaw) dailyBudget = parseFloat(budgetRaw);
    const llmCapRaw = await env.REGISTRY_KV?.get('config:max_llm_calls_per_run');
    if (llmCapRaw) maxLLMCalls = parseInt(llmCapRaw);
  } catch {}
  let currentDailySpend = 0;
  try { currentDailySpend = await getDailyLLMSpend(env); } catch {}
  executionContext._budget = {
    llmCallCount: 0,
    maxLLMCallsPerRun: maxLLMCalls,
    dailyBudgetUsd: dailyBudget,
    dailySpendUsd: currentDailySpend,
  };

  let stepNumber = 0;

  for (const step of steps) {
    stepNumber++;
    const stepRunId = `${run_id}-step-${stepNumber}`;
    const stepStartTime = Date.now();

    // skip_if evaluation
    if (step.skip_if) {
      try {
        let skipCondition = step.skip_if;
        const templateMatches = skipCondition.match(/\{\{([^}]+)\}\}/g) || [];
        for (const match of templateMatches) {
          const path = match.slice(2, -2);
          const parts = path.split('.');
          let value;
          if (parts[0].startsWith('step_')) {
            const refStepNum = parseInt(parts[0].replace('step_', ''));
            const stepResult = executionResults.find(r => r.step === refStepNum);
            if (stepResult) {
              value = stepResult.result;
              for (let i = 1; i < parts.length; i++) {
                if (value && typeof value === 'object') value = value[parts[i]];
                else { value = undefined; break; }
              }
              if (value === undefined && stepResult.result?.data) {
                value = stepResult.result.data;
                for (let i = 1; i < parts.length; i++) {
                  if (value && typeof value === 'object') value = value[parts[i]];
                  else { value = undefined; break; }
                }
              }
            }
          }
          skipCondition = skipCondition.replace(match, value === undefined ? '' : String(value));
        }
        const eqIndex = skipCondition.indexOf('=');
        if (eqIndex !== -1) {
          if (skipCondition.substring(0, eqIndex).trim() === skipCondition.substring(eqIndex + 1).trim()) {
            executionResults.push({ step: stepNumber, primitive: step.primitive, success: true, skipped: true, result: { ok: true, skipped: true, reason: `skip_if matched: ${step.skip_if}` }, execution_time_ms: 0 });
            continue;
          }
        }
      } catch (skipError) {
        // On error, don't skip
      }
    }

    try {
      const resolvedStep = resolveTemplates(step, executionResults, executionContext);
      const resolvedArgs = resolvedStep.args || {};

      // Unresolved template check
      let unresolvedCheck;
      const primitiveConfig = PRIMITIVE_MANIFEST[resolvedStep.primitive];
      if (primitiveConfig?.validation_config?.skip_nested_steps) {
        const {steps: nestedSteps, ...argsWithoutSteps} = resolvedArgs;
        unresolvedCheck = checkUnresolvedTemplates(argsWithoutSteps, stepNumber);
      } else {
        unresolvedCheck = checkUnresolvedTemplates(resolvedArgs, stepNumber);
      }

      if (!unresolvedCheck.valid) {
        const errorMsg = `Unresolved template in step ${stepNumber}, arg '${unresolvedCheck.arg}': ${unresolvedCheck.template}`;
        executionResults.push({ step: stepNumber, primitive: step.primitive, success: false, result: { ok: false, error: errorMsg }, error: errorMsg, duration_ms: Date.now() - stepStartTime });
        return { success: false, run_id, results: executionResults, error: errorMsg };
      }

      // Auto-inject protocol_key for memory.log
      if (resolvedStep.primitive === 'memory.log' && executionContext.protocol_key) {
        resolvedArgs.protocol_key = executionContext.protocol_key;
      }

      const result = await PRIMITIVES[resolvedStep.primitive](env, resolvedArgs, stepRunId, executionContext);
      const executionTime = Date.now() - stepStartTime;

      // Post-process LLM output
      let processedResult = result;
      if (resolvedStep.primitive === 'llm.generate' && result?.ok && result?.data?.content?.[0]?.text) {
        try {
          const cleanedText = stripCodeFences(result.data.content[0].text.trim());
          const jsonStart = cleanedText.search(/[{\[]/);
          const jsonEnd = cleanedText.search(/[}\]]\s*$/);
          if (jsonStart !== -1 && jsonEnd >= jsonStart) {
            const parsedData = JSON.parse(cleanedText.substring(jsonStart, jsonEnd + 1));
            processedResult = { ...result, data: parsedData, raw_llm_response: result.data };
          }
        } catch (parseError) { /* keep original */ }
      }

      // Fail fast on HTTP errors
      if (step.primitive === 'http.fetch' && result.status >= 400) {
        executionResults.push({ step: stepNumber, primitive: step.primitive, success: false, error: `HTTP ${result.status}`, execution_time_ms: executionTime, result: { ok: false, status: result.status, data: null, error: result.data?.message || 'Request failed' } });
        break;
      }

      const normalizedResult = {
        ok: !!(processedResult?.ok || processedResult?.success),
        status: processedResult?.status || 'success',
        data: processedResult?.data || processedResult,
        error: processedResult?.error || null
      };

      executionResults.push({ step: stepNumber, primitive: step.primitive, success: normalizedResult.ok, result: normalizedResult, execution_time_ms: executionTime });

      // util.halt check
      if (step.primitive === 'util.halt' && normalizedResult.data?.halted === true) break;

    } catch (error) {
      executionResults.push({ step: stepNumber, primitive: step.primitive, success: false, error: error.message, result: { ok: false, status: 'error', data: null, error: error.message } });
      break;
    }
  }

  const allSucceeded = executionResults.every(r => r.success);
  const totalDuration = Date.now() - executionStartTime;

  // Log completion to D1
  await PRIMITIVES['memory.log'](env, {
    event: initialContext.protocol_key ? `${initialContext.protocol_key}_complete` : 'batch_complete',
    protocol_key: initialContext.protocol_key,
    duration_ms: totalDuration,
    execution_status: allSucceeded ? 'success' : 'failed',
    payload: { run_id, total_steps: steps.length, executed: executionResults.length, succeeded: executionResults.filter(r => r.success).length }
  }, run_id, executionContext);

  return { success: allSucceeded, run_id, total_steps: steps.length, executed_steps: executionResults.length, execution_results: executionResults, duration_ms: totalDuration };
}

// ===== AUTH MIDDLEWARE =====

function requireAuth(request, env) {
  const token = request.headers.get('Authorization')?.replace('Bearer ', '');
  if (!token || token !== env.ADMIN_TOKEN) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401, headers: { 'Content-Type': 'application/json' }
    });
  }
  return null;
}

// ===== AUTHORING CONTEXT =====

function buildAuthoringContext() {
  return {
    version: '1.0.0',
    primitive_schemas: PRIMITIVE_MANIFEST,
    conventions: {
      naming: 'snake_case for primitives, protocol keys',
      step_refs: '{{step_N.field}} or {{step_N}} for full data',
      foreach_refs: '{{item}}, {{index}}, {{context.key}}',
      escape: '\\{\\{ and \\}\\} for literal braces',
      output_contract: 'All primitives return {ok, status, data, error}'
    },
    template_syntax: {
      step_reference: '{{step_1.field}} — resolves to step 1 result.data.field',
      full_result: '{{step_1}} — resolves to step 1 result.data (or full result)',
      context: '{{context.key}} — inside foreach loops',
      env_vars: '{{VAR_NAME}} in headers — resolves to env.VAR_NAME'
    },
    example_protocol: {
      protocol_key: 'hello_world',
      name: 'Hello World',
      steps: [
        { step: 1, primitive: 'util.time', args: { operation: 'now' } },
        { step: 2, primitive: 'llm.generate', args: { model: 'claude-haiku-4-5-20251001', max_tokens: 200, prompt: 'The time is {{step_1.timestamp}}. Write a greeting.' } },
        { step: 3, primitive: 'memory.log', args: { event: 'hello_world_completed', payload: { greeting: '{{step_2}}', timestamp: '{{step_1.timestamp}}' } } }
      ]
    }
  };
}

// ===== DEMO PAGE =====

const DEMO_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Donna — AI That Knows Who You Are and Learns From Itself</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: #0c0c0c; color: #b0b0b0;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    font-size: 16px; line-height: 1.7;
    -webkit-font-smoothing: antialiased;
  }
  .wrap { max-width: 700px; margin: 0 auto; padding: 60px 24px 80px; }
  h1 { font-size: 32px; font-weight: 700; color: #fff; line-height: 1.25; margin-bottom: 16px; }
  h2 { font-size: 22px; font-weight: 600; color: #fff; margin-bottom: 8px; }
  .lead { font-size: 17px; color: #888; margin-bottom: 10px; }
  strong { color: #e0e0e0; }
  em { color: #ccc; }
  .hero { text-align: center; margin-bottom: 48px; }

  /* How it works */
  .how { margin: 0 0 40px; }
  .how > p { color: #888; font-size: 15px; margin-bottom: 16px; }
  .flow { display: flex; align-items: stretch; gap: 8px; margin: 20px 0; flex-wrap: wrap; justify-content: center; }
  .flow-node {
    background: #141414; border: 1px solid #222; border-radius: 10px;
    padding: 14px 18px; text-align: center; flex: 1; min-width: 110px;
  }
  .flow-name { font-size: 13px; font-weight: 600; color: #5cb8b2; font-family: 'SF Mono', 'Fira Code', monospace; }
  .flow-desc { font-size: 12px; color: #666; margin-top: 4px; }
  .flow-arrow { color: #333; font-size: 20px; display: flex; align-items: center; }
  .flow-loop { text-align: center; color: #e8b84a; font-size: 13px; margin-top: 6px; font-style: italic; }

  /* Button */
  .cta { text-align: center; margin: 32px 0; }
  .btn {
    display: inline-block; background: #5cb8b2; color: #0c0c0c;
    border: none; padding: 16px 40px; border-radius: 8px;
    font: inherit; font-size: 16px; font-weight: 600;
    cursor: pointer; letter-spacing: 0.3px;
  }
  .btn:hover { background: #6ec8c2; }
  .btn:disabled { background: #222; color: #555; cursor: wait; }
  .btn-note { font-size: 13px; color: #444; margin-top: 12px; }

  /* Demo Panel */
  .demo-panel {
    background: #0e0e0e; border: 1px solid #1e1e1e;
    border-radius: 12px; margin: 32px 0; overflow: hidden;
  }
  .demo-panel.active { border-color: #1a2e2c; }
  .panel-head {
    padding: 14px 24px; background: #121212;
    border-bottom: 1px solid #1a1a1a;
    display: flex; gap: 6px; flex-wrap: wrap; align-items: center;
  }
  .step {
    font-size: 12px; padding: 4px 12px; border-radius: 16px;
    background: #161616; color: #444; border: 1px solid #1e1e1e;
    transition: all 0.4s;
  }
  .step.active {
    background: #0f1e1d; color: #5cb8b2; border-color: #1a3a38;
    animation: stepBlink 1.4s ease-in-out infinite;
  }
  @keyframes stepBlink {
    0%, 100% { color: #5cb8b2; border-color: #1a3a38; background: #0f1e1d; }
    50% { color: #00ffcc; border-color: #00ffcc; background: #0a2a25; box-shadow: 0 0 8px rgba(0,255,204,0.25); }
  }
  .step.done { background: #0f1e0f; color: #5a9a5a; border-color: #1a3a1a; }
  .step.review { cursor: pointer; }
  .step.review:hover { border-color: #3a5a58; color: #7ad8d0; }
  .step.viewing { background: #0f1e1d; color: #5cb8b2; border-color: #5cb8b2; cursor: pointer; }
  .review-hint {
    font-size: 11px; color: #444; margin-left: auto; font-style: italic;
    animation: fadeIn 0.5s ease;
  }
  @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }

  .panel-ctx {
    padding: 20px 24px 0;
  }
  .ctx-row { margin-bottom: 10px; }
  .ctx-label {
    font-size: 10px; font-weight: 600; letter-spacing: 1.5px;
    text-transform: uppercase; color: #555; margin-bottom: 3px;
  }
  .ctx-text { color: #999; font-size: 14px; line-height: 1.5; }
  .ctx-text.highlight { color: #e8b84a; transition: color 0.5s; }
  .ctx-divider { border: none; border-top: 1px solid #1a1a1a; margin: 16px 24px 0; }

  .panel-content {
    padding: 20px 24px 24px;
    min-height: 120px;
    transition: opacity 0.3s ease;
  }

  /* Panel cards */
  .p-card {
    background: #141414; border: 1px solid #1e1e1e; border-radius: 8px;
    padding: 16px 20px; margin-bottom: 12px;
  }
  .p-card.output { border-left: 3px solid #7ec47e; }
  .p-card.found { border-left: 3px solid #88c0d0; }
  .p-card.eval { border-left: 3px solid #e8b84a; background: #17160e; border-color: #2a2818; border-left-color: #e8b84a; }
  .p-card.next-time { border-left: 3px solid #7ec47e; background: #12160e; border-color: #1e2a18; border-left-color: #7ec47e; }
  .p-label {
    font-size: 10px; font-weight: 600; letter-spacing: 1.5px;
    text-transform: uppercase; margin-bottom: 6px;
  }
  .p-label.out { color: #7ec47e; }
  .p-label.crit { color: #e8b84a; }
  .p-label.found-l { color: #88c0d0; }
  .p-label.next { color: #7ec47e; }
  .p-text { color: #ccc; font-size: 14px; line-height: 1.6; }
  .p-text.bright { color: #e0e0e0; }
  .p-text.dim { color: #cca855; font-style: italic; font-size: 13px; }
  .p-text.next-t { color: #6aaa6a; font-style: italic; font-size: 13px; }

  .mem-save { text-align: center; color: #e8b84a; font-size: 13px; margin: 8px 0 4px; }
  .mem-save span { display: inline-block; animation: pulse 1.5s ease infinite; }
  @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.3; } }

  .stage-note { color: #888; font-size: 14px; margin-top: 8px; font-style: italic; }
  .stage-explain {
    text-align: center; padding: 24px 16px;
  }
  .stage-explain p {
    color: #777; font-size: 14px; line-height: 1.7;
    max-width: 420px; margin: 0 auto;
  }
  .meta { font-size: 11px; color: #333; margin-top: 6px; }

  /* Thinking */
  .thinking { text-align: center; padding: 40px 20px; }
  .dot-pulse { display: inline-flex; gap: 5px; }
  .dot-pulse span {
    width: 7px; height: 7px; border-radius: 50%; background: #5cb8b2;
    animation: dotP 1.2s ease infinite;
  }
  .dot-pulse span:nth-child(2) { animation-delay: 0.2s; }
  .dot-pulse span:nth-child(3) { animation-delay: 0.4s; }
  @keyframes dotP { 0%,100% { opacity: 0.2; transform: scale(0.8); } 50% { opacity: 1; transform: scale(1.2); } }
  .thinking-label { color: #555; font-size: 13px; margin-top: 10px; }

  /* Conclusion */
  .conclusion { margin-top: 48px; }
  .insight-block {
    background: #0f1614; border: 1px solid #1a2a28;
    border-radius: 10px; padding: 20px 24px; margin-bottom: 24px;
    font-size: 15px; line-height: 1.7;
  }
  .insight-block p { color: #8ec8c0; margin-bottom: 12px; }
  .insight-block p:last-child { margin-bottom: 0; }
  .insight-block strong { color: #5cb8b2; }
  .insight-block a { color: #5cb8b2; text-decoration: none; }
  .insight-block a:hover { text-decoration: underline; }

  .optin-card {
    text-align: center; border: 1px solid #2a3a38;
    background: #0f1614; border-radius: 10px; padding: 36px 24px;
  }
  .optin-card h2 { margin-bottom: 8px; }
  .optin-card p { color: #888; font-size: 15px; margin-bottom: 24px; max-width: 440px; margin-left: auto; margin-right: auto; }
  .optin-card input {
    background: #0c0c0c; border: 1px solid #2a3a38; border-radius: 8px;
    padding: 14px 18px; font: inherit; font-size: 15px; color: #e0e0e0;
    width: 280px; max-width: 100%; margin-right: 8px; outline: none;
    vertical-align: middle;
  }
  .optin-card input:focus { border-color: #5cb8b2; }
  .optin-card button {
    background: #5cb8b2; color: #0c0c0c; border: none; padding: 14px 24px;
    border-radius: 8px; font: inherit; font-size: 15px; font-weight: 600;
    cursor: pointer; vertical-align: middle; margin-top: 8px;
  }

  /* Technical + footer */
  .hidden { display: none; }
  details { margin-top: 32px; }
  summary { color: #444; cursor: pointer; font-size: 14px; }
  summary:hover { color: #666; }
  pre {
    background: #111; padding: 16px; border-radius: 8px;
    font-size: 12px; color: #666; margin-top: 10px;
    overflow-x: auto; font-family: 'SF Mono', 'Fira Code', monospace;
    white-space: pre-wrap; line-height: 1.5;
  }
  a { color: #5cb8b2; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .footer { text-align: center; margin-top: 60px; font-size: 12px; color: #2a2a2a; }

  @media (max-width: 640px) {
    .flow { gap: 6px; }
    .flow-node { min-width: 80px; padding: 10px 12px; }
    .flow-name { font-size: 11px; }
    .flow-desc { font-size: 10px; }
  }
</style>
</head>
<body>
<div class="wrap">

  <!-- HERO -->
  <div class="hero">
    <h1>What if AI knew who you are &mdash; and got better every time?</h1>
    <p class="lead">Most AI gives the same answer to everyone. It doesn't know your situation, your constraints, or what you have to lose.</p>
    <p class="lead">This live demo shows an AI system that <strong>knows your identity</strong>, <strong>learns from its own mistakes</strong>, and gives fundamentally different advice to different people.</p>
  </div>

  <!-- BUTTON -->
  <div class="cta">
    <button class="btn" id="run-btn" onclick="runDemo()">Watch It Happen</button>
    <p class="btn-note">One protocol. Three live runs. ~45 seconds.</p>
  </div>

  <!-- HOW IT WORKS -->
  <div class="how">
    <h2>How it works</h2>
    <p>What you're about to see is a <strong>protocol</strong> &mdash; a defined sequence of steps that AI runs on its own. This one is called <em>decision_advisor</em>. Someone is facing a big life decision, and the protocol gives advice shaped by who they are.</p>
    <p>Every time it runs, it follows the same steps:</p>
    <div class="flow">
      <div class="flow-node"><div class="flow-name">search memory</div><div class="flow-desc">Find what it learned last time</div></div>
      <div class="flow-arrow">&rarr;</div>
      <div class="flow-node"><div class="flow-name">generate</div><div class="flow-desc">Give advice shaped by identity + memory</div></div>
      <div class="flow-arrow">&rarr;</div>
      <div class="flow-node"><div class="flow-name">validate</div><div class="flow-desc">Check the output</div></div>
      <div class="flow-arrow">&rarr;</div>
      <div class="flow-node"><div class="flow-name">remember</div><div class="flow-desc">Save advice + blind spots</div></div>
    </div>
    <div class="flow-loop">&larr; next run reads the blind spots and goes deeper &larr;</div>
    <p>The demo runs this protocol three times: first with empty memory, then again after it learns from itself, then with a completely different identity. Same situation, same protocol &mdash; different advice every time.</p>
  </div>

  <!-- DEMO PANEL (hidden until button click) -->
  <div class="demo-panel hidden" id="demo-panel">
    <div class="panel-head" id="panel-head">
      <span class="step" id="s0">Setup</span>
      <span class="step" id="s1">Run 1</span>
      <span class="step" id="s2">Run 2</span>
      <span class="step" id="s3">New Identity</span>
    </div>
    <div class="panel-ctx">
      <div class="ctx-row">
        <div class="ctx-label">Identity</div>
        <div class="ctx-text" id="ctx-identity">&mdash;</div>
      </div>
      <div class="ctx-row">
        <div class="ctx-label">Situation</div>
        <div class="ctx-text" id="ctx-input">&mdash;</div>
      </div>
    </div>
    <hr class="ctx-divider">
    <div class="panel-content" id="panel-content">
      <div class="thinking">
        <div class="dot-pulse"><span></span><span></span><span></span></div>
        <div class="thinking-label">Setting up...</div>
      </div>
    </div>
  </div>

  <!-- CONCLUSION (hidden until demo done) -->
  <div id="conclusion" class="conclusion hidden">
    <div class="insight-block">
      <p><strong>A new category is emerging.</strong> A new kind of AI system is appearing &mdash; <em>user-aligned autonomous agents</em>. Unlike chatbots (which wait for you to ask) or automation tools (which repeat forever), these systems run autonomously, learn over time, and align with the user's goals instead of the platform's.</p>
      <p><strong>Identity is the anchor.</strong> The protocol you just watched knows <em>who you are</em> &mdash; and uses that to get better every time it runs, without you doing anything.</p>
      <p><strong>Who does this system improve for?</strong> You. Your life situation, your constraints, your values shape every output. Change the identity, and the same protocol produces completely different advice.</p>
      <p><strong>Can it improve without your help?</strong> Yes. Each run identifies its own blind spots, saves them, and goes deeper next time. It compounds on its own &mdash; anchored to who you are. And <em>decision_advisor</em> is just one protocol. The same architecture works for any process you can define in steps.</p>
      <p style="color:#7ab8b0;">This is the gap between &ldquo;AI that answers questions&rdquo; and &ldquo;AI that actually works for you.&rdquo;</p>
    </div>
    <div class="optin-card">
      <h2>Want to build protocols like this?</h2>
      <p>Donna is an open-source protocol engine that gives AI memory, identity, and compounding intelligence. Get early access.</p>
      <div id="subscribe-form">
        <input type="email" id="email-input" placeholder="your@email.com">
        <button onclick="subscribe()">Get Early Access</button>
      </div>
      <div id="subscribe-done" class="hidden" style="color:#5cb8b2; font-size:15px; padding:14px 0;">You're in. We'll be in touch.</div>
      <p style="color:#333; font-size:12px; margin-top:12px;">No spam. Just product updates.</p>
    </div>
  </div>

  <!-- TECHNICAL (hidden until demo done) -->
  <div id="technical" class="hidden">
    <details>
      <summary>Under the hood: how this works</summary>
      <div style="padding: 16px 0;">
        <p style="color: #666; font-size: 14px; margin-bottom: 8px;">This demo runs on <strong style="color:#888;">Cloudflare Workers</strong> &mdash; edge computing infrastructure. The "protocol" is a JSON document describing 5 steps.</p>
        <p style="color: #666; font-size: 14px; margin-bottom: 16px;">16 composable primitives handle everything from LLM generation to semantic memory search. No custom code needed.</p>
        <pre id="proto-json"></pre>
        <p style="color: #444; font-size: 13px; margin-top: 16px;">Open source: <a href="https://github.com/jcdiv/donna-executor-template">github.com/jcdiv/donna-executor-template</a></p>
      </div>
    </details>
  </div>

  <div class="footer">
    Built with <a href="https://github.com/jcdiv/donna-executor-template">donna-executor-template</a>
  </div>

</div>

<script>
var IDENTITY_A = "I'm 28, single, software engineer. No debt, $40K in savings. I've always wanted to live somewhere new. My current city is fine but I feel stuck in a routine. I don't have kids or a mortgage tying me down.";
var IDENTITY_B = "I'm 42, married, two kids ages 8 and 12. We bought a house last year. My partner works locally and loves their job. Our parents live nearby and help with childcare. Stability matters to us.";
var INPUT_TEXT = "I just got a job offer from a company in another city. 40% more money, exciting role at a fast-growing startup. But I'd have to relocate across the country. My current job is stable and comfortable, but I've stopped growing. I need to decide by Friday.";

var demoRunning = false;
var demoComplete = false;
var stepContents = {};

function post(path, body) {
  return fetch(path, { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body) }).then(function(r) { return r.json(); });
}

function delay(ms) { return new Promise(function(res) { setTimeout(res, ms); }); }

function esc(s) {
  if (!s) return '';
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function setStep(n, state) {
  var el = document.getElementById('s' + n);
  if (el) el.className = 'step ' + state;
}

function setContent(html) {
  var el = document.getElementById('panel-content');
  el.style.opacity = '0';
  setTimeout(function() {
    el.innerHTML = html;
    el.style.opacity = '1';
  }, 250);
}

function thinkingHtml(label) {
  return '<div class="thinking"><div class="dot-pulse"><span></span><span></span><span></span></div><div class="thinking-label">' + label + '</div></div>';
}

function explainHtml(text) {
  return '<div class="stage-explain"><p>' + text + '</p></div>';
}

function showStepContent(n) {
  if (!demoComplete || !stepContents[n]) return;
  for (var i = 0; i < 4; i++) {
    var el = document.getElementById('s' + i);
    if (el) el.className = 'step review' + (i === n ? ' viewing' : ' done');
  }
  setContent(stepContents[n]);
}

function enableReview() {
  demoComplete = true;
  var head = document.getElementById('panel-head');
  var hint = document.createElement('span');
  hint.className = 'review-hint';
  hint.textContent = 'tap to review';
  head.appendChild(hint);
  for (var i = 0; i < 4; i++) {
    (function(idx) {
      var el = document.getElementById('s' + idx);
      if (el) {
        el.className = 'step review done';
        el.onclick = function() { showStepContent(idx); };
      }
    })(i);
  }
}

function runDemo() {
  if (demoRunning) return;
  demoRunning = true;
  demoComplete = false;
  stepContents = {};
  var btn = document.getElementById('run-btn');
  btn.disabled = true;
  btn.textContent = 'Running...';

  // Clean up from previous run
  var oldHint = document.querySelector('.review-hint');
  if (oldHint) oldHint.remove();
  for (var i = 0; i < 4; i++) {
    var el = document.getElementById('s' + i);
    if (el) { el.onclick = null; el.className = 'step'; }
  }

  // Show panel
  var panel = document.getElementById('demo-panel');
  panel.classList.remove('hidden');
  panel.classList.add('active');
  setContent(thinkingHtml('Clearing memory...'));
  setStep(0, 'active');

  setTimeout(function() {
    panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, 100);

  // SETUP
  post('/demo/run', { act: 'reset' }).then(function() {
    setContent(thinkingHtml('Storing identity...'));
    return post('/demo/run', { act: 'setup', identity: IDENTITY_A });
  }).then(function() {
    document.getElementById('ctx-identity').textContent = IDENTITY_A;
    document.getElementById('ctx-identity').className = 'ctx-text';
    document.getElementById('ctx-input').textContent = INPUT_TEXT;
    var h = '<p style="color:#5cb8b2; text-align:center; padding:24px 0;">Identity stored. Memory cleared. Ready to run.</p>';
    setContent(h);
    stepContents[0] = h;
    setStep(0, 'done');
    return delay(2000);

  // RUN 1 — explain, then call
  }).then(function() {
    setStep(1, 'active');
    setContent(explainHtml('The protocol searches memory for any prior advice on this situation. Since this is the first run, memory is empty &mdash; it gives its best advice based only on who this person is.'));
    return delay(3000);
  }).then(function() {
    setContent(thinkingHtml('Searching memory, generating advice...'));
    return post('/demo/run', { act: 'run', text: INPUT_TEXT, identity: IDENTITY_A });
  }).then(function(r1) {
    var o = r1.output || {};
    var h = '';
    h += '<div class="p-card output"><div class="p-label out">Advice</div><div class="p-text bright">' + esc(o.advice) + '</div></div>';
    h += '<div class="p-card eval"><div class="p-label crit">Blind spots</div><div class="p-text dim">' + esc(o.self_evaluation) + '</div></div>';
    h += '<div class="p-card next-time"><div class="p-label next">What it would reconsider</div><div class="p-text next-t">' + esc(o.what_id_reconsider) + '</div></div>';
    h += '<div class="mem-save"><span>&#8595; Saved to memory for next run</span></div>';
    h += '<div class="meta">' + (r1.success ? r1.duration_ms + 'ms' : 'failed') + '</div>';
    setContent(h);
    stepContents[1] = h;
    setStep(1, 'done');
    return delay(5000);

  // RUN 2 — explain, then call
  }).then(function() {
    setStep(2, 'active');
    setContent(explainHtml('Same situation, same person. But now memory contains Run 1\\'s blind spots. The system reads what it missed and goes deeper.'));
    return delay(3000);
  }).then(function() {
    setContent(thinkingHtml('Searching memory for Run 1 blind spots...'));
    return post('/demo/run', { act: 'run', text: INPUT_TEXT, identity: IDENTITY_A });
  }).then(function(r2) {
    var o = r2.output || {};
    var sim = r2.similarity ? ' | similarity: ' + r2.similarity.toFixed(2) : '';
    var h = '';
    h += '<div class="p-card found"><div class="p-label found-l">Found from Run 1</div><div class="p-text">' + esc(o.prior_run_considerations || 'No prior found') + '</div></div>';
    h += '<div class="p-card output"><div class="p-label out">Advice (deeper)</div><div class="p-text bright">' + esc(o.advice) + '</div></div>';
    h += '<p class="stage-note">It read its own blind spots and addressed them. The advice is more nuanced now. That\\'s compounding.</p>';
    h += '<div class="meta">' + (r2.success ? r2.duration_ms + 'ms' : 'failed') + sim + '</div>';
    setContent(h);
    stepContents[2] = h;
    setStep(2, 'done');
    return delay(5000);

  // IDENTITY SHIFT — explain, then call
  }).then(function() {
    setStep(3, 'active');
    setContent(explainHtml('Now we change who\\'s asking. Same job offer, same deadline &mdash; but a completely different person with a completely different life. Watch how identity reshapes the advice.'));
    return delay(2500);
  }).then(function() {
    var idEl = document.getElementById('ctx-identity');
    idEl.textContent = IDENTITY_B;
    idEl.className = 'ctx-text highlight';
    setContent(thinkingHtml('New identity stored. Generating advice...'));
    return post('/demo/run', { act: 'setup', identity: IDENTITY_B });
  }).then(function() {
    return post('/demo/run', { act: 'run', text: INPUT_TEXT, identity: IDENTITY_B });
  }).then(function(r3) {
    var o = r3.output || {};
    var h = '';
    h += '<div class="p-card output"><div class="p-label out">Advice (same situation, different person)</div><div class="p-text bright">' + esc(o.advice) + '</div></div>';
    h += '<p class="stage-note">Same job offer. Same deadline. Completely different advice &mdash; because it knows who\\'s asking.</p>';
    h += '<div class="meta">' + (r3.success ? r3.duration_ms + 'ms' : 'failed') + '</div>';
    setContent(h);
    stepContents[3] = h;
    setStep(3, 'done');
    return delay(3000);

  // DONE
  }).then(function() {
    enableReview();

    var concl = document.getElementById('conclusion');
    var tech = document.getElementById('technical');
    concl.classList.remove('hidden');
    tech.classList.remove('hidden');

    var proto = {
      protocol_key: 'decision_advisor',
      steps: [
        { step: 1, primitive: 'util.time', purpose: 'Timestamp the run' },
        { step: 2, primitive: 'memory.search', purpose: 'Find prior advice' },
        { step: 3, primitive: 'llm.generate', purpose: 'Advise using identity + memory' },
        { step: 4, primitive: 'validate.schema', purpose: 'Verify output structure' },
        { step: 5, primitive: 'memory.log', purpose: 'Save advice + blind spots' }
      ]
    };
    document.getElementById('proto-json').textContent = JSON.stringify(proto, null, 2);

    setTimeout(function() {
      concl.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 300);

    btn.disabled = false;
    btn.textContent = 'Run Again';
    demoRunning = false;
  }).catch(function(e) {
    btn.disabled = false;
    btn.textContent = 'Run Again';
    demoRunning = false;
    setContent('<p style="color:#e05555; text-align:center; padding:24px;">Error: ' + esc(e.message) + '</p>');
  });
}

function subscribe() {
  var input = document.getElementById('email-input');
  var email = (input.value || '').trim();
  if (!email || email.indexOf('@') === -1) { input.style.borderColor = '#e05555'; return; }
  input.style.borderColor = '#2a3a38';
  post('/demo/subscribe', { email: email }).then(function(r) {
    if (r.ok) {
      document.getElementById('subscribe-form').classList.add('hidden');
      document.getElementById('subscribe-done').classList.remove('hidden');
    }
  }).catch(function() {});
}
</script>
</body>
</html>
`;


// ===== MAIN WORKER =====

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };
    const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

    if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

    // ===== PUBLIC ENDPOINTS =====

    // GET /health
    if (url.pathname === '/health') {
      return json({ status: 'healthy', version: '1.0.0', primitives: Object.keys(PRIMITIVES), timestamp: new Date().toISOString() });
    }

    // GET /authoring-context
    if (url.pathname === '/authoring-context') {
      return json(buildAuthoringContext());
    }

    // GET /demo — Interactive demo page
    if (url.pathname === '/demo' && request.method === 'GET') {
      return new Response(DEMO_HTML, { headers: { ...corsHeaders, 'Content-Type': 'text/html; charset=utf-8' } });
    }

    // POST /demo/run — Execute demo acts (no auth, rate-limited)
    if (url.pathname === '/demo/run' && request.method === 'POST') {
      try {
        const body = await request.json().catch(() => ({}));
        const act = body.act || 'run';

        // Rate limit LLM calls (not reset/setup which are cheap)
        if (act === 'run') {
          const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
          const rlKey = `ratelimit:demo:${ip}`;
          const count = parseInt(await env.REGISTRY_KV.get(rlKey) || '0');
          if (count >= 15) {
            return json({ error: 'You have reached the demo limit. Sign up below to get notified when the full version launches.' }, 429);
          }
          await env.REGISTRY_KV.put(rlKey, String(count + 1), { expirationTtl: 3600 });
        }

        if (act === 'reset') {
          if (env.DB) await env.DB.prepare('DELETE FROM memories').run();
          return json({ ok: true, message: 'Memories cleared' });
        }

        if (act === 'setup') {
          const { identity } = body;
          if (!identity) return json({ error: 'identity required' }, 400);
          await env.REGISTRY_KV.put('config:identity', identity);
          return json({ ok: true, identity });
        }

        if (act === 'run') {
          const { text, identity } = body;
          if (!text) return json({ error: 'text required' }, 400);
          const protoRaw = await env.REGISTRY_KV.get('protocol:decision_advisor');
          if (!protoRaw) return json({ error: 'Demo protocol not found. Save decision-advisor.json first.' }, 404);
          const protocol = JSON.parse(protoRaw);
          const runId = 'demo-' + Date.now();
          const context = { text, protocol_key: 'decision_advisor' };
          if (identity) context.identity = identity;
          const result = await executeBatch(env, runId, protocol.steps, context);
          const llmOut = result.execution_results?.[2]?.result?.data;
          let parsed = llmOut;
          if (typeof llmOut === 'string') { try { parsed = JSON.parse(llmOut); } catch { parsed = llmOut; } }
          const memStep = result.execution_results?.[1]?.result?.data;
          const similarity = memStep?.[0]?.similarity || null;
          return json({ success: result.success, duration_ms: result.duration_ms, output: parsed, similarity });
        }

        return json({ error: 'Unknown act: ' + act + '. Use reset, setup, or run.' }, 400);
      } catch (error) {
        return json({ error: error.message }, 500);
      }
    }

    // POST /demo/subscribe — Email opt-in (no auth)
    if (url.pathname === '/demo/subscribe' && request.method === 'POST') {
      try {
        const body = await request.json().catch(() => ({}));
        const email = (body.email || '').toLowerCase().trim();
        if (!email || !email.includes('@') || !email.includes('.')) {
          return json({ error: 'Valid email required' }, 400);
        }
        if (env.DB) {
          const id = 'lead-' + Date.now() + '-' + Math.random().toString(36).substring(2, 6);
          const ip = request.headers.get('CF-Connecting-IP') || null;
          await env.DB.prepare(
            'INSERT OR IGNORE INTO leads (id, email, source, ip, created_at) VALUES (?, ?, ?, ?, ?)'
          ).bind(id, email, 'demo', ip, new Date().toISOString()).run();
        }
        return json({ ok: true });
      } catch (error) {
        return json({ error: error.message }, 500);
      }
    }

    // ===== AUTHENTICATED ENDPOINTS =====

    // PUT /identity — Store identity (persists in KV)
    if (url.pathname === '/identity' && request.method === 'PUT') {
      const authErr = requireAuth(request, env); if (authErr) return authErr;
      try {
        const body = await request.json();
        const { identity } = body;
        if (!identity || typeof identity !== 'string') return json({ error: 'identity string required' }, 400);
        await env.REGISTRY_KV.put('config:identity', identity);
        return json({ ok: true, identity, message: 'Identity stored' });
      } catch (error) {
        return json({ error: error.message }, 500);
      }
    }

    // GET /identity — Retrieve stored identity
    if (url.pathname === '/identity' && request.method === 'GET') {
      const authErr = requireAuth(request, env); if (authErr) return authErr;
      const identity = await env.REGISTRY_KV.get('config:identity');
      if (!identity) return json({ identity: null, message: 'No identity set. PUT /identity to store one.' });
      return json({ identity });
    }

    // POST /run — Execute protocol by key from KV
    if (url.pathname === '/run' && request.method === 'POST') {
      const authErr = requireAuth(request, env); if (authErr) return authErr;
      try {
        const body = await request.json();
        const { protocol_key, context = {} } = body;
        if (!protocol_key) return json({ error: 'protocol_key required' }, 400);

        // Auto-inject stored identity if not provided in context
        if (!context.identity) {
          const storedIdentity = await env.REGISTRY_KV.get('config:identity');
          if (storedIdentity) context.identity = storedIdentity;
        }

        const protoRaw = await env.REGISTRY_KV.get(`protocol:${protocol_key}`);
        if (!protoRaw) return json({ error: `Protocol '${protocol_key}' not found` }, 404);

        const protocol = JSON.parse(protoRaw);
        const runId = `run-${protocol_key}-${Date.now()}`;
        const result = await executeBatch(env, runId, protocol.steps, { ...context, protocol_key });
        return json(result);
      } catch (error) {
        return json({ error: error.message }, 500);
      }
    }

    // POST /exec — Execute single primitive
    if (url.pathname === '/exec' && request.method === 'POST') {
      const authErr = requireAuth(request, env); if (authErr) return authErr;
      try {
        const body = await request.json();
        const { primitive, args = {}, run_id } = body;
        if (!primitive) return json({ error: 'primitive required' }, 400);
        if (!validateRunId(run_id)) return json({ error: 'run_id required' }, 400);
        if (!PRIMITIVES[primitive]) return json({ error: `Unknown primitive: ${primitive}`, available: Object.keys(PRIMITIVES) }, 400);

        const startTime = Date.now();
        const result = await PRIMITIVES[primitive](env, args, run_id);
        return json({ success: true, primitive, run_id, execution_time_ms: Date.now() - startTime, result, timestamp: new Date().toISOString() });
      } catch (error) {
        return json({ success: false, error: error.message }, 500);
      }
    }

    // POST /batch — Execute raw steps array
    if (url.pathname === '/batch' && request.method === 'POST') {
      const authErr = requireAuth(request, env); if (authErr) return authErr;
      try {
        const body = await request.json();
        const { run_id, steps, context = {} } = body;
        const result = await executeBatch(env, run_id, steps, context);
        return json(result);
      } catch (error) {
        return json({ success: false, error: error.message }, 500);
      }
    }

    // ===== REGISTRY CRUD =====

    // POST /registry — Upsert single entry
    if (url.pathname === '/registry' && request.method === 'POST') {
      const authErr = requireAuth(request, env); if (authErr) return authErr;
      try {
        const entry = await request.json();
        if (!entry.op_key) return json({ error: 'op_key required' }, 400);
        if (!entry.status) entry.status = 'active';
        await env.REGISTRY_KV.put(`registry:${entry.op_key}`, JSON.stringify(entry));
        return json({ ok: true, op_key: entry.op_key, message: 'Registry entry saved' });
      } catch (error) {
        return json({ error: error.message }, 500);
      }
    }

    // POST /registry/import — Bulk import entries
    if (url.pathname === '/registry/import' && request.method === 'POST') {
      const authErr = requireAuth(request, env); if (authErr) return authErr;
      try {
        const body = await request.json();
        const entries = body.entries || body;
        if (!Array.isArray(entries)) return json({ error: 'Expected array of entries' }, 400);

        let imported = 0;
        for (const entry of entries) {
          if (!entry.op_key) continue;
          if (!entry.status) entry.status = 'active';
          await env.REGISTRY_KV.put(`registry:${entry.op_key}`, JSON.stringify(entry));
          imported++;
        }
        return json({ ok: true, imported, total: entries.length });
      } catch (error) {
        return json({ error: error.message }, 500);
      }
    }

    // GET /registry — List all entries
    if (url.pathname === '/registry' && request.method === 'GET') {
      const authErr = requireAuth(request, env); if (authErr) return authErr;
      try {
        const list = await env.REGISTRY_KV.list({ prefix: 'registry:' });
        const entries = [];
        for (const key of list.keys) {
          const raw = await env.REGISTRY_KV.get(key.name);
          if (raw) entries.push(JSON.parse(raw));
        }
        return json({ entries, count: entries.length });
      } catch (error) {
        return json({ error: error.message }, 500);
      }
    }

    // GET /registry/:op_key
    if (url.pathname.startsWith('/registry/') && request.method === 'GET' && url.pathname !== '/registry/import') {
      const authErr = requireAuth(request, env); if (authErr) return authErr;
      const op_key = url.pathname.replace('/registry/', '');
      const raw = await env.REGISTRY_KV.get(`registry:${op_key}`);
      if (!raw) return json({ error: `Entry '${op_key}' not found` }, 404);
      return json(JSON.parse(raw));
    }

    // ===== PROTOCOL CRUD =====

    // POST /protocols — Save protocol
    if (url.pathname === '/protocols' && request.method === 'POST') {
      const authErr = requireAuth(request, env); if (authErr) return authErr;
      try {
        const protocol = await request.json();
        if (!protocol.protocol_key) return json({ error: 'protocol_key required' }, 400);
        if (!protocol.steps || !Array.isArray(protocol.steps)) return json({ error: 'steps array required' }, 400);

        const validation = validateBatchSteps(protocol.steps, env);
        if (!validation.valid) return json({ error: `Validation failed: ${validation.error}` }, 400);

        await env.REGISTRY_KV.put(`protocol:${protocol.protocol_key}`, JSON.stringify(protocol));
        return json({ ok: true, protocol_key: protocol.protocol_key, step_count: protocol.steps.length, message: 'Protocol saved' });
      } catch (error) {
        return json({ error: error.message }, 500);
      }
    }

    // GET /protocols — List all protocols
    if (url.pathname === '/protocols' && request.method === 'GET') {
      const authErr = requireAuth(request, env); if (authErr) return authErr;
      try {
        const list = await env.REGISTRY_KV.list({ prefix: 'protocol:' });
        const protocols = [];
        for (const key of list.keys) {
          const raw = await env.REGISTRY_KV.get(key.name);
          if (raw) {
            const p = JSON.parse(raw);
            protocols.push({ protocol_key: p.protocol_key, name: p.name, step_count: p.steps?.length || 0 });
          }
        }
        return json({ protocols, count: protocols.length });
      } catch (error) {
        return json({ error: error.message }, 500);
      }
    }

    // GET /protocols/:key
    if (url.pathname.startsWith('/protocols/') && request.method === 'GET') {
      const authErr = requireAuth(request, env); if (authErr) return authErr;
      const key = url.pathname.replace('/protocols/', '');
      const raw = await env.REGISTRY_KV.get(`protocol:${key}`);
      if (!raw) return json({ error: `Protocol '${key}' not found` }, 404);
      return json(JSON.parse(raw));
    }

    // ===== EXECUTIONS LOG =====

    // GET /executions — Recent execution logs
    if (url.pathname === '/executions' && request.method === 'GET') {
      const authErr = requireAuth(request, env); if (authErr) return authErr;
      try {
        const limit = parseInt(url.searchParams.get('limit') || '50');
        const protocol_key = url.searchParams.get('protocol_key');
        let query = 'SELECT * FROM executions';
        const bindings = [];
        if (protocol_key) {
          query += ' WHERE protocol_key = ?';
          bindings.push(protocol_key);
        }
        query += ' ORDER BY started_at DESC LIMIT ?';
        bindings.push(Math.min(limit, 500));

        const result = await env.DB.prepare(query).bind(...bindings).all();
        return json({ executions: result.results, count: result.results.length });
      } catch (error) {
        return json({ error: error.message }, 500);
      }
    }

    // ===== BUDGET =====

    // GET /budget — Current daily LLM spend and limits
    if (url.pathname === '/budget' && request.method === 'GET') {
      const authErr = requireAuth(request, env); if (authErr) return authErr;
      try {
        const dailySpend = await getDailyLLMSpend(env);
        const budgetRaw = await env.REGISTRY_KV?.get('config:daily_budget_usd');
        const budget = budgetRaw ? parseFloat(budgetRaw) : DEFAULT_DAILY_LLM_BUDGET_USD;
        const llmCapRaw = await env.REGISTRY_KV?.get('config:max_llm_calls_per_run');
        const maxCalls = llmCapRaw ? parseInt(llmCapRaw) : MAX_LLM_CALLS_PER_RUN;
        const today = new Date().toISOString().slice(0, 10);
        const breakdown = await env.DB.prepare(
          'SELECT model, COUNT(*) as calls, SUM(input_tokens) as input_tokens, SUM(output_tokens) as output_tokens, ROUND(SUM(estimated_cost_usd), 6) as cost_usd FROM llm_usage WHERE created_at >= ? GROUP BY model'
        ).bind(`${today}T00:00:00.000Z`).all();
        return json({
          daily_budget_usd: budget,
          daily_spend_usd: Math.round(dailySpend * 1000000) / 1000000,
          remaining_usd: Math.round(Math.max(0, budget - dailySpend) * 1000000) / 1000000,
          budget_exceeded: dailySpend >= budget,
          max_llm_calls_per_run: maxCalls,
          foreach_hard_cap: MAX_FOREACH_ITERATIONS_HARD_CAP,
          today,
          breakdown: breakdown.results
        });
      } catch (error) {
        return json({ error: error.message }, 500);
      }
    }

    // 404
    return json({
      error: 'Not found',
      endpoints: ['/health', '/authoring-context', '/run', '/exec', '/batch', '/registry', '/registry/import', '/protocols', '/executions', '/budget']
    }, 404);
  },

  // ===== CRON HANDLER =====
  async scheduled(event, env, ctx) {
    const raw = await env.REGISTRY_KV.get('config:cron');
    if (!raw) return;
    const protocolKeys = JSON.parse(raw);
    for (const key of protocolKeys) {
      const protoRaw = await env.REGISTRY_KV.get(`protocol:${key}`);
      if (!protoRaw) continue;
      const protocol = JSON.parse(protoRaw);
      const runId = `sched-${key}-${Date.now()}`;
      ctx.waitUntil(executeBatch(env, runId, protocol.steps, { protocol_key: key }));
    }
  }
};
