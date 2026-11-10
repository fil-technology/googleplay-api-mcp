# Google Play MCP

An [MCP](https://modelcontextprotocol.io) server for **Google Play** — the
Android sibling of [`appstore-api-mcp`](https://github.com/fil-technology/appstore-api-mcp).
It lets an AI agent ship and manage Play apps through the official
[Android Publisher API](https://developers.google.com/android-publisher):
upload builds, manage tracks and staged rollouts, edit store listings and
screenshots, manage in-app products and subscriptions, and read and reply to
reviews.

> **Status: 0.1.0, not yet verified against the live API.** Every endpoint path
> and parameter comes from Google's published API discovery document and the
> logic is unit-tested with a mocked network, but no tool has been run against
> a real Play Console account yet. Start with `doctor` and `dryRun`, and see
> [what's verified](#whats-verified).

### ✨ What makes it stand out

- **Edits handled for you.** Google Play changes happen inside an "edit"
  transaction. Each tool opens one, applies the change, validates and commits —
  and deletes it if anything fails. No dangling edits.
- **Real dry-run.** `dryRun: true` applies your change in a temporary edit, has
  *Google* validate it, then throws the edit away. You see the diff and the
  verdict; nothing is published.
- **Batch when you want to.** Open one edit, upload a build, create the release
  and swap screenshots in it, commit once — all live together.
- **Safe mode enforced by the server.** Read-only mode, plus separate switches
  for production releases, price changes, review replies and subscription
  activation.
- **Full coverage.** A `raw_request` escape hatch reaches anything without a
  dedicated tool — still subject to safe mode.

### 💬 Just ask

> "Upload `app-release.aab` and roll it out to 10% of production with these release notes."
> "Bump the production rollout to 50%." · "Halt the rollout."
> "Rewrite the short description in all 12 languages — show me the diff first."
> "Replace the German phone screenshots with the files in `./shots/de`."
> "What are this week's 1- and 2-star reviews? Draft replies."
> "Create a monthly subscription at $4.99 and convert the price for every region."

## Table of contents

- [Quick start](#quick-start)
- [Getting your service account key](#getting-your-service-account-key)
- [Configuration](#configuration)
- [Tools](#tools)
- [Common workflows](#common-workflows)
- [Field limits](#field-limits)
- [What's verified](#whats-verified)
- [Security](#security)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [License](#license)

## Quick start

You need **Node.js ≥ 18** and a Google Cloud **service account key** that has
been granted access in Play Console ([how](#getting-your-service-account-key)).

Add this to your MCP client's config:

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

Or, with Claude Code:

```bash
# --scope user installs it for ALL your projects (recommended).
# Remove the --scope user line to install for the current project only.
claude mcp add googleplay-api \
  --scope user \
  --env GOOGLE_SERVICE_ACCOUNT_JSON="$HOME/.googleplay/service-account.json" \
  -- npx -y googleplay-api-mcp
```

Then ask: **"Run the Google Play doctor for com.example.app."**

Per-client instructions (Claude Desktop, Codex, Cursor, Windsurf, VS Code, Zed,
Gemini CLI, …) are in [docs/CLIENTS.md](docs/CLIENTS.md).

## Getting your service account key

The short version — full walkthrough in [docs/SETUP.md](docs/SETUP.md):

1. **Google Cloud Console** → pick or create a project → enable the **Google
   Play Android Developer API**.
2. **IAM & Admin → Service Accounts** → create one → **Keys → Add key → JSON**.
3. **Play Console → Users and permissions → Invite new users** → paste the
   service account's email → grant it the apps and permissions it needs.

Step 3 is the one people miss: until the service account is invited in Play
Console, every call returns `403`.

## Configuration

All configuration is by environment variable. Credentials are never accepted as
tool arguments.

| Variable | Purpose |
|---|---|
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Path to the service account key file — **or** the JSON itself (inline when the value starts with `{`) |
| `GOOGLE_SERVICE_ACCOUNT_JSON_BASE64` | Base64 of the key file (handy for CI/containers) |
| `GOOGLE_APPLICATION_CREDENTIALS` | Fallback path (Google's standard variable) |
| `PLAY_MCP_SNAPSHOT_DIR` | Where `snapshot_listing` writes (default `~/.googleplay-api-mcp/snapshots`) |
| `PLAY_MCP_AUTO_SNAPSHOT` | `true` = snapshot an app's listing text before the first listing edit of a session |
| `PLAY_MCP_REGIONS_VERSION` | Regions version for subscription pricing calls (default `2022/02`) |

### Safe mode

Enforced by the server before a tool runs — not a suggestion to the model.

| Variable | Effect |
|---|---|
| `PLAY_MCP_READ_ONLY=true` | Block **all** writes |
| `PLAY_MCP_ALLOW_PRODUCTION_RELEASE=false` | Block production releases and rollout-percentage changes (halting stays allowed) |
| `PLAY_MCP_ALLOW_PRICE_CHANGES=false` | Block price changes and price migrations |
| `PLAY_MCP_ALLOW_REVIEW_REPLIES=false` | Block public review replies |
| `PLAY_MCP_ALLOW_SUBSCRIPTION_ACTIVATION=false` | Block activating/deactivating base plans and offers |

The four category flags default to *allowed*; set them to `false` to lock a
category. A blocked call fails with a message naming the flag. Details in
[docs/TOOLS.md](docs/TOOLS.md#safe-mode).

## Tools

72 tools. Full reference with parameters: [docs/TOOLS.md](docs/TOOLS.md).

| Group | Tools |
|---|---|
| **Edits** | `insert_edit` `get_edit` `validate_edit` `commit_edit` `delete_edit` |
| **Store listing** | `list_listings` `list_languages` `get_listing` `update_listing` `bulk_upsert_listings` `delete_listing` `get_app_details` `update_app_details` |
| **Images** | `list_images` `upload_image` `delete_image` `delete_all_images` `replace_images` |
| **Builds** | `upload_bundle` `upload_apk` `list_bundles` `list_apks` `upload_deobfuscation_file` `upload_internal_app_sharing` |
| **Tracks & releases** | `list_tracks` `get_track` `create_release` `promote_release` `set_rollout_fraction` `halt_rollout` `resume_rollout` `complete_rollout` `update_track` |
| **Testers & availability** | `get_testers` `update_testers` `get_country_availability` |
| **In-app products** | `list_inapp_products` `get_inapp_product` `create_inapp_product` `update_inapp_product` `delete_inapp_product` `list_one_time_products` |
| **Subscriptions** | `list_subscriptions` `get_subscription` `create_subscription` `update_subscription` `delete_subscription` `activate_base_plan` `deactivate_base_plan` `delete_base_plan` `migrate_base_plan_prices` `list_subscription_offers` `get_subscription_offer` `create_subscription_offer` `update_subscription_offer` `delete_subscription_offer` `activate_subscription_offer` `deactivate_subscription_offer` `convert_region_prices` |
| **Reviews** | `list_reviews` `get_review` `reply_to_review` |
| **Snapshots** | `snapshot_listing` `restore_listing` |
| **Reporting** *(optional API)* | `list_apps` `reporting_get_metric_set` `reporting_query_metric_set` `reporting_list_anomalies` `reporting_search_error_issues` `reporting_request` |
| **Diagnostics** | `doctor` `raw_request` |

### Coming from the App Store server?

| | App Store Connect | Google Play |
|---|---|---|
| App identifier | numeric `appId` | `packageName` (`com.example.app`) |
| Credentials | `ASC_KEY_ID` / `ASC_ISSUER_ID` / `.p8` | one service account `.json` |
| Safe-mode prefix | `APPSTORE_MCP_*` | `PLAY_MCP_*` |
| Applying changes | each call is live | changes go through an **edit**; tools auto-commit |
| Preview | `dryRun` shows a diff | `dryRun` shows a diff **and** Google validates it |
| Phased release | `set_phased_release` | `create_release` with `userFraction`, then `set_rollout_fraction` / `halt_rollout` / `complete_rollout` |
| Keywords field | yes | none — Play indexes the title and descriptions |

## Common workflows

### Ship a build

```
upload_bundle   { packageName, filePath: "/path/app-release.aab" }      → versionCode 42
create_release  { packageName, track: "internal", versionCodes: [42], status: "completed" }
promote_release { packageName, fromTrack: "internal", toTrack: "production", userFraction: 0.1 }
set_rollout_fraction { packageName, userFraction: 0.5 }
complete_rollout     { packageName }
```

Something wrong? `halt_rollout { packageName }`.

To upload and release atomically, wrap them in one edit: `insert_edit`, pass
`editId` to `upload_bundle` and `create_release`, then `commit_edit`.

### Edit the listing

```
update_listing { packageName, language: "en-US", shortDescription: "…", dryRun: true }
```

Review the diff and Google's `validation`, then run it again without `dryRun`.
For many languages at once use `bulk_upsert_listings` — one commit for all.

### Replace screenshots

```
replace_images { packageName, language: "de-DE", imageType: "phoneScreenshots",
                 files: ["/shots/de/1.png", "/shots/de/2.png"] }
```

Old ones are removed and new ones added in a single edit, so the listing never
shows a half-replaced set.

### Before a bulk rewrite

`snapshot_listing { packageName }` first; `restore_listing { file }` puts the
text back. Or set `PLAY_MCP_AUTO_SNAPSHOT=true` and it happens automatically.

### Reviews

`list_reviews { packageName, translationLanguage: "en" }`, then
`reply_to_review { packageName, reviewId, replyText, dryRun: true }` to check
the reply before it goes public.

### Anything else

`raw_request { method, path, query?, body? }` — `path` is relative to
`/androidpublisher/v3`, e.g. `/applications/com.example.app/orders/GPA.1234`.

## Field limits

| Field | Limit |
|---|---|
| Title | 30 |
| Short description | 80 |
| Full description | 4000 |
| Release notes (per language) | 500 |
| Review reply | ~350 |

Over-limit text is flagged in `_warnings` and in the dry-run diff; Google
rejects it on validate/commit. The listing limits come from Play Console Help
rather than the API reference.

## What's verified

- **From Google's discovery documents** (`androidpublisher` v3 and
  `playdeveloperreporting` v1beta1, revision 2026-11-08): every endpoint path,
  HTTP method, query parameter, enum and response field the tools use.
- **Unit-tested** (`npm test`, mocked network): service-account auth and token
  caching, error shaping, retry, paging, uploads, the edit lifecycle including
  failure cleanup, release/rollout rules, validation limits, safe-mode gating,
  and the tool registry.
- **Needs live verification:** everything, in the sense that no call has hit
  the real API. The specific open questions — large-bundle uploads, the
  validate-before-commit step, rollout body shape, `regionsVersion`, and which
  Play Console permission each tool needs — are listed in
  [docs/TOOLS.md](docs/TOOLS.md#verification-status).

The **Reporting API** tools are optional and limited to what that API offers:
Android vitals, error issues and anomalies. It has no installs, ratings or
revenue endpoints.

## Security

The service account key can change your live store presence. Use a dedicated
service account with the fewest permissions that work, keep the key file out of
any repository, and turn on safe mode where you can. Credentials are read only
from the environment, sent only to Google, and never logged. Full notes:
[docs/SECURITY.md](docs/SECURITY.md).

## Troubleshooting

Run **doctor** with a `packageName` first. The usual suspects:

- **403 on everything** — the service account hasn't been invited in Play
  Console → Users and permissions (or the grant hasn't propagated yet).
- **Server won't start** — your client is launching Node < 18.
- **`list_reviews` looks empty** — the API only returns reviews from about the
  last week, and only those with text.
- **Commit fails mentioning `changesNotSentForReview`** — pass (or remove) that
  option as the message instructs.

More in [docs/SETUP.md](docs/SETUP.md#troubleshooting).

## Development

```bash
git clone https://github.com/fil-technology/googleplay-api-mcp.git
cd googleplay-api-mcp
npm install
npm test                                   # node --test, no network, no credentials
GOOGLE_SERVICE_ACCOUNT_JSON=/path/sa.json npm start
```

Layout: `src/index.js` (tool registry + server), `src/client.js` (auth,
requests, paging, uploads), `src/edits.js` (edit lifecycle), `src/releases.js`
(release/rollout rules), `src/guardrails.js` (safe mode), `src/validation.js`
(limits + diff).

### Releasing

Publishing runs in GitHub Actions on a `v*.*.*` tag, authenticated by **npm
trusted publishing (OIDC)** — there is no `NPM_TOKEN` anywhere.

One-time setup on npmjs.com (package → Settings → Trusted Publisher → GitHub
Actions): organization `fil-technology`, repository `googleplay-api-mcp`,
workflow `npm-publish.yml`. npm currently only lets you configure a trusted
publisher for a package that already exists, so the very first version may need
a manual `npm publish --access public` from a maintainer's machine; every
release after that is tag-driven.

```bash
npm version patch          # bumps package.json + creates the tag
git push --follow-tags     # the tag triggers the publish workflow
```

The workflow refuses to publish if the tag doesn't match `package.json`, and
skips versions already on npm.

## License

MIT © Sviatoslav Fil
