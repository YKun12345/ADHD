# Patient Web Safe Migration Design

## Objective

Restore the original patient desktop Web experience as an active part of the ADHD AB repository, keep the existing doctor Web and mini-program applications intact, remove only the mini-program's simple reaction-time task, and fix the draggable mini-program AI copilot trigger so a normal tap always works.

## Confirmed product decisions

- Preserve the archived patient Web visual design, copy, layout, page structure, assessments, tracking, report, achievement system, clinical pathway, and AI presentation.
- Do not require strict feature parity between Web and mini-program clients.
- Keep the doctor Web as the full desktop workflow for imaging, HGST inference, visualization, and DAC auditing.
- Keep the mini-program as the mobile patient and doctor workflow.
- Remove only `simple_reaction` from the active mini-program experience. The other six cognitive tasks remain unchanged.
- Preserve backend compatibility with historical `simple_reaction` records so existing databases and reports do not fail.
- Fix the mini-program's draggable floating AI copilot without changing its appearance or removing drag-and-snap behavior.

## Architecture

### Patient Web

Create a new active `patient-web/` directory from `archive/legacy-patient-web/`. The 26 archived patient HTML, CSS, and JavaScript files remain content-equivalent to the archived originals. Add the original patient-capable login assets from the source Web project and an `index.html` entry point.

The only login behavior adaptation is routing authenticated researchers to the active `/doctor-web/` application while patient logins continue into the legacy patient home page. This change is navigation-only and does not alter the patient Web appearance.

Mount `patient-web/` explicitly at `/patient-web` with FastAPI `StaticFiles`. Do not restore the old root-directory static mount. Repository internals, `backend/`, `archive/`, `miniprogram/`, environment files, databases, and uploads remain unreachable through static HTTP paths.

The patient Web API client continues to use same-origin `/api/v1` requests. Web, mini-program, and doctor Web therefore share the same authentication service, users, patients, and business database.

### Simple reaction-time removal

Remove the `pages/simple-reaction` mini-program page, its task utility, and all active navigation/configuration references. Update the cognitive center, battery sequence, result cards, AI page configuration, app page registration, and relevant mini-program tests to describe six active cognitive tasks.

Keep backend canonicalization, report fallback logic, and compatibility tests for `simple_reaction`. Historical rows remain readable. The active mini-program will no longer expose or submit this task. Obsolete local-storage cleanup keys may remain so upgrades still remove stale pending data safely.

### Floating AI copilot fix

The current draggable trigger sets `_suppressNextTap` at drag end and assumes the runtime will emit a synthetic tap immediately afterward. When that tap is not emitted, the flag survives and consumes the next real tap.

Replace this cross-event assumption with deterministic touch handling:

- a touch end without movement opens or closes the panel directly;
- a drag touch end snaps and stores the position without opening the panel;
- a touch cancel clears drag state without opening the panel;
- the stale `_suppressNextTap` mechanism is removed;
- navigation buttons inside the expanded panel retain their existing behavior.

The visual size, position, drag threshold, stored position format, panel design, and AI destinations remain unchanged.

## Data and security boundaries

- All patient business APIs remain protected by bearer-token and role checks in the backend.
- Patient Web assets contain no patient records; protected data is fetched only after authenticated API calls.
- No second user store or database is introduced.
- Existing patient Web local-only drafts, achievements, and copilot display history remain local, matching the legacy behavior.
- Backend historical data is never deleted by removing the mini-program task.
- Docker includes the new active `patient-web/` directory because only `archive/` remains excluded.
- External CDN references in the legacy patient Web remain unchanged to preserve the original page implementation.

## Error handling

- Failed authentication stays on the login page and displays the existing login feedback.
- A researcher using the restored shared login is routed to `/doctor-web/doctor_analysis.html`.
- API authentication failures do not expose protected response data.
- Failed AI navigation keeps the existing toast and resets the navigation lock.
- A canceled copilot touch never opens the panel or leaves stale drag state.

## Verification strategy

Implementation follows test-driven development.

1. Add failing structural and HTTP tests proving `/patient-web/` is active while repository-internal paths remain unavailable.
2. Add failing preservation tests comparing the 26 active patient assets with the archived originals.
3. Add failing mini-program tests proving `simple_reaction` has no active page, card, battery step, report card, or AI page configuration.
4. Retain backend tests proving historical `simple_reaction` data remains readable.
5. Add a failing copilot component test reproducing a drag with no synthetic tap followed by a real tap, plus tap and touch-cancel cases.
6. Run the full mini-program, backend, Web dependency, cleanliness, JavaScript syntax, Python compilation, and HTTP smoke suites.

## Acceptance criteria

- `/patient-web/` opens the original patient Web login experience.
- Patient login reaches the original patient home and uses the current backend.
- Researcher login reaches the active doctor Web.
- The 26 migrated patient assets are content-equivalent to their archived sources.
- `/backend/`, `/archive/`, and `/miniprogram/` are not exposed over HTTP.
- The mini-program contains exactly the remaining six cognitive tasks and no active simple reaction-time route.
- Historical `simple_reaction` backend data remains valid and readable.
- A normal tap on the draggable AI copilot opens it immediately, including after a completed drag.
- Dragging still moves and snaps the copilot without accidentally opening it.
- Existing doctor Web and remaining mini-program workflows pass their regression suites.
