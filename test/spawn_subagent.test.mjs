// Runs the plugin code the way TypingMind does (a script defining spawn_subagent)
// against a local HTTP server that impersonates an OpenAI-compatible provider.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(join(root, 'spawn_subagent.js'), 'utf8');
const spawn = new Function(`${source}\nreturn spawn_subagent;`)();

let server;
let baseUrl;
let handler;
let lastRequest;

before(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      lastRequest = { method: req.method, url: req.url, headers: req.headers, body: body ? JSON.parse(body) : null };
      handler(req, res, lastRequest);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
});
after(() => { server.closeAllConnections(); server.close(); });
beforeEach(() => {
  lastRequest = undefined;
  handler = () => { throw new Error('handler not set'); };
});

const settings = (over = {}) => ({
  base_url: baseUrl,
  api_key: 'sk-test',
  model: 'worker-1',
  ...over,
});
const params = (over = {}) => ({ task: 'Summarise the text.', context: 'Some text.', ...over });

const reply = (content, { finish = 'stop', usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }, model = 'worker-1-0425' } = {}) =>
  (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: 'x', model, usage,
      choices: [{ index: 0, finish_reason: finish, message: { role: 'assistant', content } }],
    }));
  };
const status = (code, body) => (req, res) => { res.writeHead(code); res.end(body); };

// ---- PRD §8 acceptance tests -------------------------------------------

