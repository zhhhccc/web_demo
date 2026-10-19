// Cloudflare Worker 版本 — Ollama Agent 代理 + 工具编排
const OLLAMA_BASE = 'https://ollama.znbhcjdnfc.online';
const MODEL_NAME = 'qwen3.5:9b';

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'get_current_time',
      description: '获取当前日期和时间',
      parameters: {
        type: 'object',
        properties: { timezone: { type: 'string', description: 'IANA 时区，如 Asia/Shanghai' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'calculate',
      description: '计算一个简单数学表达式',
      parameters: {
        type: 'object',
        properties: { expression: { type: 'string' } },
        required: ['expression'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fetch_webpage',
      description: '抓取网页并返回纯文本内容（截断到 4000 字符）',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string' } },
        required: ['url'],
      },
    },
  },
];

async function executeTool(name, args) {
  switch (name) {
    case 'get_current_time': {
      const tz = args.timezone || 'Asia/Shanghai';
      return new Date().toLocaleString('zh-CN', { timeZone: tz });
    }
    case 'calculate': {
      const expr = String(args.expression || '');
      if (!/^[\d\s+\-*/().%]+$/.test(expr)) return '错误：表达式含非法字符';
      try {
        const result = Function(`"use strict"; return (${expr});`)();
        return String(result);
      } catch { return '错误：表达式无法计算'; }
    }
    case 'fetch_webpage': {
      try {
        const r = await fetch(args.url);
        const text = await r.text();
        const plain = text.replace(/<script[\s\S]*?<\/script>/gi, '')
                          .replace(/<style[\s\S]*?<\/style>/gi, '')
                          .replace(/<[^>]+>/g, ' ')
                          .replace(/\s+/g, ' ').trim();
        return plain.slice(0, 4000);
      } catch (e) { return `抓取失败: ${e.message}`; }
    }
    default:
      return `未知工具: ${name}`;
  }
}

function sseChunk(data) {
  return new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`);
}

export default {
  async fetch(request, env, ctx) {
    const startTime = Date.now();

    const url = new URL(request.url);

    // 1. 处理 CORS 预检
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }

    // 2. 如果访问根目录，直接交给静态资源处理（去 public 文件夹找）
    // 因为你的 HTML 叫 qwennine_cloud.html，所以这里重定向一下最稳妥
    if (url.pathname === '/' || url.pathname === '/index.html') {
      return Response.redirect(url.origin + '/qwennine_cloud.html', 302);
    }

    // 3. 健康检查接口
    if (url.pathname === '/health' && request.method === 'GET') {
      try {
        const r = await fetch(`${OLLAMA_BASE}/api/tags`);
        const data = await r.json();
        const modelAvailable = (data.models || []).some(m => m.name === MODEL_NAME);
        return new Response(JSON.stringify({ ollama: true, model: MODEL_NAME, modelAvailable }), {
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        });
      } catch {
        return new Response(JSON.stringify({ ollama: false, model: MODEL_NAME, modelAvailable: false }), {
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        });
      }
    }

    // 4. 聊天接口
    if (url.pathname === '/chat' && request.method === 'POST') {
      return handleChat(request);
    }

    // 5. 其他情况交给静态资源处理（比如你的 JS、CSS 文件请求）
    // 这里加了兜底判断，防止 env.ASSETS 未定义时报错
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response(JSON.stringify({ error: 'Not Found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  },
};

async function handleChat(request) {
  // ...（聊天逻辑保持不变，见下方说明）
  const startTime = Date.now();
  const body = await request.json();
  const history = body.messages || [];
  const messages = [...history];
  const MAX_ITER = 5;

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();

  (async () => {
    try {
      for (let iter = 0; iter < MAX_ITER; iter++) {
        const resp = await fetch(`${OLLAMA_BASE}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: MODEL_NAME, messages, tools: TOOLS, stream: false }),
        });
        if (!resp.ok) throw new Error(`Ollama HTTP ${resp.status}`);
        const data = await resp.json();
        const msg = data.message || {};

        if (msg.tool_calls?.length) {
          messages.push({ role: 'assistant', content: msg.content || '', tool_calls: msg.tool_calls });
          for (const call of msg.tool_calls) {
            const name = call.function?.name;
            let args = call.function?.arguments || {};
            if (typeof args === 'string') {
              try { args = JSON.parse(args); } catch { args = {}; }
            }
            await writer.write(sseChunk({ type: 'tool', name }));
            const result = await executeTool(name, args);
            messages.push({ role: 'tool', content: String(result), tool_name: name });
          }
          continue;
        }

        const finalResp = await fetch(`${OLLAMA_BASE}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: MODEL_NAME, messages, stream: true }),
        });
        if (!finalResp.ok) throw new Error(`Ollama HTTP ${finalResp.status}`);

        const reader = finalResp.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split('\n');
          buf = lines.pop();
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const j = JSON.parse(line);
              if (j.message?.content) await writer.write(sseChunk({ type: 'content', text: j.message.content }));
              if (j.done) await writer.write(sseChunk({ type: 'done' }));
            } catch { /* 忽略半行 */ }
          }
        }
        break;
      }
    } catch (e) {
      await writer.write(sseChunk({ type: 'error', message: e.message }));
    } finally {
      await writer.close();
      const duration = Date.now() - startTime;
      console.log(`[CHAT] Duration: ${duration}ms`);
    }
  })();

  return new Response(readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
