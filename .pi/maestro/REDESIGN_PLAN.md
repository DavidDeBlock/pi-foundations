# Maestro Dashboard — Complete Rewrite Plan

## 🎯 Goal
**Complete rewrite** of the current half-done `dashboard.py` prototype. Replace the rigid 2-tab layout with a **6-tab TUI system** that covers GitHub Issues, Sessions, Pipeline Monitoring, Local LLM Chat, Log Streaming, and Agent Status.

Target feel: LazyGit + k9s + htop (calm, keyboard-first, dense but uncluttered).

---

## 🏗️ Final Layout Blueprint

| Area | Width | Components |
|------|-------|------------|
| **Global Header** | 100% | Tabs: `[1] Issues` `[2] Sessions` `[3] Pipelines` `[4] Chat` `[5] Logs` `[6] Agents` |
| **Filters Bar** | 100% | `Flow ▼ Labels ▼ Status ▼ Search: [/ fuzzy...]` |
| **Left Panel** | ~60-70% | Tab-specific List View + Inline Detail/Context Panel below it |
| **Right Panel** | ~30-40% | Contextual Right Panel (Pipeline map, Agent roster, or empty when Chat is active) |

---

## 🧠 Key Design Decisions (Resolved)

1. **Stack: Python + Textual.** Reuse existing `DashboardAPI`, session parsers, and prompt templates. No new API bridges.
2. **Scope: Complete Rewrite.** The current dashboard (`dashboard.py` + stubbed panels) is discarded in favor of a clean slate.
3. **Chat = Modal Overlay.** Free-form LLM chat via RPC subprocess (`pi --mode rpc`). In-memory conversation history. Dismiss with `Esc`.
4. **Logs = JSONL Tail.** Tailing the active session log file only. No complex logging infrastructure for v1.
5. **Agents = Flow Phases.** The "Agent Team" tab renders phases from the current flow config (`builder`, `reviewer`) as statuses (`idle`/`running`/`waiting`).
6. **Pipeline Monitor = Single Active Flow.** One active flow at a time. Phase diagram shows status-based map with simple indicators (● running, ✓ done).
7. **Session Diff = File-Path Correlation.** Uses `git status --porcelain` matched against session tool call paths. No flow engine changes needed.
8. **Modals vs Inline:** Chat/Launcher/Replay are modal overlays. Issue/Sessions details and Search are inline views.

---

## 📋 Tab-by-Tab Specifications

### TAB 1: GitHub Issues (Inline)
| Component | Behavior |
|-----------|----------|
| **List** | Fetches open issues from GitHub API (`needs-triage`, `parent-prd`). Live re-fetch on filter change. |
| **Detail** | Title, body, labels, linked PRD/sessions. Recent activity timeline. |
| **Actions** | `[g] Open GitHub` (opens browser), `[s] Start Flow` (queues/starts flow). |

### TAB 2: Sessions (Inline)
| Component | Behavior |
|-----------|----------|
| **List** | Scans `.pi/maestro/sessions/`, parses JSONL via `session_reader.py`. Client-side filtering by flow/phase/model. |
| **Detail** | Flow, phase, model, duration, verdict (approved/rejected), file ops timeline. |
| **Actions** | `[l] Full Logs` (modal), `[f] Files` (inline list of touched files), `[d] Diff` (git status correlation modal), `[r] Replay` (step-through JSONL playback modal). |

### TAB 3: Pipeline Monitor (Inline)
| Component | Behavior |
|-----------|----------|
| **Overview** | Queue stats (`running`, `pending`, `completed today`). |
| **Phase Map** | Renders flow config as a status map. Simple indicators (`● running`, `✓ done`, `✗ failed`). Approximate progress bars based on elapsed time. |

### TAB 4: AI Chat (Modal Overlay)
| Component | Behavior |
|-----------|----------|
| **Prompt Input** | Sends messages to local LLM via existing RPC subprocess (`pi --mode rpc`). |
| **History** | In-memory buffer of conversation context appended each turn. |

### TAB 5: Logs (Inline/Modal)
| Component | Behavior |
|-----------|----------|
| **Stream** | Tails the active session `.jsonl` file. Renders events chronologically. |

### TAB 6: Agents (Inline)
| Component | Behavior |
|-----------|----------|
| **Roster** | Current flow phases rendered as agents (`builder`, `reviewer`). Shows status and current task/issue number. |

---

## 📋 Implementation Phases

### Phase 1: Core Layout & Tab System
- [ ] Delete old `dashboard.py` stubs, rewrite from scratch.
- [ ] Implement global tab bar (`TabbedContent`) with all 6 tabs.
- [ ] Build the Filters Bar component (Flow/Labels/Status dropdowns + `/` search).
- [ ] Set up the main horizontal split: List View (left) + Detail Panel (right).
- [ ] Wire basic data fetching to the Issues tab (reuse `DashboardAPI`).

