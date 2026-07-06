# NAS Credential Denylist Hardening Design

## Goal

Linke V0.66 expands the NAS credential-like field denylist before any real NAS transport work. The release remains a dry-run foundation: it rejects more credential-shaped inputs in `nasTargets[]` and nested `appAdapter` objects, but it does not resolve credentials, read environment variables, connect to NAS devices, invoke NAS apps, or write remote data.

## Scope

Add these exact forbidden field names:

- `privateKey`
- `clientSecret`
- `connectionString`
- `accessToken`
- `idToken`
- `secretKey`
- `sshKey`
- `passphrase`

They extend the existing denied fields: `username`, `password`, `token`, `apiKey`, `secret`, `accessKey`, `refreshToken`.

The denylist stays exact-key based. It must not reject unrelated keys by substring.

## Rationale

`connectionString` is intentionally denied because connection strings commonly embed usernames, passwords, or tokens. `secretKey` is intentionally denied in addition to `secret` because exact-key checking does not make `secret` cover `secretKey`.

## Non-Goals

- No real NAS connection.
- No credential resolver.
- No secret manager, `.env`, token, password, SSH key, or cloud credential lookup.
- No new network request.
- No remote write path.
- No Gold readiness promotion.

## Testing

Tests must cover:

- Each new field rejected at `nasTargets[]` level in `validateConfig()`.
- Each new field rejected by `validateNasTarget()`.
- Each new field rejected inside nested `appAdapter`.
- `credentialRef` plus a new forbidden field is still rejected.
- Error responses do not echo raw forbidden field values.
- README documents the full denylist and still says Gold is blocked.

## Qwen Notes

Qwen returned `PASS` with implementation constraints: document why `connectionString` and `secretKey` are denied, cover top-level and nested appAdapter tests, keep Gold blocked, and avoid env/network/NAS transport changes.
