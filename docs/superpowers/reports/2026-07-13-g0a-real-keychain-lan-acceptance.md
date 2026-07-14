# G0a Real Two-Mac Keychain / LAN Acceptance Report

## Scope

- **kind**: sanitized real-gate acceptance evidence (test-only harness)
- **scope**: G0a real dual-Mac Keychain / LAN boundary only
- **not claimed**: full Linke Gold release; remaining README Gold blockers stay unchanged

## Identity (allowed fields only)

| Field | Value |
| --- | --- |
| sourceCommit | `10ffad69e6a3` |
| commandId | `G0A-REAL-20260714-01` |
| finalResultAt (UTC) | `2026-07-14T07:02:50.301Z` |
| overallStatus | `PASS` |
| promptHandled | `true` |
| Controller/PM runtime baseline | Node major `24`, macOS major `26` |
| Endpoint OS/Node major | not independently recorded; not claimed |

## Pre-gates

| Gate | Status | Notes |
| --- | --- | --- |
| real gate (`LINKE_REAL_G0A_ACCEPTANCE=enabled`) | PASS | explicit enablement required |
| local Keychain gated test | PASS | user handled macOS Keychain UI |
| remote Keychain gated test | PASS | user handled macOS Keychain UI |

`promptHandled=true` because Keychain allow/unlock required manual UI handling during this run.

## Stage results

Registered codes appear only where the stage’s success criterion is a fail-closed rejection. Unlisted stages completed with `status: PASS` and no failure code.

| Stage | Status | Registered code (if any) |
| --- | --- | --- |
| start | PASS | — |
| initial prepare (count 3) | PASS | — |
| pre-revoke | PASS | — |
| rotate old-token rejection | PASS | `device-token-invalid` |
| current heartbeat | PASS | — |
| N-1 heartbeat | PASS | — |
| N-2 strict rejection | PASS | `device-protocol-unsupported` (HTTP 426) |
| revoke | PASS | — |
| post-revoke | PASS | `device-revoked` (HTTP 403) |
| restart | PASS | — |
| post-restart | PASS | — |
| identity replacement | PASS | — |
| old-pin mismatch | PASS | `device-tls-fingerprint-mismatch` |
| reenroll | PASS | — |
| Controller cleanup | PASS | final state `cleaned` |
| Endpoint cleanup | PASS | final state `cleaned` |

## Cleanup and residual checks

| Check | Result |
| --- | --- |
| Controller final state | `cleaned` |
| Endpoint final state | `cleaned` |
| dedicated cleanup files | absent (confirmed) |
| dedicated cleanup directories | absent (confirmed) |
| dedicated Keychain items | absent (confirmed) |
| temporary SSH control connection | closed |

## Gold status boundary

- **G0a real dual-Mac acceptance**: `PASS` for this commandId and sourceCommit.
- **Linke Gold overall**: remains **BLOCKED**. This report does not clear other README Gold blockers, does not mark Gold ready, and does not claim a complete production release.

## Redaction boundary (hard)

This report intentionally excludes all of the following:

- host, IP, URL, path
- fingerprint (full or prefix)
- enrollment code, device/admin token, Authorization material
- Keychain service name or item name
- username, SSH target/alias value
- raw system/error/stderr text
- PEM material, private keys, certificates
- any 64-hex digest string
- real or example network endpoints

Only abstract identifiers (`sourceCommit`, `commandId`), major runtime numbers for Controller/PM baseline, registered error codes, UTC timestamps, booleans, and PASS/FAIL/BLOCKED outcomes are recorded.
