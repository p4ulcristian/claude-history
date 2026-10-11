# Claude History

A small launcher-style window for [Omarchy](https://omarchy.org/) that lists every
[Claude Code](https://claude.com/claude-code) session on your machine. Press a key, type a few
words, hit Enter, and the session resumes in a terminal in the folder it belongs to.

- Full-text search across your prompts and Claude's replies, in every project folder.
- Folder and date badges on each session, and as one-click filters.
- Read a whole transcript inside the widget, with search matches highlighted.
- Splits sessions you typed ("Mine") from ones started through the SDK by scripts and bots ("Agents").
- Everything stays local: the server listens on `127.0.0.1` only and the index is a SQLite file in
  `~/.local/share/claude-history/`.

## Keys

| Key | Action |
|---|---|
| type | search |
| ↑ / ↓, PageUp / PageDown | move the selection |
| Enter | resume the session in a terminal and close the widget |
| Tab, or click | read the transcript (Tab or Esc to go back, `n` / `p` for next / previous match) |
| Esc | back, then clear the search, then close |

## How it works

`server.ts` is a single [Bun](https://bun.sh) process. It reads the transcripts Claude Code keeps in
`~/.claude/projects/*/*.jsonl`, stores the text of prompts and replies in SQLite FTS5 (tool output is
skipped), and serves `public/index.html`. Only new or changed transcripts are re-read, so the first
index takes a few seconds and later opens are instant. The index mirrors what is on disk: when
Claude Code cleans up an old transcript (30 days by default, see `cleanupPeriodDays`), it leaves the
list too.

`bin/claude-history-open` opens the page as a chromeless browser window with
`omarchy-launch-webapp`, focuses it if it is already open, and closes it if it already has focus.

## Requirements

Omarchy with its Lua Hyprland config (`o.bind`, `o.window`, `hl.dsp.*` dispatchers), plus `bun`,
`jq` and a Chromium-based browser. Resume uses `uwsm-app` and `xdg-terminal-exec`, both part of
Omarchy.

## Install

```bash
git clone https://github.com/p4ulcristian/claude-history ~/Work/claude-history
cd ~/Work/claude-history

# Check the paths in claude-history.service (repo location, bun, claude), then:
systemctl --user enable --now "$PWD/claude-history.service"
```

Bind a key in `~/.config/hypr/bindings.lua`:

```lua
o.bind("SUPER + A", "Claude history", "/home/YOU/Work/claude-history/bin/claude-history-open")
```

Make the window a small centered widget in `~/.config/hypr/hyprland.lua`:

```lua
o.window({ class = "^chrome-claude-history\\.localhost__.*" }, {
  float = true,
  center = true,
  size = { 720, 460 },
})
```

Then `hyprctl reload`.

## Settings

Environment variables for the service (for example in a systemd drop-in):

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `4470` | Port to listen on. Change it in `bin/claude-history-open` too. |
| `CLAUDE_HISTORY_RESUME_ARGS` | empty | Extra flags for the resumed `claude`, space separated. |
