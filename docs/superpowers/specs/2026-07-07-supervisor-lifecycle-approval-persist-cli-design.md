# Supervisor Lifecycle Approval Persist CLI Design

## Goal

V0.94 adds an explicit Agent CLI command that wires V0.93's local sanitized approval store to the existing approval preview flow:

```bash
node src/agent.js supervisor-lifecycle-approval-persist --config <path> --operation <operation> --approval <path> --data-dir <path>
```

The command persists a sanitized approval record only when the approval preview is valid and only has the `approval-persistence-store-missing` blocker.

## Boundaries

- No Web/API persist endpoint.
- No lifecycle apply endpoint or lifecycle execution.
- No `launchctl`, process spawn, install, rollback, uninstall, recovery supervisor, NAS, backup, restore, audit write, keychain, database, or remote command.
- Requires explicit `--data-dir`; no default production path.
- Reads only explicit `--config` and `--approval` files.
- Reuses forbidden approval path checks.
- Rejects `--apply`.
- Invalid approvals print the sanitized blocked preview and exit `2` without creating the approval store.
- Output must not include config path, approval path, data-dir path, source path, server URL, approval identity, reason, acknowledgement text, approval timestamps, hash values, token, secret, hostname, username, or process id.
- Gold remains blocked.

## Output

Valid approval:

- prints the sanitized persisted approval record from `appendSupervisorLifecycleApprovalRecord(...)`
- exits `0`

Invalid approval:

- prints sanitized `supervisor-lifecycle-approval-persistence-preview`
- exits `2`
- does not create `<dataDir>/approvals`
