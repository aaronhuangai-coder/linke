# Linke V0.39 Device Empty Filter Context Design

## Summary

V0.39 adds a read-only empty-state context to the Web Console device list. When local device filters produce no visible rows, the list still shows `无匹配设备` and now also shows the active search, status filter, and management-state filter.

## Scope

- Add `buildDeviceEmptyFilterContext(controls)` as an exported pure helper.
- Render `device-empty-state` for empty device list results.
- Render `device-empty-filter-context` inside the empty state.
- Pass the current device controls from `renderFilteredDevices()` into `renderDevices()` instead of letting `renderDevices()` read DOM controls implicitly.
- Update README, tests, style, and implementation plan docs.

## Filter Context Mapping

| Control | Empty value | Mapped values |
|---|---|---|
| `query` | `全部` | Current trimmed search text |
| `status` | `全部` | `online` = `在线`, `offline` = `离线`, `unknown` = `未知` |
| `management` | `全部` | `visible` = `在线可见`, `missing-ip` = `在线缺 IP`, `offline-retained` = `离线保留`, `unknown` = `未知待确认` |

Output format:

```text
搜索: <query> · 状态: <status label> · 管理态: <management label>
```

Sort order is intentionally excluded because the empty state is caused by filtering, not ordering.

## Safety Boundaries

- Frontend-only read-only behavior.
- No backend API changes.
- No metadata writes.
- No new `/api/devices` refetch on local filter changes.
- No backup, restore, sync, delete, NAS connection, NAS app invocation, or remote command.
- Dynamic search text is rendered with `textContent`, not `innerHTML`.

## Resilience

- Normal state: if filtered rows exist, device list rendering remains unchanged.
- Empty state: if filtered rows are empty, the list renders a stable empty row with context.
- Recovery anchor: if device loading fails, existing load failure handling remains unchanged.
- Bounded failure: unknown filter values fall back to their raw value instead of throwing.
- Detection: pure tests verify context formatting, DOM tests verify hooks and no `/api/devices` refetch, README tests verify documentation.

## Qwen Adversarial Findings And PM Decisions

- Finding: `renderDevices(devices)` needs filter context without implicit DOM reads.
  - Decision: accepted. `renderFilteredDevices()` computes controls once and passes them into `renderDevices(visibleDevices, controls)`.
- Finding: status and management filter values need explicit label mapping.
  - Decision: accepted. V0.39 adds label maps for status and management filter context.
- Finding: default all-filter context may be redundant.
  - Decision: accepted as a minor UX tradeoff. It keeps the empty-state schema stable.
- Finding: CSS should keep the context visually secondary.
  - Decision: accepted. `.device-empty-filter-context` uses smaller muted text.

## AGY Implementer Failure Signature

AGY was assigned the implementer role twice for this bounded V0.39 task. Both attempts exited with planning-only chatter such as "I will view..." / "I will search..." and produced no schema, no diff, and no target docs. PM verification found a clean worktree after each attempt. Per pm-dcw v2.9.2, this is treated as invalid worker output, not an implementation result. User loop-engineering instruction authorized PM fallback implementation after documenting the failure.
