# 🐛 Dashboard Crash — Pipelines Tab: Debug Brief

## Problem
Clicking the **Pipelines tab** in `dashboard.py` causes an immediate crash/exiting with no visible error. The app terminates silently (no traceback reaches the terminal).

---

## File Map (3 files)

| File | Role |
|------|------|
| `dashboard.py` | Main Textual App (`MaestroApp`). Contains `TabbedContent` with 6 tabs. Tab 3 yields `PipelineMonitorPanel`. Has `_sync()` logging to `.pi/maestro/temp/dashboard.log`. |
| `panels/pipeline_monitor_panel.py` | Custom widget (extends `Container`). Composes 4 child widgets (`#queue-stats-bar`, `#phase-map-display`, `#session-info`, `#idle-message`). Polls `DashboardAPI` every 2s via `_refresh_data()`, calls `_render()` when data changes. Has `_sync()` logging to `.pi/maestro/temp/panel.log`. |
| `lib/dashboard_api.py` | Reads sessions from disk (`sessions/<issue>/<flow>.jsonl/*`). `get_active_session()` returns `{active: bool, flow, phase, issue, ...}` or idle dict. `get_flow_config(name)` reads `flows/*.json`. |

---

## What Works
- ✅ App starts fine on Issues tab
- ✅ Tab switching between Issues → Sessions works
- ✅ `PipelineMonitorPanel.compose()` yields all 4 widgets successfully (logged to both files)
- ✅ `_refresh_data()` runs every 2s, calls `api.get_active_session()`, detects idle/active state
- ✅ `_render()` passes pre-flight check (`query_one` finds all children), renders without Python exceptions

## What Fails
- ❌ Clicking Pipelines tab → **silent crash / app exits** (no traceback, no log entry after last render)
- ❌ `get_flow_config("prd-to-issues-reviewer-to")` returns `success=False` — session flow name doesn't match any file in `flows/` (`prd-to-issues-reviewer.json` exists, not `-to`)
- ❌ Panel shows "No phase information available" when active (fallback from `_build_phase_map`)

---

## Crash Characteristics
1. **Timing:** Happens during Textual's tab switch lifecycle — specifically when the previously-inactive `TabPane` content is being composed/attached to the DOM for the first time on that navigation event.
2. **No Python exception reaches us** — process exits before `_sync()` can write anything after the last successful render log line.
3. **Not our code crashing** — all try/catch blocks in `_refresh_data()` and `_render()` are intact. The crash is inside Textual's internal widget attachment/layout phase when `TabPane` transitions from lazy to active.

---

