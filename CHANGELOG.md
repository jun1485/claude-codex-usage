# Change Log

## 0.3.1 — 2026-07-18

- Marketplace listing tuned for search: "Monitor" added to the display name, AI category added, low-value keywords replaced (ccusage, usage tracker, claude/codex limit, token usage)
- Extension description rewritten so key search phrases (Claude usage, Codex usage monitor, rate limits) appear verbatim; Korean and Chinese translations updated
- README title and introduction aligned with the listing

## 0.3.0 — 2026-07-16

- Claude credentials fall back to the macOS Keychain when the credentials file is absent
- Codex session watching now works on Linux (VS Code file watcher instead of recursive fs.watch)
- Codex reset times are computed from the log timestamp; windows already past their reset show 0%
- Claude 429 backoff honors the Retry-After header; expired tokens skip the network call
- Claude stale-data cache resets when the credentials path setting changes
- Codex session scan reads only the newest log files (faster with large histories)
- Refresh pauses while the window is unfocused and resumes on focus
- Status bar shows a loading indicator until the first fetch completes
- Status bar items hide automatically when a tool is not installed
- Tooltip marks usage windows above the warning/error thresholds
- Warning severity now matches the rounded percent shown in the status bar
- Bundled with esbuild; ESLint, Prettier, CI workflow, and pre-release tests added
- CI runs on Linux, Windows, and macOS; release workflow guards tag/version mismatch and is safely re-runnable
- Marketplace metrics: previous-snapshot lookup now paginates issue comments

## 0.2.0

- Marketplace title, description, keywords, categories, and listing links improved for Claude Code and Codex usage searches
- README title and introduction aligned with the Marketplace listing
- Open VSX distribution and install links added for Cursor, Windsurf, and VSCodium
- Weekly Marketplace search rank, install, rating, and review tracking added
- Status bar reset time matched to each displayed usage window
- Claude 429 backoff, request timeout, stale-data notice, and refresh deduplication added
- Codex session watcher automatically reconnects when the sessions directory appears later
- Warning and error thresholds constrained to a valid order within 0–100
- Core regression tests added

## 0.1.9

- Settings order: warning threshold, then error threshold, then refresh interval

## 0.1.8

- Claude User-Agent version is detected from the local CLI
- Tooltip shows a mini usage bar per window

## 0.1.7

- Codex usage refreshes immediately when session logs change (file watching)

## 0.1.6

- Simplified / Traditional Chinese localization

## 0.1.5

- Status bar click now opens a quick menu with Claude/Codex on-off toggles, settings, and refresh

## 0.1.4

- Default orange (warning) threshold changed from 90% to 80%

## 0.1.3

- Default red (error) threshold changed from 98% to 95%

## 0.1.2

- Clicking the status bar item now opens the extension settings

## 0.1.1

- English UI by default, Korean localization when VS Code display language is Korean

## 0.1.0

- Claude Code usage (5-hour / weekly / per-model) in the status bar
- Codex CLI usage (from session logs) in the status bar
- Orange / red background highlight at 90% / 98% usage
- Configurable refresh interval, display format, and thresholds
