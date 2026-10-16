const UPSTREAM = 'https://ollama.com';
const PASSWORD_HEADER = 'X-Proxy-Password';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': `Authorization, Content-Type, ${PASSWORD_HEADER}`,
};

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (!env.PROXY_PASSWORD || request.headers.get(PASSWORD_HEADER) !== env.PROXY_PASSWORD) {
      return new Response('Unauthorized', { status: 401, headers: CORS });
    }
    const { pathname, search } = new URL(request.url);
    const headers = new Headers(request.headers);
    headers.delete(PASSWORD_HEADER);
    const upstream = await fetch(UPSTREAM + pathname + search, {
      method: request.method,
      headers,
      body: request.body,
    });
    const response = new Response(upstream.body, upstream);
    for (const [k, v] of Object.entries(CORS)) response.headers.set(k, v);
    return response;
  },
};
