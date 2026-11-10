# Using with different MCP clients

The server is a standard **stdio** MCP server, so it works with any MCP client.
Every client needs the same three things:

- **command:** `npx`
- **args:** `["-y", "googleplay-api-mcp"]`
- **env:** `GOOGLE_SERVICE_ACCOUNT_JSON` = absolute path to your service account
  key (see [SETUP.md](SETUP.md))

The canonical block:

```json
{
  "mcpServers": {
    "googleplay-api": {
      "command": "npx",
      "args": ["-y", "googleplay-api-mcp"],
      "env": {
        "GOOGLE_SERVICE_ACCOUNT_JSON": "/absolute/path/to/service-account.json"
      }
    }
  }
}
```

It sits happily next to `appstore-api-mcp` — the two servers share conventions
(tool shape, dry-run, safe mode) but not credentials.

---

## Claude Code (CLI)

```bash
# --scope user installs it for ALL your projects (recommended).
# Remove the --scope user line to install for the current project only.
claude mcp add googleplay-api \
  --scope user \
  --env GOOGLE_SERVICE_ACCOUNT_JSON="$HOME/.googleplay/service-account.json" \
  -- npx -y googleplay-api-mcp
```

## Claude Desktop

`~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or
`%APPDATA%\Claude\claude_desktop_config.json` (Windows) — paste the canonical
block, then restart the app.

## OpenAI Codex CLI

`~/.codex/config.toml`:

```toml
[mcp_servers.googleplay-api]
command = "npx"
args = ["-y", "googleplay-api-mcp"]

[mcp_servers.googleplay-api.env]
GOOGLE_SERVICE_ACCOUNT_JSON = "/absolute/path/to/service-account.json"
```

## Cursor

`~/.cursor/mcp.json` (all projects) or `.cursor/mcp.json` (one project) — the
canonical block.

## Cline (VS Code extension)

MCP Servers → Configure → paste the canonical block.

## Windsurf (Codeium)

`~/.codeium/windsurf/mcp_config.json` — the canonical block.

## VS Code (native MCP / Copilot agent mode)

`.vscode/mcp.json` — note the top-level key is `servers`:

```json
{
  "servers": {
    "googleplay-api": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "googleplay-api-mcp"],
      "env": {
        "GOOGLE_SERVICE_ACCOUNT_JSON": "/absolute/path/to/service-account.json"
      }
    }
  }
}
```

## Zed

`settings.json`:

```json
{
  "context_servers": {
    "googleplay-api": {
      "command": {
        "path": "npx",
        "args": ["-y", "googleplay-api-mcp"],
        "env": {
          "GOOGLE_SERVICE_ACCOUNT_JSON": "/absolute/path/to/service-account.json"
        }
      }
    }
  }
}
```

## Gemini CLI

`~/.gemini/settings.json` — the canonical block.

## Any other MCP client / custom agent

Spawn `npx -y googleplay-api-mcp` as a stdio subprocess with
`GOOGLE_SERVICE_ACCOUNT_JSON` in its environment and speak MCP over
stdin/stdout.

### Notes that apply to every client

- Use an **absolute path** to the key — `~` is not expanded inside JSON.
- The server needs **Node ≥ 18**. If your client finds an older Node first,
  set `command` to an absolute path to a modern `npx`.
- Add safe-mode variables (`PLAY_MCP_READ_ONLY`, `PLAY_MCP_ALLOW_*`) to the same
  `env` block.
- After changing config, restart the client (or reload its MCP servers).
- First thing to run: **doctor** with one of your package names.
