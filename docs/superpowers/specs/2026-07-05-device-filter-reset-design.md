# Linke V0.40 Device Filter Reset Button Design

## Summary

V0.40 adds a Web Console device filter reset button. When clicked, it clears the active search text, resets all status and management filters to their default "all" state, resets the device sort option to name sort, and rerenders the local device view.

## Scope

- Add a button with ID and data-testid `device-filter-reset` in the Web Console device controls section in `src/web/index.html`.
- Bind a click listener in `src/web/app.js` to reset the control values and invoke local rerendering.
- Clear search (`device-search`), set status (`device-status-filter`) to `all`, set management (`device-management-filter`) to `all`, and set sort (`device-sort`) to `name`.
- Rerender device list, count, management summary active states, and empty filter context without fetching.
- Update tests in `test/web-console.test.js` and `test/readme.test.js`.
- Update README and create spec and plan docs.

## Safety Boundaries

- Client-side browser logic only.
- No backend API changes.
- No remote commands, no backups, no restores.
- No NAS connections or credential modifications.
- No local data persistence / metadata writes.
- Prevents redundant `/api/devices` HTTP network requests.

## Interaction Rules

- The reset button is always visible in the device controls area.
- Clicking reset restores:
  - `device-search` to an empty string.
  - `device-status-filter` to `all`.
  - `device-management-filter` to `all`.
  - `device-sort` to `name`.
- The reset action calls the existing local render path so device rows, `device-filter-count`, management bucket active state, and V0.39 empty filter context stay in sync.
- The reset action does not dispatch synthetic input/change events. It updates the single source of truth DOM controls and then calls the existing render function once.

## Testing Requirements

- HTML/source contract: `device-filter-reset` exists as an ID and `data-testid`, and has visible reset text.
- DOM behavior: after non-default filters create an empty result, clicking reset restores all default control values.
- DOM behavior: reset restores all four device rows and `4 / 4` count from the existing cached devices.
- DOM behavior: reset restores the management summary `all` bucket active state and clears the `visible` active state.
- Safety: `fetchCount` remains 1, proving no new `/api/devices` request during local reset.

## Worker Notes

- Qwen design adversary first produced no stdout for the waiting budget and was cancelled as `worker_inconclusive:no_stdout`.
- Qwen second short read-only diff prompt returned `PASS` with no blockers and no concerns.
- AGY implementer completed after a long silent run and returned a schema plus file changes. PM must still verify all diff and tests independently; AGY output alone is not acceptance evidence.
