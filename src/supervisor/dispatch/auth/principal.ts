// Provenance: exact pinned source and transformation are recorded in vendor/baby-provenance/file-map.json.
/** Principal envelope validation. */

import { DEFAULTS } from '../../configuration/config.js';
import type { RuntimeConfig } from '../../configuration/config.js';
import { AuthError } from './errors.js';
import { constantTimeEqual } from '../../../protocol/canonical/canonical.js';

export interface OwnerPrincipal {
  subject: string;
  authorityClass: string;
  issuer: string;
  resource: string;
  audience: string;
  principalType: string;
  workspaceAuthority: null;
  principalFingerprint: string;
}

export function buildOwnerPrincipal(
  overrides: Partial<OwnerPrincipal> = {},
): OwnerPrincipal {
  return {
    subject: DEFAULTS.expectedSubject,
    authorityClass: DEFAULTS.authorityClass,
    issuer: DEFAULTS.oauthIssuer,
    resource: DEFAULTS.oauthResource,
    audience: DEFAULTS.oauthResource,
    principalType: 'owner',
    workspaceAuthority: null,
    principalFingerprint: '',
    ...overrides,
  };
}

export function validatePrincipal(
  raw: Record<string, unknown>,
  config: RuntimeConfig,
): OwnerPrincipal {
  const principal: OwnerPrincipal = {
    subject: String(raw.subject ?? ''),
    authorityClass: String(raw.authorityClass ?? ''),
    issuer: String(raw.issuer ?? ''),
    resource: String(raw.resource ?? ''),
    audience: String(raw.audience ?? ''),
    principalType: String(raw.principalType ?? ''),
    workspaceAuthority:
      raw.workspaceAuthority === undefined ? null : (raw.workspaceAuthority as null),
    principalFingerprint: String(raw.principalFingerprint ?? ''),
  };

  if (principal.subject !== config.expectedSubject) {
    throw new AuthError('invalid_subject', 'Principal subject does not match expected owner');
  }
  if (principal.authorityClass !== config.authorityClass) {
    throw new AuthError('invalid_authority_class', 'Authority class does not match');
  }
  if (principal.issuer !== config.oauthIssuer) {
    throw new AuthError('invalid_issuer', 'Principal issuer does not match expected OAuth issuer');
  }
  if (principal.resource !== config.oauthResource) {
    throw new AuthError('invalid_resource', 'Principal resource does not match expected resource');
  }
  if (principal.audience !== config.oauthResource) {
    throw new AuthError('invalid_audience', 'Principal audience does not match expected audience');
  }
  if (principal.principalType !== 'owner') {
    throw new AuthError('invalid_principal_type', 'Principal type must be owner');
  }
  if (principal.workspaceAuthority !== null) {
    throw new AuthError(
      'invalid_workspace_authority',
      'Workspace authority must be null for unrestricted owner',
    );
  }

  if (config.ownerPrincipalFingerprint && config.ownerPrincipalFingerprint !== 'test') {
    if (!principal.principalFingerprint) {
      throw new AuthError('invalid_principal_fingerprint', 'Owner principal fingerprint is required');
    }
    if (!constantTimeEqual(principal.principalFingerprint, config.ownerPrincipalFingerprint)) {
      throw new AuthError('invalid_principal_fingerprint', 'Owner principal fingerprint does not match');
    }
  }

  return principal;
}
