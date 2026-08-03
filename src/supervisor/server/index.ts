// Provenance: exact pinned source and transformation are recorded in vendor/baby-provenance/file-map.json.
/** se-z daemon entry point. */

import { loadRuntimeConfig } from '../configuration/config.js';
import { SezServer } from './server.js';

async function main(): Promise<void> {
  const config = loadRuntimeConfig();
  const server = new SezServer(config);

  const shutdown = async (signal: string) => {
    console.log(`[se-z] received ${signal}, shutting down`);
    await server.stop();
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  await server.start();
}

main().catch((err) => {
  console.error('[se-z] fatal:', err);
  process.exit(1);
});
