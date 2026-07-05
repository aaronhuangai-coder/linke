# Linke V0.43 Device Active Filter Summary State Design

## Summary

V0.43 adds explicit state metadata to the existing Web Console `device-active-filter-summary`. The summary keeps the same visible text as V0.42 while exposing whether the current device controls are default or active.

## Scope

- Export `buildDeviceActiveFilterSummaryState(controls)` as a pure helper.
- Keep `buildDeviceActiveFilterSummary(controls)` as the source of visible text.
- Add `data-active="false"` and `aria-atomic="true"` to the static summary element.
- Sync `textContent` and `data-active` through the existing `renderFilteredDevices()` path.
- Add scoped CSS for `.device-active-filter-summary[data-active="true"]`.
- Update README, tests, and plan docs.

## Behavior

Default controls:

```text
query: empty or whitespace
status: all
management: all
sort: name
```

Default state:

```js
{
  text: '默认筛选',
  active: false
}
```

Active state example:

```js
{
  text: '当前筛选: 搜索: Beta · 状态: 在线 · 管理态: 在线可见 · 排序: 快照数',
  active: true
}
```

`buildDeviceActiveFilterSummaryState(controls)` must call `buildDeviceActiveFilterSummary(controls)` to generate `text`; it must not duplicate the summary formatting logic.

## Accessibility

The summary keeps V0.42's `role="status"` and `aria-live="polite"` behavior. V0.43 adds `aria-atomic="true"` so assistive technology can treat the summary as one live-region update.

PM rejected adding `aria-label` in this version. Qwen flagged a risk that `aria-label` plus `aria-live="polite"` could create duplicate or confusing announcements. The visible text remains the accessible live-region content.

## Styling

Only this selector may style the active summary state:

```css
.device-active-filter-summary[data-active="true"]
```

Do not use a bare `[data-active="true"]` selector because reset buttons and management summary buckets already use `data-active`.

## Safety Boundaries

- Frontend-only read-only behavior.
- No backend API changes.
- No metadata writes.
- No `/api/devices` refetch for local summary state changes.
- No backup, restore, sync, delete, NAS connection, NAS app invocation, or remote command.

## Qwen Adversarial Findings And PM Decisions

- Finding: a new state helper could duplicate `buildDeviceActiveFilterSummary` logic.
  - Decision: accepted. The state helper must compose the existing text helper.
- Finding: static HTML must include the new default state.
  - Decision: accepted as `data-active="false"` plus `aria-atomic="true"`.
- Finding: `aria-label` may conflict with `role="status"` and `aria-live="polite"`.
  - Decision: accepted. V0.43 does not add `aria-label`.
- Finding: CSS must not use a bare `[data-active="true"]` selector.
  - Decision: accepted. Active styling must be scoped to `.device-active-filter-summary[data-active="true"]`.
- Finding: tests must cover helper composition, static state, DOM active/default transitions, and no refetch.
  - Decision: accepted.
