# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/) and the project uses
[Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-11-10

Initial release: an MCP server for the Google Play Android Publisher API (v3),
built as a sibling of `appstore-api-mcp` with the same tool shape, dry-run
conventions and safe-mode design.

### Added
- **Auth:** Google Cloud service account via `GOOGLE_SERVICE_ACCOUNT_JSON`
  (file path or inline JSON), `GOOGLE_SERVICE_ACCOUNT_JSON_BASE64`, or
  `GOOGLE_APPLICATION_CREDENTIALS`. RS256 assertion → OAuth2 access token,
  cached in memory. The token is only ever sent to the two Google Play API
  hosts.
- **Edit model:** every edit-based tool opens an edit, applies, validates and
  commits in one call; `dryRun:true` validates in a temporary edit and deletes
  it; an optional `editId` batches several changes into one commit. Edits the
  server opens are always committed or deleted. Low-level `insert_edit`,
  `get_edit`, `validate_edit`, `commit_edit`, `delete_edit`.
- **Store listing:** `list_listings`, `list_languages`, `get_listing`,
  `update_listing`, `bulk_upsert_listings`, `delete_listing`,
  `get_app_details`, `update_app_details`, with length checks (title 30, short
  description 80, full description 4000) and old→new diffs.
- **Images:** `list_images`, `upload_image`, `delete_image`,
  `delete_all_images`, and atomic `replace_images`.
- **Builds:** `upload_bundle`, `upload_apk`, `list_bundles`, `list_apks`,
  `upload_deobfuscation_file` (R8/ProGuard mapping and native debug symbols),
  `upload_internal_app_sharing`.
- **Tracks and releases:** `list_tracks`, `get_track`, `create_release`,
  `promote_release`, `set_rollout_fraction`, `halt_rollout`, `resume_rollout`,
  `complete_rollout`, `update_track`.
- **Testers and availability:** `get_testers`, `update_testers`,
  `get_country_availability`.
- **In-app products:** `list_inapp_products`, `get_inapp_product`,
  `create_inapp_product`, `update_inapp_product`, `delete_inapp_product`, and
  read-only `list_one_time_products` for the newer one-time products API.
- **Subscriptions:** subscriptions, base plans and offers — create, read,
  update, delete, activate, deactivate — plus `migrate_base_plan_prices` and
  `convert_region_prices`.
- **Reviews:** `list_reviews`, `get_review`, `reply_to_review`.
- **Snapshots:** `snapshot_listing` / `restore_listing` for listing text, and
  `PLAY_MCP_AUTO_SNAPSHOT`.
- **Diagnostics:** `doctor` (credentials, token, access to a package, safe
  mode) and a `raw_request` escape hatch.
- **Optional Reporting API tools:** `list_apps`, `reporting_get_metric_set`,
  `reporting_query_metric_set`, `reporting_list_anomalies`,
  `reporting_search_error_issues`, `reporting_request`.
- **Safe mode:** `PLAY_MCP_READ_ONLY`, `PLAY_MCP_ALLOW_PRODUCTION_RELEASE`,
  `PLAY_MCP_ALLOW_PRICE_CHANGES`, `PLAY_MCP_ALLOW_REVIEW_REPLIES`,
  `PLAY_MCP_ALLOW_SUBSCRIPTION_ACTIVATION`. `raw_request` is held to the same
  gates by method and path.
- Docs (`README`, `docs/TOOLS.md`, `docs/SETUP.md`, `docs/SECURITY.md`,
  `docs/CLIENTS.md`), `.env.example`, unit tests (`node --test`), and a GitHub
  Actions workflow that publishes to npm on a `v*.*.*` tag via OIDC trusted
  publishing.

### Known limitations
- **Not yet verified against the live API.** Endpoint paths and parameters come
  from Google's discovery documents and the logic is unit-tested against a
  mocked network; no tool has been run against a real Play Console account.
  Open questions are listed under "Verification status" in `docs/TOOLS.md`.
- Uploads use a single in-memory request rather than the resumable protocol.
- The Reporting API offers vitals, error issues and anomalies only — there are
  no install, rating or revenue statistics tools.
- Image files are not downloaded by `snapshot_listing` and not restored by
  `restore_listing`.
