// A deterministic stand-in for the Ollama HTTP API, used by the end-to-end tests. It speaks
// the same protocol as the real daemon, so requests from both the Rust bridge and the
// browser bridge go through identical code paths. Tests drive it through /__mock/*.
import http from 'node:http';

const PORT = Number(process.env.MOCK_OLLAMA_PORT ?? 17393);

const BASE_MODELS = [
  {
    name: 'llama3.2:3b',
    model: 'llama3.2:3b',
    modified_at: '2026-11-01T14:43:18+08:00',
    size: 2019393189,
    digest: 'a80c4f17acd5',
    details: { family: 'llama', parameter_size: '3.2B', quantization_level: 'Q4_K_M' },
    capabilities: ['completion', 'tools'],
  },
  {
    name: 'moondream:latest',
    model: 'moondream:latest',
    modified_at: '2026-11-01T14:10:48+08:00',
    size: 1738451197,
    digest: '55fc3abd3867',
    details: { family: 'phi2', parameter_size: '1B', quantization_level: 'Q4_0' },
    capabilities: ['completion', 'vision'],
  },
];

const DEFAULT_DECK = {
  slides: [
    {
      slideNumber: 1,
      originalExcerpt: 'Revenue grew a lot and churn went down this quarter.',
      refinedTitle: 'Revenue up 38 percent, churn down',
      executiveSummary: ['Enterprise tier drove growth', 'Churn fell to 2.6 percent'],
      speakerNotes: 'Start with the headline number, then explain the driver.',
      layoutType: 'single-visual',
      dropzones: [{ aiVisualPrompt: 'Revenue dashboard screenshot' }],
    },
    {
      slideNumber: 2,
      originalExcerpt: 'Compare the old checkout with the new checkout.',
      refinedTitle: 'A faster checkout converts better',
      executiveSummary: ['Load time fell to 900 ms', 'Abandoned carts fell by a fifth'],
      speakerNotes: 'Walk through both flows side by side.',
      layoutType: 'split-comparison',
      dropzones: [{ aiVisualPrompt: 'Legacy checkout' }, { aiVisualPrompt: 'Redesigned checkout' }],
    },
    {
      slideNumber: 3,
      originalExcerpt: 'Three priorities for Q4 across regions, mobile and compliance.',
      refinedTitle: 'Three priorities for Q4',
      executiveSummary: ['APAC expansion', 'Mobile companion', 'SOC 2 Type II'],
      speakerNotes: 'Keep this brisk.',
      layoutType: 'multi-grid',
      dropzones: [{ aiVisualPrompt: 'APAC map' }, { aiVisualPrompt: 'Mobile mockup' }, { aiVisualPrompt: 'Compliance roadmap' }],
    },
    {
      slideNumber: 4,
      originalExcerpt: 'The ask is two more engineers.',
      refinedTitle: 'Approve two engineers for the data platform',
      executiveSummary: ['Keeps the APAC launch on schedule'],
      speakerNotes: 'Close on the decision you need today.',
      layoutType: 'statement-only',
      dropzones: [],
    },
  ],
};

function freshState() {
  return {
    online: true,
    version: '0.40.13',
    models: structuredClone(BASE_MODELS),
    requests: [],
    deck: DEFAULT_DECK,
    chatMode: 'ok',
    chatDelayMs: 40,
    visionText: 'The highlighted panel shows the conversion funnel, where the week 7 spike marks the partner campaign.',
    pullLayers: [
      { digest: 'sha256:layer-a', total: 600_000_000 },
      { digest: 'sha256:layer-b', total: 400_000_000 },
    ],
    pullSteps: 12,
    pullDelayMs: 60,
    pullError: null,
    pullBumpsDigest: false,
    tagsSlowMs: 0,
    rejectMultiImage: false,
  };
}

let state = freshState();
let tagsCalls = 0;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function handlePull(req, res, body) {
  const name = body.model ?? body.name;
  state.requests.push({ path: '/api/pull', body });
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
  const write = (line) => res.write(`${JSON.stringify(line)}\n`);

  let aborted = false;
  res.on('close', () => {
    aborted = !res.writableEnded;
  });

  write({ status: 'pulling manifest' });
  await sleep(state.pullDelayMs);
  if (state.pullError) {
    write({ error: state.pullError });
    res.end();
    return;
  }

  for (const layer of state.pullLayers) {
    for (let step = 1; step <= state.pullSteps; step += 1) {
      if (aborted) return;
      write({
        status: `pulling ${layer.digest.slice(7, 19)}`,
        digest: layer.digest,
        total: layer.total,
        completed: Math.round((layer.total * step) / state.pullSteps),
      });
      await sleep(state.pullDelayMs);
    }
  }
  if (aborted) return;
  write({ status: 'verifying sha256 digest' });
  write({ status: 'writing manifest' });

  const existing = state.models.find((model) => model.name === name);
  if (existing) {
    if (state.pullBumpsDigest) existing.digest = `${existing.digest}-updated`;
  } else {
    const isVision = /moondream|llava|vision|minicpm|vl/.test(name);
    state.models.push({
      name,
      model: name,
      modified_at: new Date().toISOString(),
      size: 1_000_000_000,
      digest: `mock-${name}`,
      details: { family: 'mock', parameter_size: '1B', quantization_level: 'Q4' },
      capabilities: isVision ? ['completion', 'vision'] : ['completion'],
    });
  }
  write({ status: 'success' });
  res.end();
}

