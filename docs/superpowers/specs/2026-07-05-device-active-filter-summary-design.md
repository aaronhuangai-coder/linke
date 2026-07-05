# Linke V0.42 Device Active Filter Summary Design

## Summary

V0.42 adds a read-only device filter summary to the Web Console. The summary makes the current device list controls visible even when the list still has matches.

## Scope

- Export `buildDeviceActiveFilterSummary(controls)` as a pure helper.
- Add `DEVICE_FILTER_SORT_LABELS` for the existing device sort values.
- Add a static `device-active-filter-summary` element near the device controls.
- Update the summary through the existing `renderFilteredDevices()` local render path.
- Update README, tests, and plan docs.

## Behavior

Default controls:

```text
query: empty or whitespace
status: all
management: all
sort: name
```

The default summary text is:

```text
默认筛选
```

When any control differs from default, the summary text starts with `当前筛选:` and includes labels for search, status, management state, and sort:

```text
当前筛选: 搜索: Beta · 状态: 在线 · 管理态: 在线可见 · 排序: 快照数
```

Whitespace-only query is treated as default. Unknown values fall back to their raw value, matching existing filter-context behavior.

## Accessibility And Placement

- Static HTML includes `data-testid="device-active-filter-summary"`.
- The element uses `role="status"` and `aria-live="polite"`.
- The element is rendered as a compact line below the controls and above the management summary.
- It does not add a button, input, network action, or modal.

## V0.39 Relationship

V0.39 `device-empty-filter-context` remains in the empty-list state. V0.42 does not suppress it because that would change an existing contract. The two texts are distinguished by V0.42's `当前筛选:` prefix and by placement outside the empty state.

## Safety Boundaries

- Frontend-only read-only behavior.
- No backend API changes.
- No metadata writes.
- No `/api/devices` refetch for local filter summary changes.
- No backup, restore, sync, delete, NAS connection, NAS app invocation, or remote command.

## Qwen Adversarial Findings And PM Decisions

- Finding: V0.42 overlaps with V0.39 empty filter context.
  - Decision: partially accepted. Keep V0.39 intact and add a `当前筛选:` prefix to distinguish the always-visible summary.
- Finding: add a sort label mapping.
  - Decision: accepted as `DEVICE_FILTER_SORT_LABELS`.
- Finding: add `role="status"` or `aria-live="polite"`.
  - Decision: accepted.
- Finding: DOM tests should cover reset returning to default and no refetch.
  - Decision: accepted.

## ZAI Final Verifier Note

ZAI answered simple probes (`OK`, `4`, and `ACCEPT`) but repeatedly returned the invalid fallback phrase `I don't have a specific response` for V0.42 verification prompts, including short evidence-only and classification-style prompts. PM marked ZAI final verification as `INCONCLUSIVE` and did not use it as acceptance evidence.
