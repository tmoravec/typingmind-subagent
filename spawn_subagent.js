// TypingMind plugin function: spawn_subagent v0.1
// Stateless proxy to an OpenAI-compatible /chat/completions endpoint.
// Everything lives inside the function so the sandbox only needs the one top-level name.
async function spawn_subagent(params, userSettings) {
  const PROTOCOL = [
    'You are answering a single request from another AI system. You have no tools,',
    'no memory of other requests, and no way to ask questions. Work only from the',
    'material below and return only the deliverable.',
    '',
    'Begin every reply with this header, then a line containing only three dashes,',
    'then the deliverable:',
    '',
    'TYPE: <answer|document|data|code|questions>',
    'TITLE: <short title; documents only, omit otherwise>',
    '---',
    '<deliverable>',
    '',
    'answer    – prose answering the question',
    'document  – a structured text work (report, specification, plan, letter)',
    'data      – machine-readable output (JSON, CSV, YAML)',
    'code      – source code or a config snippet',
    'questions – you cannot start because something you need is missing; then the',
    '            deliverable is your questions, nothing else',
    '',
    'No commentary, no apologies, no offers to help. If you must assume something,',
    'state the assumption in one line at the top of the deliverable.',
  ].join('\n');

  const TASK_MAX = 2000;
  const CONTEXT_MAX = 32000;
  const CONTEXT_HARD_MAX = 64000;
  const OUTPUT_FORMAT_MAX = 1000;
  const HEADER_SCAN_LINES = 8;
  const KIND_MAX = 24;
  const BODY_SNIPPET = 200;

  // ---- Settings ----------------------------------------------------------

  const s = userSettings || {};
  const setting = (name, fallback) => {
    const v = s[name];
    return v === undefined || v === null ? fallback : String(v);
  };
  const notConfigured = (field) =>
    new Error(`Subagent is not configured: set ${field} in the plugin settings.`);
  const misconfigured = (field, problem) =>
    new Error(`Subagent is misconfigured: ${field} ${problem}. Fix it in the plugin settings.`);

  const baseUrl = setting('base_url', '').trim();
  const model = setting('model', '').trim();
  const apiKey = setting('api_key', '').trim();

  if (!baseUrl) throw notConfigured('base_url');
  if (!model) throw notConfigured('model');
  if (!apiKey) throw notConfigured('api_key');

  const numberSetting = (name, fallback, isInt, min) => {
    const raw = setting(name, '').trim();
    if (raw === '') return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < min || (isInt && !Number.isInteger(n))) {
      throw misconfigured(name, `must be ${isInt ? 'an integer' : 'a number'} ≥ ${min} (got "${raw}")`);
    }
    return n;
  };
  const temperature = numberSetting('temperature', 0.2, false, 0);
  const maxTokens = numberSetting('max_tokens', 64000, true, 1);
  const timeoutMs = numberSetting('timeout_ms', 60000, true, 1);

  // OpenRouter provider routing, sent verbatim as the request's `provider` field.
  let provider;
  const providerRaw = setting('provider', '').trim();
  if (providerRaw) {
    try {
      provider = JSON.parse(providerRaw);
    } catch (e) {
      throw misconfigured('provider', 'is not valid JSON');
    }
    if (!provider || typeof provider !== 'object' || Array.isArray(provider)) {
      throw misconfigured('provider', 'must be a JSON object, e.g. {"order": ["novita/fp8"], "allow_fallbacks": false}');
    }
  }

  let endpoint = baseUrl.replace(/\/+$/, '');
  if (!/\/chat\/completions$/.test(endpoint)) endpoint += '/chat/completions';
  let host;
  try {
    host = new URL(endpoint).host;
  } catch (e) {
    throw misconfigured('base_url', `is not a valid URL ("${baseUrl}")`);
  }

  // ---- Parameters --------------------------------------------------------

  const p = params || {};
  const checkField = (name, value, required, limit, hint) => {
    if (value === undefined || value === null) value = '';
    if (typeof value !== 'string') throw new Error(`Invalid ${name}: must be a string.`);
    if (required && !value.trim()) throw new Error(`Invalid ${name}: must not be empty.`);
    if (value.length > limit) {
      throw new Error(`Invalid ${name}: ${value.length} chars exceeds the limit of ${limit}.${hint || ''}`);
    }
    return value;
  };
  const task = checkField('task', p.task, true, TASK_MAX);
  // CONTEXT_MAX is the advertised size; only CONTEXT_HARD_MAX is enforced.
  const context = checkField('context', p.context, true, CONTEXT_HARD_MAX,
    ` Keep context under ${CONTEXT_MAX} chars: trim it or split the task.`);
  const outputFormat = checkField('output_format', p.output_format, false, OUTPUT_FORMAT_MAX);

  // ---- Request -----------------------------------------------------------

  const messages = [
    { role: 'system', content: PROTOCOL },
    {
      role: 'user',
      content: [
        'TASK', task, '',
        'CONTEXT', context, '',
        'OUTPUT FORMAT', outputFormat.trim() || 'Plain prose, concise.',
      ].join('\n'),
    },
  ];
  const body = { model, messages, temperature, max_tokens: maxTokens };
  if (provider) body.provider = provider;

  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const timedOut = () => new Error(`Subagent timed out after ${timeoutMs} ms.`);
  const networkError = () => new Error(
    `Network error reaching ${host}. In the personal version the provider must allow CORS ` +
    'from the sandbox; otherwise route through a proxy.');

  const started = Date.now();
  let res;
  let raw;
  try {
    try {
      res = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      raw = await res.text();
    } catch (e) {
      throw controller.signal.aborted ? timedOut() : networkError();
    }
  } finally {
    clearTimeout(timer);
  }

  const snippet = raw.slice(0, BODY_SNIPPET).replace(/\s+/g, ' ').trim();
  if (res.status === 401 || res.status === 403) {
    throw new Error(`Auth rejected (${res.status}). Check api_key in the plugin settings.`);
  }
  if (res.status === 429 || res.status >= 500) {
    throw new Error(`${res.status} from ${host}. Retry, or delegate a smaller task.${snippet ? ' ' + snippet : ''}`);
  }
  if (!res.ok) {
    throw new Error(`${res.status} from ${host}: the provider rejected the request.${snippet ? ' ' + snippet : ''}`);
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    throw new Error(`Provider returned a non-JSON response from ${host} (model ${model}).${snippet ? ' ' + snippet : ''}`);
  }

  // ---- Response ----------------------------------------------------------

  const choice = data && Array.isArray(data.choices) ? data.choices[0] : undefined;
  const truncated = !!choice && choice.finish_reason === 'length';
  // Only message.content is read, so separate reasoning fields (reasoning,
  // reasoning_content, reasoning_details) never reach the parent.
  let content = choice && choice.message ? choice.message.content : undefined;
  if (Array.isArray(content)) {
    // Keep text parts only; drop thinking/reasoning parts.
    content = content
      .map((part) => (typeof part === 'string' ? part
        : part && (part.type === undefined || part.type === 'text') ? part.text || '' : ''))
      .join('');
  }
  if (typeof content === 'string') {
    // Some providers inline reasoning in content as a leading <think> block.
    let stripped = content;
    for (;;) {
      const open = /^\s*<(think|thinking)>/i.exec(stripped);
      if (!open) break;
      const close = new RegExp(`</${open[1]}>`, 'i').exec(stripped);
      // Unclosed block: the worker ran out of tokens while still reasoning.
      stripped = close ? stripped.slice(close.index + close[0].length) : '';
    }
    // Orphan </think>: the opening tag was in the chat template, so everything before it is reasoning.
    if (stripped === content) {
      const close = /<\/think>/i.exec(content);
      if (close && !/<think>/i.test(content.slice(0, close.index))) stripped = content.slice(close.index + close[0].length);
    }
    if (stripped !== content) content = stripped.replace(/^\s+/, '');
  }
  if (typeof content !== 'string' || !content.trim()) {
    let detail = '';
    if (truncated) detail = ` It stopped at max_tokens (${maxTokens}) before writing any output (reasoning counts towards it); raise max_tokens.`;
    else if (data && data.error) detail = ` ${String(data.error.message || JSON.stringify(data.error)).slice(0, BODY_SNIPPET)}`;
    throw new Error(`Provider returned no completion (model ${model}).${detail}`);
  }

  // Header parse. The header is a hint: anything unexpected means plain answer.
  let kind = 'answer';
  let title;
  let text = content;
  const lines = content.split('\n');
  const fields = {};
  for (let i = 0; i < Math.min(lines.length, HEADER_SCAN_LINES); i++) {
    const line = lines[i].trim();
    if (!line) continue;
    if (line === '---') {
      if (fields.type !== undefined) {
        kind = fields.type.toLowerCase().slice(0, KIND_MAX) || 'answer';
        if (fields.title) title = fields.title;
        text = lines.slice(i + 1).join('\n').replace(/^(?:[ \t]*\r?\n)+/, '').trimEnd();
      }
      break;
    }
    const m = /^([A-Za-z_]+)\s*:\s*(.*)$/.exec(line);
    if (!m) break;
    const key = m[1].toLowerCase();
    if (!(key in fields)) fields[key] = m[2].trim();
  }

  if (!text.trim()) {
    throw new Error(truncated
      ? `Worker hit max_tokens (${maxTokens}) before writing the deliverable. Ask for a shorter deliverable or raise max_tokens.`
      : `Worker returned a header with no deliverable (model ${model}).`);
  }

  const envelope = { status: 'ok', kind };
  if (title) envelope.title = title;
  envelope.text = text;
  envelope.model = data && typeof data.model === 'string' && data.model ? data.model : model;
  const u = data && data.usage;
  if (u && Number.isFinite(u.prompt_tokens) && Number.isFinite(u.completion_tokens)) {
    envelope.usage = {
      prompt_tokens: u.prompt_tokens,
      completion_tokens: u.completion_tokens,
      total_tokens: Number.isFinite(u.total_tokens) ? u.total_tokens : u.prompt_tokens + u.completion_tokens,
    };
  }
  envelope.elapsed_ms = Date.now() - started;
  if (truncated) envelope.truncated = true;
  return envelope;
}