async function streamContent(res, content, doneReason = 'stop') {
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
  let aborted = false;
  res.on('close', () => {
    aborted = !res.writableEnded;
  });
  // Split into pieces, including mid-token, to exercise the NDJSON reassembly.
  const size = Math.max(8, Math.ceil(content.length / 24));
  for (let offset = 0; offset < content.length; offset += size) {
    if (aborted) return;
    res.write(`${JSON.stringify({ model: 'mock', message: { role: 'assistant', content: content.slice(offset, offset + size) }, done: false })}\n`);
    await sleep(state.chatDelayMs);
  }
  if (aborted) return;
  res.write(`${JSON.stringify({ model: 'mock', message: { role: 'assistant', content: '' }, done: true, done_reason: doneReason })}\n`);
  res.end();
}

async function handleChat(req, res, body) {
  state.requests.push({ path: '/api/chat', body });
  const user = body.messages?.find((message) => message.role === 'user');
  const isVision = Array.isArray(user?.images);

  if (isVision) {
    if (state.rejectMultiImage && user.images.length > 1) {
      json(res, 400, { error: 'this model only supports one image while more than one image requested' });
      return;
    }
    await streamContent(res, state.visionText);
    return;
  }

  const attempt = state.requests.filter((request) => request.path === '/api/chat' && !request.body.messages?.some((message) => Array.isArray(message.images))).length;
  switch (state.chatMode) {
    case 'error':
      json(res, 500, { error: 'model runner has unexpectedly stopped' });
      return;
    case 'truncated':
      await streamContent(res, '{"slides": [ {"refinedTitle": "cut off', 'length');
      return;
    case 'garbage':
      await streamContent(res, 'I am sorry, I cannot produce JSON right now.');
      return;
    case 'repair':
      await streamContent(res, attempt === 1 ? '{"slides": [ {"refinedTitle": "broken' : JSON.stringify(state.deck));
      return;
    case 'emoji':
      await streamContent(res, JSON.stringify({ slides: [{ ...state.deck.slides[0], refinedTitle: 'Rocket launch \u{1F680} ahead', speakerNotes: 'Great news \u{1F389}' }] }));
      return;
    case 'fenced':
      await streamContent(res, `<think>let me plan</think>\n\`\`\`json\n${JSON.stringify(state.deck)}\n\`\`\``);
      return;
    default:
      await streamContent(res, JSON.stringify(state.deck));
  }
}

const server = http.createServer(async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const rawBody = req.method === 'POST' ? await readBody(req) : '';
  const body = rawBody ? JSON.parse(rawBody) : {};

  // Test control surface.
  if (url.pathname === '/__mock/reset') {
    state = freshState();
    json(res, 200, { ok: true });
    return;
  }
  if (url.pathname === '/__mock/state') {
    Object.assign(state, body);
    tagsCalls = 0;
    json(res, 200, { ok: true });
    return;
  }
  if (url.pathname === '/__mock/requests') {
    json(res, 200, state.requests);
    return;
  }
  if (url.pathname === '/__mock/health') {
    json(res, 200, { ok: true });
    return;
  }

  if (!state.online) {
    // Drops the connection, which is how a stopped daemon looks to a client.
    req.socket.destroy();
    return;
  }

  try {
    if (url.pathname === '/api/tags') {
      state.requests.push({ path: '/api/tags', at: Date.now() });
      tagsCalls += 1;
      if (state.tagsSlowMs && tagsCalls > 1) await sleep(state.tagsSlowMs);
      json(res, 200, { models: state.models });
    } else if (url.pathname === '/api/version') {
      json(res, 200, { version: state.version });
    } else if (url.pathname === '/api/pull') {
      await handlePull(req, res, body);
    } else if (url.pathname === '/api/chat') {
      await handleChat(req, res, body);
    } else {
      json(res, 404, { error: 'not found' });
    }
  } catch (error) {
    if (!res.headersSent) json(res, 500, { error: String(error) });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Mock Ollama listening on http://127.0.0.1:${PORT}`);
});