test('A1: TYPE answer -> kind answer, header stripped, usage and elapsed_ms present', async () => {
  handler = reply('TYPE: answer\n---\nParis is the capital.');
  const out = await spawn(params(), settings());
  assert.equal(out.status, 'ok');
  assert.equal(out.kind, 'answer');
  assert.equal(out.text, 'Paris is the capital.');
  assert.deepEqual(out.usage, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
  assert.equal(typeof out.elapsed_ms, 'number');
  assert.equal(out.model, 'worker-1-0425');
  assert.equal('truncated' in out, false);
  assert.equal('title' in out, false);
});

test('A2: document with TITLE and a later --- line keeps body intact', async () => {
  const body = '# Risks\n\n| id | risk |\n---\nSecond section\n---\nThird';
  handler = reply(`TYPE: document\nTITLE: Risk register\n---\n${body}`);
  const out = await spawn(params(), settings());
  assert.equal(out.kind, 'document');
  assert.equal(out.title, 'Risk register');
  assert.equal(out.text, body);
});

test('A3: bare prose -> kind answer, text equals raw response, one request only', async () => {
  let calls = 0;
  const raw = 'The answer is 42.\nNo header here.\n---\nstill prose';
  const inner = reply(raw);
  handler = (req, res) => { calls++; inner(req, res); };
  const out = await spawn(params(), settings());
  assert.equal(out.kind, 'answer');
  assert.equal(out.text, raw);
  assert.equal(calls, 1);
});

test('A4: TYPE questions -> status ok, kind questions', async () => {
  handler = reply('TYPE: questions\n---\n1. Which fiscal year?');
  const out = await spawn(params(), settings());
  assert.equal(out.status, 'ok');
  assert.equal(out.kind, 'questions');
  assert.equal(out.text, '1. Which fiscal year?');
});

test('A5: invented label passes through lower-cased', async () => {
  handler = reply('TYPE: Spreadsheet\n---\na,b\n1,2');
  const out = await spawn(params(), settings());
  assert.equal(out.kind, 'spreadsheet');
});

test('A6: finish_reason length -> truncated true with partial text, no throw', async () => {
  handler = reply('TYPE: answer\n---\nThe first part of a long', { finish: 'length' });
  const out = await spawn(params(), settings({ max_tokens: '20' }));
  assert.equal(out.truncated, true);
  assert.equal(out.text, 'The first part of a long');
  assert.equal(lastRequest.body.max_tokens, 20);
});

test('A7: 401 names api_key', async () => {
  handler = status(401, '{"error":"bad key"}');
  await assert.rejects(spawn(params(), settings()),
    { message: 'Auth rejected (401). Check api_key (and proxy_password if you use a proxy) in the plugin settings.' });
});

// ---- Request assembly ----------------------------------------------------

test('request: proxy_password is sent as X-Proxy-Password', async () => {
  handler = reply('TYPE: answer\n---\nok');
  await spawn(params(), settings({ proxy_password: 'hunter2' }));
  assert.equal(lastRequest.headers['x-proxy-password'], 'hunter2');
  assert.equal(lastRequest.headers.authorization, 'Bearer sk-test');
});

test('request: endpoint, headers, body shape and messages', async () => {
  handler = reply('TYPE: answer\n---\nok');
  await spawn(
    params({ output_format: 'JSON object', task_description: 'Summarising' }),
    settings(),
  );
  assert.equal(lastRequest.method, 'POST');
  assert.equal(lastRequest.url, '/v1/chat/completions');
  assert.equal(lastRequest.headers.authorization, 'Bearer sk-test');
  assert.equal(lastRequest.headers['content-type'], 'application/json');
  assert.equal(lastRequest.headers['x-proxy-password'], undefined);
  const b = lastRequest.body;
  assert.deepEqual(Object.keys(b).sort(), ['max_tokens', 'messages', 'model']);
  assert.equal(b.model, 'worker-1');
  assert.equal(b.max_tokens, 64000);
  assert.equal(b.messages.length, 2);
  assert.equal(b.messages[0].role, 'system');
  assert.match(b.messages[0].content, /^You are answering a single request from another AI system\./);
  assert.match(b.messages[0].content, /state the assumption in one line at the top of the deliverable\.$/);
  assert.equal(b.messages[1].role, 'user');
  assert.equal(b.messages[1].content, 'TASK\nSummarise the text.\n\nCONTEXT\nSome text.\n\nOUTPUT FORMAT\nJSON object');
  assert.doesNotMatch(JSON.stringify(b), /Summarising/);
});

test('request: reasoning_effort is sent as reasoning.effort, validated, omitted when empty', async () => {
  handler = reply('ok');
  await spawn(params(), settings({ reasoning_effort: ' High ' }));
  assert.deepEqual(lastRequest.body.reasoning, { effort: 'high' });
  await spawn(params(), settings());
  assert.equal('reasoning' in lastRequest.body, false);
  await spawn(params(), settings({ reasoning_effort: 'default' }));
  assert.equal('reasoning' in lastRequest.body, false);
  await assert.rejects(spawn(params(), settings({ reasoning_effort: 'max' })), /reasoning_effort must be one of/);
});

test('request: default output format, base_url already ending in /chat/completions', async () => {
  handler = reply('ok');
  await spawn(params(), settings({ base_url: `${baseUrl}/chat/completions/` }));
  assert.equal(lastRequest.url, '/v1/chat/completions');
  assert.match(lastRequest.body.messages[1].content, /OUTPUT FORMAT\nPlain prose, concise\.$/);
});

test('request: numeric settings parsed from text', async () => {
  handler = reply('ok');
  await spawn(params(), settings({ temperature: '0.7', max_tokens: '512' }));
  assert.equal(lastRequest.body.temperature, 0.7);
  assert.equal(lastRequest.body.max_tokens, 512);
  await spawn(params(), settings({ temperature: '0' }));
  assert.equal(lastRequest.body.temperature, 0);
  await spawn(params(), settings({ temperature: '  ' }));
  assert.equal('temperature' in lastRequest.body, false);
});

test('request: OpenRouter provider routing sent verbatim when set', async () => {
  handler = reply('ok');
  const provider = { order: ['novita/fp8'], allow_fallbacks: false };
  await spawn(params(), settings({ provider: JSON.stringify(provider) }));
  assert.deepEqual(lastRequest.body.provider, provider);
  await spawn(params(), settings({ provider: '  ' }));
  assert.equal('provider' in lastRequest.body, false);
});

// ---- Reasoning is never returned -----------------------------------------

const replyMessage = (message, finish = 'stop') => (req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ model: 'm', choices: [{ finish_reason: finish, message: { role: 'assistant', ...message } }] }));
};

test('reasoning: separate reasoning fields are ignored', async () => {
  handler = replyMessage({
    content: 'TYPE: answer\n---\nFinal.',
    reasoning: 'SECRET chain of thought',
    reasoning_content: 'SECRET chain of thought',
    reasoning_details: [{ type: 'reasoning.text', text: 'SECRET' }],
  });
  const out = await spawn(params(), settings());
  assert.equal(out.text, 'Final.');
  assert.doesNotMatch(JSON.stringify(out), /SECRET/);
});

