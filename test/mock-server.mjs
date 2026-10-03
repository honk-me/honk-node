// A scriptable HTTP server for unit tests. Each request is answered by the next step of the
// script (the last step repeats). A step is { status, headers, body, delayMs } or 'destroy'
// (drop the connection without answering).
import { createServer } from 'node:http';

export async function mockServer(steps) {
  const requests = [];
  const script = Array.isArray(steps) ? steps : [steps];
  const server = createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const n = requests.length;
      requests.push({ method: req.method, url: req.url, headers: req.headers, raw, json: raw ? JSON.parse(raw) : undefined, at: Date.now() });
      const step = typeof script[0] === 'function' ? script[0](n) : script[Math.min(n, script.length - 1)];
      if (step === 'destroy') return req.socket.destroy();
      const send = () => {
        if (res.destroyed) return;
        const body = step.body === undefined ? '' : typeof step.body === 'string' ? step.body : JSON.stringify(step.body);
        res.writeHead(step.status ?? 202, { 'content-type': 'application/json', ...(step.headers ?? {}) });
        res.end(body);
      };
      if (step.delayMs) setTimeout(send, step.delayMs);
      else send();
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise((r) => {
        server.closeAllConnections?.();
        server.close(() => r());
      }),
  };
}

export const ok = (over = {}) => ({
  status: 202,
  body: { id: 'msg_01k6h3w4z5x6y7z8a9b0c1d2e3', status: 'accepted', duplicate: false, received_at: '2026-10-02T21:10:00.123Z', ...over },
});

export const apiError = (status, code, extra = {}, headers = {}) => ({
  status,
  headers,
  body: { error: { code, message: `${code} happened`, request_id: 'req_test', ...extra } },
});

export const KEY = 'honk_ab12cd34ef56_0123456789abcdefghijABCDEFGHIJ0123';
