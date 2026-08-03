// Provenance: exact pinned source and transformation are recorded in vendor/baby-provenance/file-map.json.
import { loadConfig } from '../configuration/config.js';
import { createSezMcpServer } from './server.js';

const config = loadConfig();
const server = createSezMcpServer(config);
let closing = false;

server.on('error', (error) => {
  const message = error instanceof Error ? error.message : 'unknown server error';
  process.stderr.write(`${JSON.stringify({ event: 'se-z-gateway.error', message })}\n`, () => process.exit(1));
});

server.listen(config.httpPort, config.bindHost, () => {
  const address = server.address();
  const port = address && typeof address === 'object' ? address.port : config.httpPort;
  process.stdout.write(`${JSON.stringify({
    event: 'se-z-gateway.listening',
    host: config.bindHost,
    port,
    version: config.version,
    commit: config.commitSha,
  })}\n`);
});

function shutdown() {
  if (closing) return;
  closing = true;
  if (!server.listening) {
    process.exit(0);
  }
  server.close((error) => {
    if (error) {
      process.stderr.write(`${JSON.stringify({ event: 'se-z-gateway.shutdown-error', message: error.message })}\n`, () => process.exit(1));
      return;
    }
    process.exit(0);
  });
  server.closeAllConnections();
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
