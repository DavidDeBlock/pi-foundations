# Tmux Cheatsheet

## Quick Reference — Prefix Key: `Ctrl+b` (default)

All commands are pressed as a **sequence**: press prefix, release it, then press the key.

---

### Session Management

| Action | Keys |
|--------|------|
| New session | `Ctrl+b` then `:` → `new-session -s name` |
| List sessions | `Ctrl+b` then `s` |
| Rename current session | `Ctrl+b` then `$` |
| Kill session | `Ctrl+b` then `&` (confirm) or `:kill-session` |

### Window Management (one window = one tab)

| Action | Keys |
|--------|------|
| New window | `Ctrl+b` then `c` |
| Next window | `Ctrl+b` then `n` |
| Previous window | `Ctrl+b` then `p` |
| List windows | `Ctrl+b` then `w` |
| Go to window by number | `Ctrl+b` then `<number>` |
| Rename current window | `Ctrl+b` then `,` |
| Move window to position | `Ctrl+b` then `M-<number>` (Shift+number) |
| Rearrange windows interactively | `Ctrl+b` then `q`, then type the number |

### Pane Management (split a window into panes)

| Action | Keys |
|--------|------|
| Split vertically (side-by-side) | `Ctrl+b` then `%` |
| Split horizontally (stacked) | `Ctrl+b` then `"` |
| Close current pane | `Ctrl+b` then `x` (confirm) or `Ctrl+d` |
| Next pane | `Ctrl+b` then `o` |
| Swap panes | `Ctrl+b` then `{` or `}` |
| Enter copy mode to select text | `Ctrl+b` then `[` |
| Zoom/restore current pane | `Ctrl+b` then `z` |

### Resizing Panes

| Action | Keys |
|--------|------|
| Resize with arrows | `Ctrl+b` then `↑` / `↓` / `←` / `→` (hold for multi-step) |
| Resize by 5 cells | `Ctrl+b` then `Alt+↑` / `↓` / `←` / `→` |

### Copy Mode (vi-style — requires `set -g mode-keys vi`)

| Action | Keys |
|--------|------|
| Enter copy mode | `Ctrl+b` then `[` |
| Move cursor | `h` `j` `k` `l` or arrow keys |
| Jump to word start/end | `w` / `e` / `b` |
| Page up/down | `PageUp` / `PageDown` |
| Start selection | Space (then move to extend) |
| Copy selection | `Enter` |
| Paste buffer | `Ctrl+b` then `]` |

---

## Useful Commands (prefix + `:` then type)

```
new-session -s name        # create session named "name"
ls                         # list sessions
switch-client -t name      # switch to session
kill-session -t name       # kill a specific session
rename-window title        # rename current window
respawn-pane -k            # restart pane (keeps output)
set-option <key> <value>   # change setting
show-options -g            # show all global settings
```

---

## Recommended `.tmux.conf` Snippet

```bash
# Use vi keys in copy mode
set -g mode-keys vi

# Faster prefix key release detection
set -s escape-time 0

# Enable mouse support (select, resize, scroll)
set -g mouse on

# Set status bar
set -g status-position bottom
set -g status-style "bg=#282c34,fg=grey"
setw -g window-status-current-style "bg=blue,fg=white,bold"

# Reload config without restart
bind r source-file ~/.tmux.conf \; display "Config reloaded!"
```

---

## Common Patterns

### Start a session with named windows and panes

```bash
tmux new-session -s myproject -n editor -d
tmux send-keys -t myproject:editor 'nvim' Enter
tmux split-window -h -t myproject:0
tmux send-keys -t myproject:1 'npm run dev' Enter
tmux select-pane -t myproject:0
tmux attach -t myproject
```

### Detach / Reattach

| Action | Keys |
|--------|------|
| Detach from session | `Ctrl+b` then `d` |
| Reattach to last session | `tmux attach` or `tmux a` |
| Reattach to specific session | `tmux attach -t name` |

---

## Tips

- **Prefix key**: If you don't like `Ctrl+b`, change it in `.tmux.conf`:
  ```bash
  set -g prefix C-a          # use Ctrl+a instead
  unbind C-b                 # remove old binding
  bind C-a send-prefix       # allow double-press to send literal Ctrl+a
  ```

- **Copy mode**: `Ctrl+b` + `[` enters copy mode. Press `?` inside copy mode for help.

- **Scrollback**: With mouse on, you can scroll in panes. Without mouse, use copy mode (`[`), then arrow keys or vi keys to navigate.

- **Sync panes** (send same keystrokes to all panes):
  ```bash
  setw -g synchronize-panes on   # turn on
  setw -g synchronize-panes off  # turn off
  ```
