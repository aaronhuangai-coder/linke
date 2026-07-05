# Linke V0.44 Device Filter Count State Design

## Summary

V0.44 adds explicit state metadata to the existing Web Console `device-filter-count`. The visible count remains `visible / total`, while a new `data-filtered` attribute marks whether the rendered list is currently narrowed by the active controls.

## Scope

- Export `buildDeviceFilterCountState(visibleCount, totalCount)` as a pure helper.
- Keep the visible text format exactly as `"<visible> / <total>"`.
- Add `data-filtered="false"` to the static `device-filter-count` element.
- Sync `textContent` and `data-filtered` through the existing `renderFilteredDevices()` path.
- Add scoped CSS for `.device-filter-count[data-filtered="true"]`.
- Update README, tests, and plan docs.

## Behavior

Default count:

```js
buildDeviceFilterCountState(3, 3) === {
  text: '3 / 3',
  filtered: false,
}
```

Filtered count:

```js
buildDeviceFilterCountState(1, 3) === {
  text: '1 / 3',
  filtered: true,
}
```

Empty count:

```js
buildDeviceFilterCountState(0, 0) === {
  text: '0 / 0',
  filtered: false,
}
```

`filtered` means the visible device count is lower than the total loaded device count. It does not mean that a control value is active; V0.43 already exposes active control state through `device-active-filter-summary`.

## Accessibility

V0.44 does not add a second live region. V0.43 already made `device-active-filter-summary` the live status text for filter changes. Adding `aria-live` to `device-filter-count` could create duplicate announcements, so this version only exposes state metadata and visual styling.

## Styling

Only this selector may style the filtered count state:

```css
.device-filter-count[data-filtered="true"]
```

Do not use a bare `[data-filtered="true"]` selector.

## Safety Boundaries

- Frontend-only read-only behavior.
- No backend API changes.
- No metadata writes.
- No `/api/devices` refetch for local count state changes.
- No backup, restore, sync, delete, NAS connection, NAS app invocation, or remote command.

## Acceptance Criteria

- Static HTML starts `device-filter-count` with `data-filtered="false"`.
- Static HTML tests must match the `device-filter-count` element itself before checking attributes.
- `renderDeviceFilterCount()` sets both count text and `data-filtered`.
- Search, status, management, and reset flows update `data-filtered` without refetching `/api/devices`.
- README states V0.44 is current and documents the no-API/no-refetch/no-write safety boundary.

## Qwen Adversarial Findings And PM Decisions

- Finding: `filtered` is distinct from V0.43 `active`; controls can be active while all devices still match.
  - Decision: accepted. V0.44 keeps `filtered = total > 0 && visible < total`.
- Finding: omitting a second live region is defensible because V0.43 already announces filter changes through `device-active-filter-summary`.
  - Decision: accepted. V0.44 does not add `aria-live` to `device-filter-count`.
- Finding: static HTML tests must target the exact `device-filter-count` element.
  - Decision: accepted. Tests must use a targeted element match, not a broad `html.includes`.
- Finding: README must move V0.43 from `当前版本` to a historical row and add V0.44 as current.
  - Decision: accepted.