### Phase 2: Issue & Session Tabs
- [ ] Implement pure list components for Issues and Sessions.
- [ ] Build the `SharedDetailView` widget to dynamically render issue or session details based on selection.
- [ ] Wire up Session list to scan local directory + parse JSONL metadata.
- [ ] Add context-aware bottom action bar (only shows actionable keys when relevant).

### Phase 3: Pipeline, Agents & Logs Tabs
- [ ] Implement the Pipeline tab with a simple status-based phase map.
- [ ] Build the Agents tab by reading current flow config and active session state.
- [ ] Add Log tailing functionality to read/parse the active `.jsonl` file in real-time.

### Phase 4: Modal Overlays & Advanced Features
- [ ] **Chat Modal:** Integrate RPC subprocess for free-form LLM chat with history buffer.
- [ ] **Pipeline Launcher Modal:** Flow/model selection dialog triggered by `[s] Start Flow`.
- [ ] **Session Replay Modal:** Step-through animation of `.jsonl` events.
- [ ] **Session Diff Modal:** `git status --porcelain` correlation view for session file changes.

---

## 📁 Files to Modify/Create
| File | Action | Purpose |
|------|--------|---------|
| `.pi/maestro/dashboard.py` | **Rewrite** | Complete new layout, tab system, modal handling, data polling wiring |
| `.pi/maestro/panels/issues_panel.py` | **Edit** | Pure list component (remove detail drawer) |
| `.pi/maestro/panels/session_browser_panel.py` | **Edit** | Pure list component with client-side filtering |
| `.pi/maestro/panels/shared_detail_view.py` | **Keep/Edit** | Dynamic detail renderer for issues/sessions |
| `.pi/maestro/panels/live_monitor_panel.py` | **Edit** | Pipeline phase map and queue stats |
| `.pi/maestro/panels/agent_roster_panel.py` | **Create** | Flow phases rendered as agent statuses |
| `.pi/maestro/panels/log_tailer.py` | **Create** | Real-time JSONL file tailing widget |
| `.pi/maestro/panels/chat_modal.py` | **Create** | Modal overlay for free-form LLM chat via RPC |
| `.pi/maestro/panels/pipeline_launcher.py` | **Create** | Modal dialog to select flow/model before starting |

---

## ✅ Acceptance Criteria
- [ ] Dashboard loads with a 6-tab layout (Issues, Sessions, Pipelines, Chat, Logs, Agents).
- [ ] Issues and Sessions tabs show clickable lists that populate the right-side detail panel.
- [ ] Pipeline tab shows a visual status map of the current flow phases.
- [ ] Chat opens as a modal overlay using the existing RPC subprocess mechanism.
- [ ] Logs tab tails the active session JSONL file in real-time.
- [ ] Agents tab correctly reflects the phases of the currently running flow.
- [ ] Bottom action bar is context-aware (only shows relevant keys for the selected item/tab).
- [ ] Auto-refresh continues working for issues and sessions without blocking UI events.
- [ ] No layout breakage on terminal resize.
- [ ] All existing Maestro functionality preserved (filtering, date filters, status dropdowns).

---

## 📘 Textual Framework Implementation Guide

*Extracted from official `Textualize/textual` documentation to guide the rewrite.*

### 🔑 Core Patterns Mapping

| Concept | Textual API | How It Maps to Your Plan |
|---------|-------------|--------------------------|
| **App Structure** | `class MyApp(App)`, `compose()`, `on_mount()` | Single entry point, replace old `dashboard.py` |
| **Layouts** | `Horizontal`, `Vertical`, `Grid`, `dock:` CSS | 6-tab header, filters bar, left/right split panels |
| **Tabs** | `TabbedContent` + `TabPane(id=...)` | 6 tabs: Issues, Sessions, Pipelines, Chat, Logs, Agents |
| **Lists/Tables** | `DataTable` (keys, row selection) or `OptionList` | Issue list, Session list, Agent roster |
| **Background Polling** | `@work(exclusive=True)` decorator or `run_worker()` | GitHub API polling, JSONL log tailing, session refresh |
| **Modals** | `ModalScreen[T]`, `push_screen()`, `dismiss(value)` | Chat overlay, Pipeline Launcher, Session Replay/Diff modals |
| **Reactive State** | `reactive(default)`, `watch_()` methods | Active tab, selected item, filter values, UI updates |
| **Keybindings** | `BINDINGS = [("key", "action", "label")]` | Context-aware bottom bar (`[g] Open GitHub`, `[s] Start Flow`) |

### 🏗️ Phase 1: Core Layout & Tab System

