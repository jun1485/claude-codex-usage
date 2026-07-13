# AI Usage Meter

Shows Claude Code and Codex CLI rate-limit usage (5-hour / weekly windows) in the VS Code status bar.

![Claude and Codex usage in the VS Code status bar](assets/screenshots/statusbar.png)

Hover any item for a full breakdown:

![Claude Code usage details](assets/screenshots/claude-tooltip.png)

![Codex CLI usage details](assets/screenshots/codex-tooltip.png)

## What you see

- Claude: `✳ 5h 7% (2d 5h)` — 5-hour window usage + time until the weekly reset
- Codex: `⬡ 7d 12% (6d 1h)` — weekly window usage + time until reset
- Hover for details: 5-hour / weekly / per-model usage bars, reset times, and plan
- Background turns orange at 80% usage and red at 95% (thresholds configurable)
- Click for a quick menu: toggle Claude/Codex on or off, open settings, or refresh

## Data sources

| Tool | Source | How |
|---|---|---|
| Claude Code | OAuth token from `~/.claude/.credentials.json` | Queries the Anthropic usage API (every 60s, configurable) |
| Codex CLI | Session logs in `~/.codex/sessions/**/*.jsonl` | Parses the latest `rate_limits` event (updates instantly via file watching) |

Tokens and usage data stay on your machine. Nothing is sent anywhere except the official Anthropic usage API.

## Settings

| Setting | Default | Description |
|---|---|---|
| `claudeCodexUsage.refreshIntervalSeconds` | `60` | Refresh interval in seconds |
| `claudeCodexUsage.displayMode` | `compact` | `compact`: 5-hour usage only / `full`: all windows |
| `claudeCodexUsage.warningThreshold` | `80` | Orange warning background threshold (%) |
| `claudeCodexUsage.errorThreshold` | `95` | Red error background threshold (%) |
| `claudeCodexUsage.claude.enabled` | `true` | Show Claude usage |
| `claudeCodexUsage.codex.enabled` | `true` | Show Codex usage |
| `claudeCodexUsage.claude.credentialsPath` | `""` | Override Claude credentials file path |
| `claudeCodexUsage.codex.sessionsPath` | `""` | Override Codex sessions directory |

## Requirements

- Logged in to Claude Code (run `claude`, then `/login`)
- Codex CLI usage history (session logs must exist for Codex data to appear)

## Known limitations

- If the Claude token has expired, running Claude Code once renews it automatically.
- Codex usage comes from session logs, so new data appears only when Codex runs (changes are picked up immediately).

## Localization

English by default; Korean (한국어) and Chinese (简体中文 / 繁體中文) UI when the VS Code display language matches.
