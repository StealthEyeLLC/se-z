# PHASE3 OAUTH

Issuer https://auth.se-z.stealtheye.io. DCR, exact redirects, PKCE S256, numeric GitHub owner ID 247854506, one-time codes, Ed25519 access tokens, single-use refresh families, replay invalidation, JWKS, and revocation are implemented.

## ChatGPT Secure MCP Tunnel DCR compatibility

The current ChatGPT tunnel app wizard can register an exact `https://chatgpt.com/connector/oauth/...` callback while requesting `token_endpoint_auth_method=none`, then omit PKCE from the authorization request. se-z does not weaken public clients: exact ChatGPT connector registrations named `ChatGPT` are upgraded during DCR to `client_secret_post`, receive a one-time client secret in the registration response, and must authenticate the token exchange with that secret. All other public clients using `none` still require PKCE `S256`. The upstream GitHub owner-authentication leg continues to require PKCE `S256`.