#### 1.1 Global Header + Filters Bar
Use **docked widgets** for sticky positioning. They stay fixed while the rest scrolls.
```python
from textual.containers import Horizontal, Vertical

class DashboardScreen(Screen):
    def compose(self) -> ComposeResult:
        yield Header()  # Built-in title bar
        
        with Horizontal(id="filters-bar"):
            yield Select.from_values([...], id="flow-filter")
            yield Input(placeholder="Search: [/]...", id="search-input")
```

#### 1.2 Tab System (`TabbedContent`)
Each tab gets an `id` so you can switch programmatically or read `.active`.
```python
from textual.widgets import TabbedContent, TabPane

with TabbedContent(initial="issues", id="main-tabs"):
    with TabPane("Issues", id="issues"):
        yield DataTable(id="issue-table")
    # ... repeat for all 6 tabs
```
- Switch tabs programmatically: `self.query_one(TabbedContent).active = "chat"`
- Listen to tab changes: `def on_tabbed_content_tab_activated(self, message)`

#### 1.3 Left/Right Split Layout
Use **Horizontal** container with CSS `fr` units for proportional sizing.
```python
with Horizontal(id="main-split"):
    yield DataTable(id="list-view")      # ~65% width
    yield Vertical(id="detail-panel")    # ~35% width
```
CSS: `#main-split { layout: horizontal; } #list-view { width: 65fr; } #detail-panel { width: 35fr; }`

### 📊 Phase 2: Issue & Session Tabs (Lists + Details)

#### 2.1 DataTable for Lists
Use `DataTable` with **row keys** tied to your domain IDs (GitHub issue number, session UUID).
```python
table = self.query_one(DataTable)
table.add_columns("Title", "Labels", "Status")
for issue in issues:
    table.add_row(issue.title, ", ".join(issue.labels), issue.status, key=issue.id)

def on_data_table_row_selected(self, message):
    selected_id = message.row_key
    self._render_detail(selected_id)
```

#### 2.2 Shared Detail View
Use a reactive attribute to drive dynamic rendering in the right panel.
```python
from textual.reactive import reactive

class SharedDetailView(Vertical):
    selected_item = reactive(None, watch=True)
    
    def watch_selected_item(self, item: dict | None) -> None:
        self.clear()
        if item is None:
            self.mount(Label("Select an item"))
        elif item["type"] == "issue":
            self._render_issue_detail(item)
```

#### 2.3 Client-Side Filtering (Sessions)
Filter in-memory after loading JSONL metadata. Use `reactive` filters that trigger table re-population.
```python
flow_filter = reactive("")
def watch_flow_filter(self, value: str) -> None:
    self._refresh_session_table()  # Re-query DataTable rows with filter applied
```

### 🔄 Phase 3: Pipeline, Agents & Logs (Background Workers)

#### 3.1 Non-Blocking Polling (`@work`)
Use the `@work(exclusive=True)` decorator for API calls and file tailing. This keeps the UI responsive.
```python
from textual import work

class IssuesPanel(Vertical):
    @work(exclusive=True)
    async def fetch_issues(self) -> None:
        issues = await self.api.get_open_issues()  # httpx call
        self._update_issue_table(issues)
    
    def on_mount(self) -> None:
        self.fetch_issues()
```

#### 3.2 Log Tailing (JSONL)
Read the active `.jsonl` file incrementally using a worker that polls for new lines.
```python
@work(exclusive=True)
async def tail_logs(self, filepath: Path) -> None:
    with open(filepath) as f:
        f.seek(0, 2)  # Seek to end
        while not self._stop_tailing:
            line = f.readline()
            if line:
                self.post_message(LogEvent(line))  # Thread-safe UI update
            await asyncio.sleep(0.5)
```

#### 3.3 Pipeline & Agents Tabs
- **Pipeline**: Render flow config phases as a `DataTable` or custom widget with status indicators (`● running`, `✓ done`). Update via `@work` polling of active flow state.
- **Agents**: Read current flow config + active session state. Map phases to agent statuses. Use reactive attributes that update when the active flow changes.

### 🎭 Phase 4: Modal Overlays & Advanced Features

#### 4.1 Chat Modal (RPC Subprocess)
Use `ModalScreen` — it automatically dims the background and blocks input to screens beneath it.
```python
from textual.screen import ModalScreen

class ChatModal(ModalScreen[str]):
    def compose(self) -> ComposeResult:
        yield TextArea(id="chat-history")
        yield Input(placeholder="Type message...", id="prompt-input")
        yield Button("Send", id="send-btn")

    @on(Button.Pressed, "#send-btn")
    async def send_message(self) -> None:
        prompt = self.query_one(Input).value
        response = await self.app.rpc_subprocess(prompt)
        self.query_one(TextArea).append_text(f"User: {prompt}\nAI: {response}\n")

# Trigger from Issues tab [s] or global keybinding
self.push_screen(ChatModal())
```

