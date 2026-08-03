# OAuth and ChatGPT MCP Authentication

## Identities

- GitHub OAuth authenticates the owner.
- Z GitHub Authority App performs GitHub administration.
- ChatGPT app permission preferences are not authentication.

## Required endpoints

Tunnel-backed resource:

```text
/.well-known/oauth-protected-resource
/mcp
```

Public authorization origin:

```text
https://auth.se-z.stealtheye.io/.well-known/oauth-authorization-server
/oauth/register
/oauth/authorize
/oauth/github
/oauth/github/callback
/oauth/token
/oauth/revoke
/oauth/jwks.json
```

## Protected-resource metadata

The resource identifier is exact and appears consistently in metadata, authorization requests, token requests, refresh requests where supported, and access-token audience validation. Missing or invalid bearer tokens return `401 Unauthorized` with `WWW-Authenticate: Bearer resource_metadata="<exact metadata URL>", scope="sez.root offline_access"`.

## Scopes

```text
sez.root       sole operation authority
offline_access refresh-token lifecycle request only
```

## Gateway durable state

```text
/var/lib/se-z-gateway/slots/blue/
/var/lib/se-z-gateway/slots/green/
```

The state includes registered clients, transient authorization state, authorization codes, hashed refresh-token families, revocations, and replay records. Candidate state is isolated. Backup and restore preserve active and previous state.

## Security requirements

- PKCE `S256`.
- Numeric GitHub user ID `247854506`.
- Rotating single-use refresh-token families.
- Refresh replay rejection.
- Exact issuer, resource/audience, client, workspace where available, subject, and authority scope.
- No token passthrough to GitHub or other upstream APIs.
