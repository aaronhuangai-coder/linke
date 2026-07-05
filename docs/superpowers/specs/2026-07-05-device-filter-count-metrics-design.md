# Linke V0.45 Device Filter Count Metrics Design

## Summary

V0.45 extends the existing Web Console `device-filter-count` state metadata with explicit read-only count metrics. The visible text remains `visible / total`, `data-filtered` keeps the V0.44 narrowed-list state, and two new attributes expose the normalized numbers used for rendering:

- `data-visible-count`
- `data-total-count`

This gives tests, future UI hooks, and automation a stable way to read the count values without parsing text.

## Scope

- Extend `buildDeviceFilterCountState(visibleCount, totalCount)` to return normalized `visible` and `total` numbers in addition to `text` and `filtered`.
- Add `data-visible-count="0"` and `data-total-count="0"` to the static `device-filter-count` element.
- Sync `textContent`, `data-filtered`, `data-visible-count`, and `data-total-count` through the existing `renderDeviceFilterCount()` path.
- Update tests and README documentation for V0.45.

## Behavior

Default count:

```js
buildDeviceFilterCountState(3, 3) === {
  text: '3 / 3',
  filtered: false,
  visible: 3,
  total: 3,
}
```

Filtered count:

```js
buildDeviceFilterCountState(1, 3) === {
  text: '1 / 3',
  filtered: true,
  visible: 1,
  total: 3,
}
```

Empty count:

```js
buildDeviceFilterCountState(0, 0) === {
  text: '0 / 0',
  filtered: false,
  visible: 0,
  total: 0,
}
```

Non-finite inputs normalize to `0`, matching the current V0.44 text behavior.

## Accessibility

V0.45 does not add `aria-live` to `device-filter-count`. V0.43 already uses `device-active-filter-summary` for filter-change announcements, and V0.44 intentionally avoided a duplicate live region. The new count attributes are machine-readable state, not user-facing announcement text.

## Safety Boundaries

- Frontend-only read-only behavior.
- No backend API changes.
- No metadata writes.
- No new `/api/devices` refetch for local filter changes.
- No backup, restore, sync, delete, NAS connection, NAS app invocation, or remote command.

## Resilience Gate

Normal state: the loaded device array is rendered once from `/api/devices`, then local filters update the count text and four count attributes.

Recovery anchor: the existing reset button returns local controls to defaults and re-renders from the already loaded device array.

Bounded failure: non-finite count inputs normalize to `0`; no exception should escape from count rendering.

Detection and self-check: unit tests validate normalized helper output, DOM tests validate search/status/management/reset transitions, and HTTP smoke checks confirm static assets expose the V0.45 hooks.

## Acceptance Criteria

- Static HTML starts `device-filter-count` with `data-filtered="false"`, `data-visible-count="0"`, and `data-total-count="0"`.
- `buildDeviceFilterCountState()` returns `{ text, filtered, visible, total }` with normalized numeric values.
- `renderDeviceFilterCount()` updates both count attributes whenever the count text changes.
- Search, status, management, and reset flows update `data-visible-count` and `data-total-count` without refetching `/api/devices`.
- README states V0.45 is current and documents the no-API/no-refetch/no-write safety boundary.

## Qwen Adversarial Findings And PM Decisions

- Finding: the plan must list all existing pure-function cases, not only representative examples.
  - Decision: accepted. The plan now requires V0.45 expectations for finite, empty, NaN, Infinity, undefined/null, and string inputs.
- Finding: README tests need concrete migration instructions for V0.44 historical status and V0.45 current status.
  - Decision: accepted. The plan now calls out the V0.44 historical row and a new V0.45 README describe block.
- Finding: DOM test migration must define every transition point, not only say to repeat checks.
  - Decision: accepted. The plan now lists initial/search/reset/status/reset/management/reset expected values.
- Finding: the test coverage line should include the new V0.45 device filter count metrics wording.
  - Decision: accepted. README tests must assert `测试覆盖：.*设备筛选计数指标`.
