import { spawn } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { env, python, root } from './runtime.mjs';

const children = [];
const publicPort = Number.parseInt(process.env.PORT || '10000', 10);
const webPort = Number.parseInt(process.env.QUEUE_CONTEXT_WEB_PORT || '3000', 10);
const collectorPort = Number.parseInt(process.env.QUEUE_CONTEXT_COLLECTOR_PORT || '8766', 10);
const username = process.env.QUEUE_CONTEXT_USERNAME || 'queuecontext';
const password = process.env.QUEUE_CONTEXT_PASSWORD || '';
let gateway;
let stopping = false;

function sameText(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function isAuthorized(request) {
  if (!password) return false;
  const [scheme, encoded] = (request.headers.authorization || '').split(' ', 2);
  if (scheme?.toLowerCase() !== 'basic' || !encoded) return false;

  let decoded;
  try {
    decoded = Buffer.from(encoded, 'base64').toString('utf8');
  } catch {
    return false;
  }

  const separator = decoded.indexOf(':');
  if (separator < 0) return false;
  return sameText(decoded.slice(0, separator), username) && sameText(decoded.slice(separator + 1), password);
}

function checkHealth(response) {
  const probe = httpRequest(
    {
      hostname: '127.0.0.1',
      port: collectorPort,
      path: '/api/health',
      method: 'GET',
      headers: { Host: `127.0.0.1:${collectorPort}` },
      timeout: 2000,
    },
    (upstream) => {
      upstream.resume();
      response.writeHead(upstream.statusCode === 200 ? 200 : 503, { 'Content-Type': 'text/plain' });
      response.end(upstream.statusCode === 200 ? 'ok' : 'unavailable');
    },
  );
  probe.on('timeout', () => probe.destroy(new Error('Health check timed out.')));
  probe.on('error', () => {
    if (!response.headersSent) response.writeHead(503, { 'Content-Type': 'text/plain' });
    response.end('unavailable');
  });
  probe.end();
}

function proxyToWeb(request, response) {
  const upstream = httpRequest(
    {
      hostname: '127.0.0.1',
      port: webPort,
      path: request.url,
      method: request.method,
      headers: request.headers,
    },
    (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    },
  );
  upstream.on('error', () => {
    if (!response.headersSent) response.writeHead(502, { 'Content-Type': 'text/plain' });
    response.end('Queue Context is starting. Please retry shortly.');
  });
  request.pipe(upstream);
}

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  gateway?.close();
  for (const child of children) child.kill('SIGTERM');
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => stop());
}

function launch(command, args) {
  const child = spawn(command, args, { cwd: root, env, stdio: 'inherit' });
  children.push(child);
  child.on('error', (error) => {
    console.error(`Could not start Queue Context: ${error.message}`);
    stop(1);
  });
  child.on('exit', (code) => {
    if (!stopping) stop(code ?? 1);
  });
}

if (!password) {
  console.error('QUEUE_CONTEXT_PASSWORD must be set before starting the hosted service.');
  process.exit(1);
}

launch(python, ['collector/server.py']);
launch(process.execPath, [
  join(root, 'node_modules/vinext/dist/cli.js'),
  'start',
  '--hostname',
  '127.0.0.1',
  '--port',
  String(webPort),
]);

gateway = createServer((request, response) => {
  if (request.url === '/healthz') return checkHealth(response);
  if (!isAuthorized(request)) {
    response.writeHead(401, {
      'Content-Type': 'text/plain',
      'WWW-Authenticate': 'Basic realm="Queue Context", charset="UTF-8"',
    });
    return response.end('Authentication required.');
  }
  return proxyToWeb(request, response);
});

gateway.listen(publicPort, '0.0.0.0', () => {
  console.log(`Queue Context gateway listening on 0.0.0.0:${publicPort}`);
});
