// Provenance: exact pinned source and transformation are recorded in vendor/baby-provenance/file-map.json.
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { createOAuthAuthorizationServer as createBaseOAuthAuthorizationServer } from './server.js';

function cleanExpired(data, now = Date.now()) {
  for (const collection of ['authorizationRequests', 'authorizationCodes', 'refreshTokens']) {
    for (const [key, value] of Object.entries(data[collection] ?? {})) {
      if (!value || Number(value.expiresAt) <= now) delete data[collection][key];
    }
  }
}

function installAtomicPersistence(server) {
  const store = server?.store;
  if (!store || typeof store.path !== 'string' || !store.data || typeof store.persist !== 'function') {
    throw new Error('OAuth state store is unavailable for durable persistence hardening');
  }

  store.persist = function persistAtomically() {
    cleanExpired(this.data);
    const directory = dirname(this.path);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify(this.data, null, 2)}\n`, {
        mode: 0o600,
        flag: 'wx',
      });
      chmodSync(temporary, 0o600);
      const fileFd = openSync(temporary, 'r');
      try {
        fsyncSync(fileFd);
      } finally {
        closeSync(fileFd);
      }
      renameSync(temporary, this.path);
      const directoryFd = openSync(directory, 'r');
      try {
        fsyncSync(directoryFd);
      } finally {
        closeSync(directoryFd);
      }
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  };

  return server;
}

export function createOAuthAuthorizationServer(config, options = {}) {
  return installAtomicPersistence(createBaseOAuthAuthorizationServer(config, options));
}