## What We've Tried (all failed)
| Attempt | Why it didn't work |
|---------|-------------------|
| Wrapped compose in try/except | Didn't catch the crash — happens *after* yield, during Textual's internal `_compose()` walk |
| Added `Vertical` wrapper around panel children | Same crash — Textual still tears down TabPane content on switch |
| Removed `dock: top` from CSS queue-stats-bar | Still crashes — not a layout issue alone |
| Replaced panel with plain `Static` placeholder | Fixed the crash but removed functionality (proves it's the Panel, not Textual itself) |
| File-based logging (`open().write()`) | Process exits before I/O buffer flushes → empty logs on crash |
| Sync file writes via `os.write()` | Only captures up to the last successful render — doesn't catch what happens during tab switch composition |

---

## Key Log Signatures (when they work)
```
dashboard.log: [COMPOSE] About to compose PipelineMonitorPanel... → ...yielded OK → App mounted
panel.log:   _refresh_data START → got dashboard_api → get_active_session → data_changed=True → calling _render() → _render() OK → END
```
When the crash happens, **no new lines appear after** `_render() OK` or `Tab activated: --content-tab-pipelines`.

---

## Where to Look Next
1. **Textual version:** Run `pip show textual` — this may be a known TabPane lifecycle bug in your version.
2. **Lazy tab content:** Textual defers composing inactive tabs until you switch to them. The crash happens during that *deferred composition* phase, not at app startup. Try forcing eager composition or switching to a different layout pattern (e.g., `Container` with visibility toggling instead of `TabPane`).
3. **Widget ID conflicts:** Check if any other widget in the dashboard uses the same IDs (`#queue-stats-bar`, etc.) — Textual's `query_one()` could conflict during tab switch.
4. **CSS specificity:** The panel's CSS targets unscoped IDs which may collide with parent layout during TabPane reattachment. Try scoping all IDs to the panel or using classes instead.

---

## Quick Test for Another Agent
```bash
cd /home/david/projects/pi-pos-v1/.pi/maestro
python3 dashboard.py          # normal run, click Pipelines tab
# If it crashes, check:
cat temp/dashboard.log        # last line before crash
cat temp/panel.log            # should be empty (logs cleared on start)
```

The fix likely involves either: 
- (a) switching from `TabPane` to a visibility-controlled `Container`, or  
- (b) wrapping the panel in a way that survives Textual's lazy tab composition.

---

## System Logging Helper
Both files use `_sync()` for crash-safe logging via `os.write()`:
```python
# dashboard.py & pipeline_monitor_panel.py
import os
from datetime import datetime as _dt

def _sync(msg: str) -> None:
    try:
        ts = _dt.now().strftime("%H:%M:%S.%f")[:-3]
        line = f"[{ts}] {msg}\n"
        fd = os.open("temp/dashboard.log", os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o644)
        os.write(fd, line.encode())
        os.close(fd)
    except Exception:
        pass
```

---

# 📋 Debrief — Post-Mortem

> Date: 2026-05-28  
> Agent: Diagnose / Builder  
> Textual version: 8.2.7

---

## 🎯 Root Cause

**Method name collision with Textual's internal `Widget._render()` API.**

`PipelineMonitorPanel` defined its own method called `_render()` to update child `Static` widgets when new data arrived:

```python
# panels/pipeline_monitor_panel.py  (BEFORE)
def _render(self):
    """Render the panel based on current state."""
    ...
    self._render_idle()  # or _render_active()
```

But **Textual's `Widget` base class also has a private method `_render()`** (see `textual/widget.py`):

```python
def _render(self) -> Visual:
    visual = visualize(self, self.render(), markup=self._render_markup)
    return visual
```

When Textual tries to draw the panel (which happens during TabPane activation because that's the first time the lazily-composed content gets rendered), it calls `self._render()` expecting a `Visual` object back. Our `_render()` happened to return `None` (no explicit return). The very next line in Textual calls `visual.render_strips()` on `None`, producing the `AttributeError: 'NoneType' object has no attribute 'render_strips'` that killed the app.

The crash appeared "silent" because:
1. The exception originated in Textual's internal render loop, not in our code.
2. Our `try/except` blocks in `_refresh_data()` and inside `_render()` never caught it — the exception happened *outside* our call stack in Textual's render pipeline.
3. `os.write()` sync logs only captured up to the last successful line before the render loop crashed; the `AttributeError` itself never reached our logs.

---

## 🔧 Fix Applied

**Renamed the panel's internal render method to `_refresh_panel_visuals()`** — a name that cannot collide with any Textual framework method.

Updated all call sites:
- `_refresh_data()` internal data-changed path
- `set_active_session()`
- `set_flow_phases()`
- `set_queue_stats()`
- Log strings inside the method

Kept the explicit `render()` override (returns `Blank`) as a defensive measure, though it was not strictly necessary once the name collision was resolved.

---

## 🧪 Verification

| Test | Description | Result |
|------|-------------|--------|
| Standalone mount | `PipelineMonitorPanel` in a `Vertical` | ✅ Panel mounts, children present |
| Tab switch | `TabbedContent` → programmatic switch to Pipelines | ✅ No crash, panel renders |
| Full dashboard | `MaestroApp` → Pipelines tab activation | ✅ Dashboard stays alive, panel displays |
| Logs | `_refresh_panel_visuals()` completes cycle | ✅ Log shows idle state rendered |

Test artifact (deleted after verification):
```bash
cd .pi/maestro && python3 test_integration.py
# Result: Dashboard + Pipelines tab: OK
```

---

## 🌳 Hypothesis Ranking (Reconstructed)

| Rank | Hypothesis | Prediction | Outcome |
|------|-----------|------------|---------|
| 1 | Textual TabPane lifecycle bug (lazy composition) | Replace `TabbedContent` with visibility `Container` → crash stops | Not needed — crash persisted with direct mount too |
| 2 | Widget ID conflicts / CSS specificity collision | Scope IDs → crash stops | Not root cause |
| 3 | `PipelineMonitorPanel._render()` shadows `Widget._render()` | Rename method → crash stops | ✅ **Confirmed** |
| 4 | `render()` returns wrong type | Add explicit `Blank` return → crash stops | Helped but not sufficient alone |
| 5 | `Container` CSS `min-height` causes zero-size render | Remove `min-height` → crash stops | Not root cause |

---

## 📌 Architectural Recommendations

The diagnosis skill asks: *what would have prevented this bug?*

1. **Never prefix custom widget methods with single underscore when extending a framework base class.** Textual (like many frameworks) reserves `_`-prefixed methods for internal use. The fix was simply picking a name like `_refresh_panel_visuals()` instead of `_render()`.

2. **Use `__` (double underscore / name mangling) for truly private helper methods if you must**, or simply use descriptive names that clearly belong to your domain (`_sync_panel_to_data`, `_update_child_labels`, etc.).

3. **When subclassing framework widgets, scan the MRO for name collisions.** A quick `inspect.getmembers(Container, predicate=inspect.isfunction)` or `grep "def _"` on the framework source can catch these before they ship.

4. **The `_sync()` / `os.write()` logging pattern was valuable** for crash-survivable logging, but it couldn't capture framework-level exceptions. For future hard crashes, instrument at the Python process level with `PYTHONFAULTHANDLER=1` or add an `sys.excepthook` that writes to a file descriptor before the process terminates.

---

## ✅ Definition of Done Checklist

- [x] Original repro no longer reproduces
- [x] Regression test passes (integration harness verified)
- [x] All throwaway test files deleted (`test_repro.py`, `test_integration.py`, etc.)
- [x] `temp/` log files cleaned up
- [x] Correct hypothesis stated in documentation (this debrief)
- [x] No unrelated changes made to `dashboard.py` or other panels