test('reasoning: leading <think> block in content is stripped before header parse', async () => {
  handler = reply('<think>\nSECRET step 1\nstep 2\n</think>\n\nTYPE: data\n---\n{"a":1}');
  const out = await spawn(params(), settings());
  assert.equal(out.kind, 'data');
  assert.equal(out.text, '{"a":1}');
});

test('reasoning: orphan </think> (opening tag in chat template) is stripped', async () => {
  handler = reply('SECRET thinking here\n</think>\nTYPE: answer\n---\nDone.');
  const out = await spawn(params(), settings());
  assert.equal(out.kind, 'answer');
  assert.equal(out.text, 'Done.');
});

test('reasoning: <think> later in the deliverable is left alone', async () => {
  const raw = 'TYPE: code\n---\nconst tag = "<think>x</think>";';
  handler = reply(raw);
  const out = await spawn(params(), settings());
  assert.equal(out.text, 'const tag = "<think>x</think>";');
});

test('reasoning: thinking parts in array content are dropped', async () => {
  handler = reply([
    { type: 'thinking', thinking: 'SECRET', text: 'SECRET' },
    { type: 'text', text: 'TYPE: answer\n---\nVisible.' },
  ]);
  const out = await spawn(params(), settings());
  assert.equal(out.text, 'Visible.');
});

test('reasoning: cut off mid-reasoning throws with max_tokens hint', async () => {
  handler = reply('<think>\nSECRET still thinking about', { finish: 'length' });
  await assert.rejects(spawn(params(), settings()), (e) =>
    /no completion.*reasoning counts towards it.*raise max_tokens/.test(e.message) && !/SECRET/.test(e.message));
});

// ---- Parser edge cases ---------------------------------------------------

test('parser: CRLF, blank lines before header, kind trimmed to 24 chars', async () => {
  handler = reply('\r\n\r\nTYPE: ' + 'x'.repeat(40) + '\r\n---\r\nbody');
  const out = await spawn(params(), settings());
  assert.equal(out.kind, 'x'.repeat(24));
  assert.equal(out.text, 'body');
});

test('parser: terminator beyond 8 lines -> no header', async () => {
  const raw = 'TYPE: answer\n' + 'a: b\n'.repeat(8) + '---\nbody';
  handler = reply(raw);
  const out = await spawn(params(), settings());
  assert.equal(out.kind, 'answer');
  assert.equal(out.text, raw);
});

test('parser: leading YAML --- without TYPE is not a header', async () => {
  const raw = '---\nname: x\nvalue: 1\n';
  handler = reply(raw);
  const out = await spawn(params(), settings());
  assert.equal(out.kind, 'answer');
  assert.equal(out.text, raw);
});

test('parser: header with empty deliverable throws', async () => {
  handler = reply('TYPE: answer\n---\n   \n');
  await assert.rejects(spawn(params(), settings()), /no deliverable/);
});

test('response: content as array of parts is joined', async () => {
  handler = reply([{ type: 'text', text: 'TYPE: code\n---\n' }, { type: 'text', text: 'print(1)' }]);
  const out = await spawn(params(), settings());
  assert.equal(out.kind, 'code');
  assert.equal(out.text, 'print(1)');
});

test('response: missing usage omits the field; model falls back to config', async () => {
  handler = (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'hi' } }] }));
  };
  const out = await spawn(params(), settings());
  assert.equal('usage' in out, false);
  assert.equal(out.model, 'worker-1');
});

// ---- Errors --------------------------------------------------------------

test('error: empty choices / content', async () => {
  handler = status(200, JSON.stringify({ choices: [] }));
  await assert.rejects(spawn(params(), settings()), /^Error: Provider returned no completion \(model worker-1\)\.$/);
  handler = reply('');
  await assert.rejects(spawn(params(), settings()), /Provider returned no completion \(model worker-1\)/);
  handler = reply(null, { finish: 'length' });
  await assert.rejects(spawn(params(), settings()), /no completion.*raise max_tokens/);
});

test('error: 403 is auth rejected', async () => {
  handler = status(403, 'forbidden');
  await assert.rejects(spawn(params(), settings()), /^Error: Auth rejected \(403\)/);
});

