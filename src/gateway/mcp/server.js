// Provenance: exact pinned source and transformation are recorded in vendor/baby-provenance/file-map.json.
import { createServer } from 'node:http';
import { SezClient } from '../transport/client.js';
import { loadConfig } from '../configuration/config.js';
import { OAuthVerifier } from '../../auth/oauth/tokens.js';
import { createOAuthAuthorizationServer } from '../../auth/oauth/state-durable.js';
import { callSez, PUBLIC_TOOL_NAME, TOOL_DEFINITION } from './tool.js';

export const MCP_PROTOCOL_VERSION = '2025-06-18';
const SUPPORTED_PROTOCOLS = new Set([MCP_PROTOCOL_VERSION, '2025-03-26', '2024-11-05']);
const RESOURCE_METADATA_PATHS = new Set([
  '/.well-known/oauth-protected-resource',
  '/.well-known/oauth-protected-resource/mcp',
]);

function json(response, status, value, headers = {}) {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    ...headers,
  });
  response.end(body);
}

async function readJson(request, maximumBytes) {
  if (!String(request.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) throw new Error('content-type must be application/json');
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maximumBytes) throw new Error('request body exceeds its bound');
    chunks.push(chunk);
  }
  if (size === 0) throw new Error('request body is empty');
  return JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
}

function rpcResult(id, result) { return { jsonrpc: '2.0', id, result }; }
function rpcError(id, code, message) { return { jsonrpc: '2.0', id: id ?? null, error: { code, message } }; }

function fallbackProtectedResourceMetadata(config) {
  return {
    resource: config.protectedResource ?? config.oauthResource,
    authorization_servers: [config.oauthIssuer],
    bearer_methods_supported: ['header'],
    scopes_supported: [config.requiredScope],
  };
}

function protectedResourceMetadataUrl(config) {
  return `${config.publicResource}/.well-known/oauth-protected-resource/mcp`;
}

function forceSeeOtherForAuthorizationPost(request, response, url) {
  if (request.method !== 'POST' || url.pathname !== '/oauth/authorize') return;
  const originalWriteHead = response.writeHead;
  response.writeHead = function writeHead(statusCode, ...arguments_) {
    return originalWriteHead.call(this, statusCode === 302 ? 303 : statusCode, ...arguments_);
  };
}

export async function handleRpc(message, context) {
  if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0' || typeof message.method !== 'string') return rpcError(message?.id, -32600, 'Invalid Request');
  if (message.id === undefined && message.method === 'notifications/initialized') return null;
  if (message.method === 'initialize') {
    const requested = message.params?.protocolVersion;
    return rpcResult(message.id, {
      protocolVersion: typeof requested === 'string' && SUPPORTED_PROTOCOLS.has(requested) ? requested : MCP_PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'StealthEye se-z', version: context.config.version },
      instructions: 'Use call_sez with sez.describe to discover the deployed se-z capabilities.',
    });
  }
  if (message.method === 'ping') return rpcResult(message.id, {});
  if (message.method === 'tools/list') return rpcResult(message.id, { tools: [TOOL_DEFINITION] });
  if (message.method === 'tools/call') {
    if (message.params?.name !== PUBLIC_TOOL_NAME) return rpcError(message.id, -32602, 'Unknown tool');
    return rpcResult(message.id, await callSez(message.params?.arguments, context.client));
  }
  return rpcError(message.id, -32601, 'Method not found');
}

export function createSezMcpServer(config = loadConfig(), options = {}) {
  const hasOAuthServerOption = Object.prototype.hasOwnProperty.call(options, 'oauthServer');
  const oauthServer = hasOAuthServerOption
    ? options.oauthServer
    : config.oauthSigningPrivateKeyPath
      ? createOAuthAuthorizationServer(config)
      : null;
  const verifier = options.verifier ?? new OAuthVerifier(config, oauthServer ? { localJwks: oauthServer.jwks() } : fetch);
  const client = options.client ?? new SezClient(config);
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://mcp.invalid');
      if (url.pathname === '/.well-known/openid-configuration') {
        json(response, 404, { error: 'not_found' });
        return;
      }
      if (oauthServer) {
        forceSeeOtherForAuthorizationPost(request, response, url);
        if (await oauthServer.handle(request, response, url)) return;
      }
      if (request.method === 'GET' && url.pathname === '/healthz') {
        json(response, 200, {
          status: 'ok',
          product: 'se-z-gateway',
          version: config.version,
          commit: config.commitSha,
          publicTools: 1,
          oauthIssuer: config.oauthIssuer,
          protectedResource: config.protectedResource ?? config.oauthResource,
        });
        return;
      }
      if (request.method === 'GET' && RESOURCE_METADATA_PATHS.has(url.pathname)) {
        json(response, 200, fallbackProtectedResourceMetadata(config));
        return;
      }
      if (url.pathname !== '/mcp') { json(response, 404, { error: 'not_found' }); return; }
      if (request.method !== 'POST') { json(response, 405, rpcError(null, -32000, 'Method not allowed'), { allow: 'POST' }); return; }
      try {
        await verifier.verify(request.headers.authorization);
      } catch {
        json(response, 401, { error: 'unauthorized' }, {
          'www-authenticate': `Bearer resource_metadata="${protectedResourceMetadataUrl(config)}", scope="${config.requiredScope}"`,
        });
        return;
      }
      let message;
      try { message = await readJson(request, config.maxRequestBytes); }
      catch (error) { json(response, 400, rpcError(null, -32700, error instanceof Error ? error.message : 'Parse error')); return; }
      const value = await handleRpc(message, { config, client });
      if (value === null) { response.writeHead(202, { 'cache-control': 'no-store' }); response.end(); }
      else json(response, 200, value);
    } catch {
      if (!response.headersSent) json(response, 500, rpcError(null, -32603, 'Internal server error'));
      else response.destroy();
    }
  });
}