#### 4.2 Returning Data from Modals
Use `dismiss(value)` to return results back to the caller.
```python
class PipelineLauncher(ModalScreen[dict | None]):
    @on(Button.Pressed, "#launch-btn")
    def launch(self) -> None:
        self.dismiss({"flow": selected_flow})  # Pops screen + returns dict

# Caller waits for result (must be in a worker or async context):
result = await self.push_screen_wait(PipelineLauncher())
if result: start_flow(result["flow"])
```

#### 4.3 Context-Aware Footer/Action Bar
Use `BINDINGS` with `check_action()` to hide/disable keys when they don't apply.
```python
class DashboardScreen(Screen):
    BINDINGS = [
        Binding("g", "open_github", "Open GitHub"),
        Binding("s", "start_flow", "Start Flow"),
    ]
    
    def check_action(self, name: str, parameters: tuple) -> bool | None | False:
        if name == "open_github" and self.selected_item is None:
            return None  # Show dimmed in footer (unavailable)
        if name == "start_flow" and not self.is_issue_tab_active():
            return False  # Hide entirely
        return True
```

### 📋 Implementation Checklist (Mapped to Docs)

| Plan Task | Textual Concept | Doc Reference |
|-----------|----------------|---------------|
| Delete old `dashboard.py`, rewrite from scratch | `class MaestroApp(App)` + `compose()` | `docs/guide/app.md` |
| Global tab bar (`TabbedContent`) | `TabPane(id=...)`, `.active` reactive | `docs/widgets/tabbed_content.md` |
| Filters Bar (dropdowns + search) | `Select`, `Input`, `Horizontal` container | Widget gallery, Layout guide |
| Horizontal split: List + Detail Panel | `Horizontal` with `width: Xfr;` CSS | `docs/guide/layout.md` |
| Issue/Sessions pure lists | `DataTable.add_row(key=...)`, `RowSelected` event | `docs/widgets/data_table.md` |
| SharedDetailView dynamic render | `reactive(selected_item, watch=True)` | `docs/guide/reactivity.md` |
| Session list scan + JSONL parse | `@work()` background worker | `docs/guide/workers.md` |
| Pipeline phase map | Custom widget or DataTable with status columns | Layout + Reactivity |
| Agents roster (flow phases) | Reactive attributes synced to flow state | Reactivity guide |
| Log tailing (`jsonl`) | `@work()` polling file handle, `post_message()` | Workers guide |
| Chat Modal overlay | `ModalScreen[str]`, `push_screen()`, `dismiss()` | `docs/guide/screens.md` |
| Pipeline Launcher modal | `ModalScreen[dict]`, `push_screen_wait()` | Screens guide (Returning data) |
| Session Replay/Diff modals | Same `ModalScreen` pattern, step-through animation via `set_interval()` | Workers + Reactivity |
| Context-aware bottom action bar | `BINDINGS` + `check_action()` returning `True/False/None` | `docs/guide/actions.md` |
| Terminal resize handling | Textual handles this automatically; use `on_resize()` if custom logic needed | Layout guide (`overflow-y: auto`) |

### 🚀 Quick Start Skeleton

```python
# .pi/maestro/dashboard.py
from textual.app import App, ComposeResult
from textual.containers import Horizontal, Vertical
from textual.widgets import Header, Footer, TabbedContent, DataTable
from textual.reactive import reactive

class MaestroApp(App):
    TITLE = "Maestro Dashboard"
    
    active_tab = reactive("issues")
    selected_item: dict | None = reactive(None)
    
    CSS = """
    Screen { layout: vertical; }
    #filters-bar { height: 3; dock: top; }
    #main-split { layout: horizontal; height: 1fr; }
    #list-view { width: 65%; }
    #detail-panel { width: 35%; }
    TabbedContent > .tab--label { text-style: bold; }
    """
    
    def compose(self) -> ComposeResult:
        yield Header()
        with Horizontal(id="filters-bar"):
            pass  # Flow ▼ Labels ▼ Status ▼ Search
        with TabbedContent(initial="issues", id="tabs"):
            with TabPane("Issues", id="issues"):
                with Horizontal():
                    yield DataTable(id="issue-table")
                    yield Vertical(id="detail-panel")
            # ... other tabs
    
    def on_tabbed_content_tab_activated(self, message):
        self.active_tab = message.tab.id

BINDINGS = [("q", "quit", "Quit")]

if __name__ == "__main__":
    MaestroApp().run()
```

This gives you the structural foundation. All remaining pieces (data fetching, modal logic, JSONL tailing) plug into this skeleton using the patterns above.