test('error: 429 and 5xx name status and host, append first 200 chars of body', async () => {
  handler = status(429, 'R'.repeat(500));
  await assert.rejects(spawn(params(), settings()), (e) => {
    const host = new URL(baseUrl).host;
    return e.message.startsWith(`429 from ${host}. Retry, or delegate a smaller task. `) &&
      e.message.endsWith('R'.repeat(200)) && !e.message.includes('R'.repeat(201));
  });
  handler = status(503, 'overloaded');
  await assert.rejects(spawn(params(), settings()), /^Error: 503 from .*Retry, or delegate a smaller task\. overloaded$/);
});

test('error: other 4xx surfaces status and body', async () => {
  handler = status(404, '{"error":"model not found"}');
  await assert.rejects(spawn(params(), settings()), /404 from .*model not found/);
});

test('error: timeout', async () => {
  handler = () => {}; // never responds
  await assert.rejects(spawn(params(), settings({ timeout_s: '0.1' })), /^Error: Subagent timed out after 0.1 s\.$/);
});

test('error: network failure names host and CORS', async () => {
  await assert.rejects(
    spawn(params(), settings({ base_url: 'http://127.0.0.1:1/v1' })),
    /^Error: Network error reaching 127\.0\.0\.1:1\. .*CORS/,
  );
});

test('error: non-JSON 200 body', async () => {
  handler = status(200, '<html>proxy page</html>');
  await assert.rejects(spawn(params(), settings()), /non-JSON response/);
});

// ---- Validation (before any fetch) ---------------------------------------

test('config: missing fields named', async () => {
  handler = () => assert.fail('fetch must not happen');
  for (const field of ['base_url', 'model', 'api_key']) {
    await assert.rejects(
      spawn(params(), settings({ [field]: '' })),
      { message: `Subagent is not configured: set ${field} in the plugin settings.` },
    );
  }
  assert.equal(lastRequest, undefined);
});

test('config: malformed settings', async () => {
  await assert.rejects(spawn(params(), settings({ provider: '{nope' })), /provider is not valid JSON/);
  await assert.rejects(spawn(params(), settings({ provider: '["novita"]' })), /provider must be a JSON object/);
  await assert.rejects(spawn(params(), settings({ temperature: 'warm' })), /temperature must be a number/);
  await assert.rejects(spawn(params(), settings({ max_tokens: '1.5' })), /max_tokens must be an integer/);
  await assert.rejects(spawn(params(), settings({ base_url: 'not a url' })), /base_url is not a valid URL/);
  assert.equal(lastRequest, undefined);
});

test('params: field limits and emptiness', async () => {
  await assert.rejects(spawn(params({ task: '  ' }), settings()), /Invalid task: must not be empty/);
  await assert.rejects(spawn(params({ task: 'x'.repeat(2001) }), settings()), /Invalid task: 2001 chars exceeds the limit of 2000/);
  await assert.rejects(spawn(params({ context: undefined }), settings()), /Invalid context: must not be empty/);
  await assert.rejects(spawn(params({ context: 'x'.repeat(64001) }), settings()), /Invalid context: 64001 chars .*under 32000/);
  await assert.rejects(spawn(params({ output_format: 'x'.repeat(1001) }), settings()), /Invalid output_format/);
  await assert.rejects(spawn(params({ task: 42 }), settings()), /Invalid task: must be a string/);
  assert.equal(lastRequest, undefined);
});

test('params: context between 32 000 and 64 000 chars is accepted', async () => {
  handler = reply('ok');
  const out = await spawn(params({ context: 'x'.repeat(40000) }), settings());
  assert.equal(out.text, 'ok');
});

// ---- Packaging -----------------------------------------------------------

test('plugin.json is in sync with spawn_subagent.js and well-formed', () => {
  const plugin = JSON.parse(readFileSync(join(root, 'plugin.json'), 'utf8'));
  const fn = plugin.pluginFunctions[0];
  assert.equal(fn.code, source);
  assert.equal(fn.openaiSpec.name, 'spawn_subagent');
  assert.equal(fn.outputType, 'respond_to_ai');
  assert.equal(fn.implementationType, 'javascript');
  assert.deepEqual(fn.openaiSpec.parameters.required, ['task', 'context']);
  assert.match(plugin.dynamicContextEndpoints[0].staticContent, /runs one task on \{model\} and returns text/);
  assert.deepEqual(plugin.userSettings.map((s) => s.name), [
    'base_url', 'api_key', 'model', 'provider', 'temperature', 'reasoning_effort', 'max_tokens', 'timeout_s', 'proxy_password',
  ]);
});
