# Tool reference

Every tool the server exposes, with parameters. You normally don't call these
by hand — you ask the model in plain language and it picks the right ones. This
is for when you want the exact contract.

All tools return JSON (pretty-printed text). Apps are addressed by
**`packageName`** (e.g. `com.example.app`). Required params are marked
**(required)**. Tools marked **write** change Google Play state and obey
[safe mode](#safe-mode); everything else is read-only.

---

## The edit model

Unlike most APIs, Google Play applies listing, image, build, track and tester
changes inside an **edit** — a transaction you open, mutate and commit.

**You usually don't need to think about it.** Every tool in those groups runs
its own edit:

| Call | What happens |
|---|---|
| `update_listing({...})` | insert edit → apply → validate → **commit** |
| `update_listing({..., dryRun: true})` | insert edit → apply → validate → **delete** (nothing published) |
| `update_listing({..., editId})` | apply inside *your* open edit — **not** committed |

If any step fails, the edit is deleted and the error says so. The server never
leaves an edit it opened dangling.

**Batching.** To make several changes go live together (say, a new build, a
release and new screenshots), open one edit and pass its id around:

```
insert_edit            → { editId }
upload_bundle          { editId, ... }
create_release         { editId, ... }
replace_images         { editId, ... }
validate_edit          { editId }        # optional dry run
commit_edit            { editId }        # or delete_edit to discard
```

**Reads** of edit-scoped data (`get_listing`, `list_images`, `get_track`, …)
open a temporary edit and delete it again. They change nothing and work in
read-only mode. Pass `editId` to read your own uncommitted changes instead.

**Not in edits:** in-app products, subscriptions, offers, review replies and
Internal App Sharing take effect immediately.

## Dry-run mode

- **Edit-based tools** — `dryRun: true` applies the change in a temporary edit,
  asks Google to validate it, then deletes the edit. You get the diff
  (`changes`: old → new, length, limit), local `_warnings`, and Google's verdict
  in `validation` (`{ ok: true }` or `{ ok: false, error }`).
- **`update_inapp_product`, `update_subscription`, `reply_to_review`** — these
  have no server-side validate call, so `dryRun: true` reads the current state
  and returns the diff without writing.

## Safe mode

Set in the server's environment; enforced before a tool runs.

| Variable | Effect |
|---|---|
| `PLAY_MCP_READ_ONLY=true` | Blocks every **write** tool and every non-GET `raw_request` (dry-runs included). |
| `PLAY_MCP_ALLOW_PRODUCTION_RELEASE=false` | Blocks `create_release`, `update_track`, `promote_release` (to production), `set_rollout_fraction`, `resume_rollout`, `complete_rollout` on `production` / `*:production` tracks. `halt_rollout` stays available. |
| `PLAY_MCP_ALLOW_PRICE_CHANGES=false` | Blocks `migrate_base_plan_prices`, `update_inapp_product` when it carries `defaultPrice`/`prices`, `update_subscription` when it touches `basePlans`. |
| `PLAY_MCP_ALLOW_REVIEW_REPLIES=false` | Blocks `reply_to_review`. |
| `PLAY_MCP_ALLOW_SUBSCRIPTION_ACTIVATION=false` | Blocks `activate_base_plan`, `deactivate_base_plan`, `activate_subscription_offer`, `deactivate_subscription_offer`. |

The category flags default to **allowed**. `raw_request` is matched against the
same categories by path, so it can't be used to sidestep a gate. A blocked call
returns `Error: Blocked: … (FLAG=false). Set FLAG=true to allow it.`

## Field limits

| Field | Limit | Source |
|---|---|---|
| `title` | 30 | Play Console Help |
| `shortDescription` | 80 | Play Console Help |
| `fullDescription` | 4000 | Play Console Help |
| release notes (per language) | 500 | Play Console Help |
| review reply | ~350 | API reference (`reviews.reply`) |
| image upload | 15 MB | API discovery document |

Over-limit text produces a `_warnings` entry rather than a hard stop; Google
rejects it on validate/commit.

---

## Edits (low-level sessions)

Most tools open, validate and commit their own edit. Use these only to batch several changes into one commit — see [The edit model](#the-edit-model).

### `insert_edit` — write
Open a new edit (Google Play's transaction) for an app and return its editId. Use this only to BATCH several changes: pass the editId to the mutation tools, then call commit_edit once. Most tools open, validate and commit their own edit automatically, so you rarely need this. Always finish with commit_edit or delete_edit.
- `packageName` **(required)** — Application id (package name), e.g. com.example.app

### `get_edit`
Check that an edit is still open/valid and when it expires. Read-only.
- `packageName` **(required)** — Application id (package name), e.g. com.example.app
- `editId` **(required)**

### `validate_edit` — write
Validate an open edit WITHOUT committing — Google runs the same checks as a commit and reports any problem. The Play-native dry run for a batched session.
- `packageName` **(required)** — Application id (package name), e.g. com.example.app
- `editId` **(required)**

### `commit_edit` — write
Commit an open edit: every change made in it goes live (or to review) atomically. The editId is consumed. If the edit contains production-track changes they were already checked against safe mode when they were added.
- `packageName` **(required)** — Application id (package name), e.g. com.example.app
- `editId` **(required)**
- `changesNotSentForReview` — Commit option: keep the changes out of review until sent from Play Console. Google requires this for some apps and rejects it for others — set it only if a commit error asks for it.
- `changesInReviewBehavior` — What to do if changes are already in review (default CANCEL_IN_REVIEW_AND_SUBMIT)

### `delete_edit` — write
Discard an open edit and every uncommitted change in it. Nothing is published.
- `packageName` **(required)** — Application id (package name), e.g. com.example.app
- `editId` **(required)**

---

## Store listing — title, descriptions, details

### `list_listings`
List the store listing (title, shortDescription, fullDescription, video) for every language of an app. Read-only.
- `packageName` **(required)** — Application id (package name), e.g. com.example.app
- `editId` — Optional: read from this open edit (to see uncommitted changes). Without it a temporary edit is opened and deleted.

### `list_languages`
List the languages an app's store listing is localized into, plus the default language. Read-only.
- `packageName` **(required)** — Application id (package name), e.g. com.example.app
- `editId` — Optional: read from this open edit (to see uncommitted changes). Without it a temporary edit is opened and deleted.

### `get_listing`
Read one language's store listing. Read-only.
- `packageName` **(required)** — Application id (package name), e.g. com.example.app
- `language` **(required)** — BCP-47 language tag, e.g. en-US, de-DE
- `editId` — Optional: read from this open edit (to see uncommitted changes). Without it a temporary edit is opened and deleted.

### `update_listing` — write
Update the store listing TITLE, SHORT DESCRIPTION, FULL DESCRIPTION or promo video for one language (creates the language if it doesn't exist yet). Only include the fields you want to change. Opens an edit, applies, validates and commits in one call. Set dryRun:true to preview the diff (old→new + length checks) and have Google validate it without publishing anything.
- `packageName` **(required)** — Application id (package name), e.g. com.example.app
- `language` **(required)** — BCP-47 language tag, e.g. en-US, de-DE
- `title` — App title (max 30 chars)
- `shortDescription` — Short description (max 80 chars)
- `fullDescription` — Full description (max 4000 chars)
- `video` — YouTube URL of the promo video
- `editId` — Optional: an open edit from insert_edit. The change is applied inside that edit and NOT committed — batch several changes, then call commit_edit.
- `dryRun` — Preview only: open a temporary edit, apply, validate, then delete it. Nothing is published (default false). Ignored when editId is set.
- `changesNotSentForReview` — Commit option: keep the changes out of review until sent from Play Console. Google requires this for some apps and rejects it for others — set it only if a commit error asks for it.

### `bulk_upsert_listings` — write
Create or update store listings for MANY languages in one atomic edit. Pass listings as { 'en-US': { title, shortDescription, fullDescription, video }, 'de-DE': {...} }. Existing languages are patched (only given fields change); new ones are created. All languages go live together or not at all. Set dryRun:true to preview every diff and validate without publishing.
- `packageName` **(required)** — Application id (package name), e.g. com.example.app
- `listings` **(required)** — Map of language → { title?, shortDescription?, fullDescription?, video? }
- `editId` — Optional: an open edit from insert_edit. The change is applied inside that edit and NOT committed — batch several changes, then call commit_edit.
- `dryRun` — Preview only: open a temporary edit, apply, validate, then delete it. Nothing is published (default false). Ignored when editId is set.
- `changesNotSentForReview` — Commit option: keep the changes out of review until sent from Play Console. Google requires this for some apps and rejects it for others — set it only if a commit error asks for it.

### `delete_listing` — write
Delete one language's store listing (the default language cannot be deleted). Set dryRun:true to validate without publishing.
- `packageName` **(required)** — Application id (package name), e.g. com.example.app
- `language` **(required)** — BCP-47 language tag, e.g. en-US, de-DE
- `editId` — Optional: an open edit from insert_edit. The change is applied inside that edit and NOT committed — batch several changes, then call commit_edit.
- `dryRun` — Preview only: open a temporary edit, apply, validate, then delete it. Nothing is published (default false). Ignored when editId is set.
- `changesNotSentForReview` — Commit option: keep the changes out of review until sent from Play Console. Google requires this for some apps and rejects it for others — set it only if a commit error asks for it.

### `get_app_details`
Read app-level details: defaultLanguage and the public contact email / phone / website. Read-only.
- `packageName` **(required)** — Application id (package name), e.g. com.example.app
- `editId` — Optional: read from this open edit (to see uncommitted changes). Without it a temporary edit is opened and deleted.

### `update_app_details` — write
Update app-level details: defaultLanguage, contactEmail, contactPhone, contactWebsite. Only include the fields you want to change. Set dryRun:true to preview the diff without publishing.
- `packageName` **(required)** — Application id (package name), e.g. com.example.app
- `defaultLanguage` — BCP-47, e.g. en-US
- `contactEmail`
- `contactPhone`
- `contactWebsite`
- `editId` — Optional: an open edit from insert_edit. The change is applied inside that edit and NOT committed — batch several changes, then call commit_edit.
- `dryRun` — Preview only: open a temporary edit, apply, validate, then delete it. Nothing is published (default false). Ignored when editId is set.
- `changesNotSentForReview` — Commit option: keep the changes out of review until sent from Play Console. Google requires this for some apps and rejects it for others — set it only if a commit error asks for it.

---

## Images and screenshots

`imageType` is one of `icon`, `featureGraphic`, `phoneScreenshots`, `sevenInchScreenshots`, `tenInchScreenshots`, `tvBanner`, `tvScreenshots`, `wearScreenshots`. Files are local PNG/JPEG paths.

### `list_images`
List the images of one type for one language (id, sha256, preview url). Omit imageType to list every type. Read-only.
- `packageName` **(required)** — Application id (package name), e.g. com.example.app
- `language` **(required)** — BCP-47 language tag, e.g. en-US, de-DE
- `imageType` — `icon`, `featureGraphic`, `phoneScreenshots`, `sevenInchScreenshots`, `tenInchScreenshots`, `tvBanner`, `tvScreenshots`, `wearScreenshots`
- `editId` — Optional: read from this open edit (to see uncommitted changes). Without it a temporary edit is opened and deleted.

### `upload_image` — write
Upload one PNG/JPEG image (icon, featureGraphic, tvBanner or a screenshot) for a language. Screenshots are appended; icon / featureGraphic / tvBanner hold a single image and are replaced. filePath is a local file. Set dryRun:true to validate without publishing.
- `packageName` **(required)** — Application id (package name), e.g. com.example.app
- `language` **(required)** — BCP-47 language tag, e.g. en-US, de-DE
- `imageType` **(required)** — `icon`, `featureGraphic`, `phoneScreenshots`, `sevenInchScreenshots`, `tenInchScreenshots`, `tvBanner`, `tvScreenshots`, `wearScreenshots`
- `filePath` **(required)** — Absolute path to a local PNG or JPEG
- `editId` — Optional: an open edit from insert_edit. The change is applied inside that edit and NOT committed — batch several changes, then call commit_edit.
- `dryRun` — Preview only: open a temporary edit, apply, validate, then delete it. Nothing is published (default false). Ignored when editId is set.
- `changesNotSentForReview` — Commit option: keep the changes out of review until sent from Play Console. Google requires this for some apps and rejects it for others — set it only if a commit error asks for it.

### `delete_image` — write
Delete one image by id (from list_images). Set dryRun:true to validate without publishing.
- `packageName` **(required)** — Application id (package name), e.g. com.example.app
- `language` **(required)** — BCP-47 language tag, e.g. en-US, de-DE
- `imageType` **(required)** — `icon`, `featureGraphic`, `phoneScreenshots`, `sevenInchScreenshots`, `tenInchScreenshots`, `tvBanner`, `tvScreenshots`, `wearScreenshots`
- `imageId` **(required)**
- `editId` — Optional: an open edit from insert_edit. The change is applied inside that edit and NOT committed — batch several changes, then call commit_edit.
- `dryRun` — Preview only: open a temporary edit, apply, validate, then delete it. Nothing is published (default false). Ignored when editId is set.
- `changesNotSentForReview` — Commit option: keep the changes out of review until sent from Play Console. Google requires this for some apps and rejects it for others — set it only if a commit error asks for it.

### `delete_all_images` — write
Delete ALL images of one type for one language. Set dryRun:true to validate without publishing.
- `packageName` **(required)** — Application id (package name), e.g. com.example.app
- `language` **(required)** — BCP-47 language tag, e.g. en-US, de-DE
- `imageType` **(required)** — `icon`, `featureGraphic`, `phoneScreenshots`, `sevenInchScreenshots`, `tenInchScreenshots`, `tvBanner`, `tvScreenshots`, `wearScreenshots`
- `editId` — Optional: an open edit from insert_edit. The change is applied inside that edit and NOT committed — batch several changes, then call commit_edit.
- `dryRun` — Preview only: open a temporary edit, apply, validate, then delete it. Nothing is published (default false). Ignored when editId is set.
- `changesNotSentForReview` — Commit option: keep the changes out of review until sent from Play Console. Google requires this for some apps and rejects it for others — set it only if a commit error asks for it.

### `replace_images` — write
Replace the whole set of images of one type for one language: delete the existing ones and upload `files` in the given order — atomically, in one edit, so the listing never shows a half-replaced set. Set dryRun:true to upload into a temporary edit, validate and discard.
- `packageName` **(required)** — Application id (package name), e.g. com.example.app
- `language` **(required)** — BCP-47 language tag, e.g. en-US, de-DE
- `imageType` **(required)** — `icon`, `featureGraphic`, `phoneScreenshots`, `sevenInchScreenshots`, `tenInchScreenshots`, `tvBanner`, `tvScreenshots`, `wearScreenshots`
- `files` **(required)** — Absolute paths to local PNG/JPEG files, in display order
- `editId` — Optional: an open edit from insert_edit. The change is applied inside that edit and NOT committed — batch several changes, then call commit_edit.
- `dryRun` — Preview only: open a temporary edit, apply, validate, then delete it. Nothing is published (default false). Ignored when editId is set.
- `changesNotSentForReview` — Commit option: keep the changes out of review until sent from Play Console. Google requires this for some apps and rejects it for others — set it only if a commit error asks for it.

---

## Builds

### `upload_bundle` — write
Upload an Android App Bundle (.aab). Returns its versionCode — pass that to create_release to put it on a track. By default the upload is committed on its own (the bundle then sits in the app's library, unreleased); pass an editId to upload and release in the same edit. Set dryRun:true to have Google validate the bundle and discard it.
- `packageName` **(required)** — Application id (package name), e.g. com.example.app
- `filePath` **(required)** — Absolute path to the .aab
- `ackBundleInstallationWarning` — Acknowledge the warning for bundles whose install size may be too large
- `deviceTierConfigId` — Optional device tier config id (or 'LATEST')
- `editId` — Optional: an open edit from insert_edit. The change is applied inside that edit and NOT committed — batch several changes, then call commit_edit.
- `dryRun` — Preview only: open a temporary edit, apply, validate, then delete it. Nothing is published (default false). Ignored when editId is set.
- `changesNotSentForReview` — Commit option: keep the changes out of review until sent from Play Console. Google requires this for some apps and rejects it for others — set it only if a commit error asks for it.

### `upload_apk` — write
Upload an APK (.apk). Returns its versionCode for create_release. New apps must use bundles (upload_bundle); APK upload is for apps that still ship APKs. Set dryRun:true to validate and discard.
- `packageName` **(required)** — Application id (package name), e.g. com.example.app
- `filePath` **(required)** — Absolute path to the .apk
- `editId` — Optional: an open edit from insert_edit. The change is applied inside that edit and NOT committed — batch several changes, then call commit_edit.
- `dryRun` — Preview only: open a temporary edit, apply, validate, then delete it. Nothing is published (default false). Ignored when editId is set.
- `changesNotSentForReview` — Commit option: keep the changes out of review until sent from Play Console. Google requires this for some apps and rejects it for others — set it only if a commit error asks for it.

### `list_bundles`
List the app bundles uploaded for an app (versionCode, sha1, sha256). Read-only.
- `packageName` **(required)** — Application id (package name), e.g. com.example.app
- `editId` — Optional: read from this open edit (to see uncommitted changes). Without it a temporary edit is opened and deleted.

### `list_apks`
List the APKs uploaded for an app (versionCode, binary hashes). Read-only.
- `packageName` **(required)** — Application id (package name), e.g. com.example.app
- `editId` — Optional: read from this open edit (to see uncommitted changes). Without it a temporary edit is opened and deleted.

### `upload_deobfuscation_file` — write
Upload crash-symbolication files for a build: an R8/ProGuard mapping.txt (fileType 'proguard') or a native debug symbols .zip (fileType 'nativeCode'). versionCode is the build the file belongs to.
- `packageName` **(required)** — Application id (package name), e.g. com.example.app
- `versionCode` **(required)**
- `fileType` **(required)** — `proguard`, `nativeCode`
- `filePath` **(required)** — Absolute path to mapping.txt or the symbols .zip
- `editId` — Optional: an open edit from insert_edit. The change is applied inside that edit and NOT committed — batch several changes, then call commit_edit.
- `dryRun` — Preview only: open a temporary edit, apply, validate, then delete it. Nothing is published (default false). Ignored when editId is set.
- `changesNotSentForReview` — Commit option: keep the changes out of review until sent from Play Console. Google requires this for some apps and rejects it for others — set it only if a commit error asks for it.

### `upload_internal_app_sharing` — write
Upload an .aab or .apk to Internal App Sharing and get a download URL for authorized testers. No edit, no review, no track — the fastest way to hand someone a build.
- `packageName` **(required)** — Application id (package name), e.g. com.example.app
- `filePath` **(required)** — Absolute path to the .aab or .apk

---

## Tracks, releases and staged rollout

Tracks: `internal`, `alpha` (closed testing), `beta` (open testing), `production`, custom closed-testing tracks, and form-factor tracks such as `wear:production`.

### `list_tracks`
List every track of an app (internal, alpha, beta, production, custom and form-factor tracks) with their releases: status, versionCodes, userFraction, release notes. Read-only.
- `packageName` **(required)** — Application id (package name), e.g. com.example.app
- `editId` — Optional: read from this open edit (to see uncommitted changes). Without it a temporary edit is opened and deleted.

### `get_track`
Read one track and its releases (status, versionCodes, userFraction, notes). Read-only.
- `packageName` **(required)** — Application id (package name), e.g. com.example.app
- `track` **(required)** — Track name: internal, alpha (closed testing), beta (open testing), production, a custom closed-testing track name, or a form-factor track such as wear:production
- `editId` — Optional: read from this open edit (to see uncommitted changes). Without it a temporary edit is opened and deleted.

### `create_release` — write
Put build(s) on a track as a release. status: 'draft' (saved, not rolled out), 'completed' (full rollout), 'inProgress' (staged rollout — requires userFraction, e.g. 0.1 = 10%), 'halted'. versionCodes come from upload_bundle / list_bundles. Production releases are gated by PLAY_MCP_ALLOW_PRODUCTION_RELEASE. Set dryRun:true to have Google validate the release without publishing.
- `packageName` **(required)** — Application id (package name), e.g. com.example.app
- `track` **(required)** — Track name: internal, alpha (closed testing), beta (open testing), production, a custom closed-testing track name, or a form-factor track such as wear:production
- `versionCodes` **(required)** — Version codes in this release (include any you want to retain)
- `status` **(required)** — `draft`, `inProgress`, `halted`, `completed`
- `userFraction` — Staged rollout fraction, strictly between 0 and 1 (only with inProgress/halted)
- `name` — Release name (defaults to the versionName)
- `releaseNotes` — What's new, per language (max 500 chars each)
- `inAppUpdatePriority` — 0–5 (default 0)
- `countryTargeting` — { countries: ['US', ...], includeRestOfWorld } — production inProgress releases only
- `editId` — Optional: an open edit from insert_edit. The change is applied inside that edit and NOT committed — batch several changes, then call commit_edit.
- `dryRun` — Preview only: open a temporary edit, apply, validate, then delete it. Nothing is published (default false). Ignored when editId is set.
- `changesNotSentForReview` — Commit option: keep the changes out of review until sent from Play Console. Google requires this for some apps and rejects it for others — set it only if a commit error asks for it.

### `promote_release` — write
Promote a build from one track to another (e.g. internal → beta, beta → production), carrying its versionCodes and release notes. By default promotes the newest release on fromTrack as a full rollout; pass status:'inProgress' + userFraction for a staged rollout, or 'draft' to stage it. Promoting to production is gated by PLAY_MCP_ALLOW_PRODUCTION_RELEASE. Set dryRun:true to validate without publishing.
- `packageName` **(required)** — Application id (package name), e.g. com.example.app
- `fromTrack` **(required)** — Track name: internal, alpha (closed testing), beta (open testing), production, a custom closed-testing track name, or a form-factor track such as wear:production
- `toTrack` **(required)** — Track name: internal, alpha (closed testing), beta (open testing), production, a custom closed-testing track name, or a form-factor track such as wear:production
- `versionCode` — Promote the release containing this version code (default: the newest release)
- `status` — Default 'completed'
- `userFraction` — For status inProgress: 0 < fraction < 1
- `releaseNotes` — Override the notes (default: copy from the source release)
- `editId` — Optional: an open edit from insert_edit. The change is applied inside that edit and NOT committed — batch several changes, then call commit_edit.
- `dryRun` — Preview only: open a temporary edit, apply, validate, then delete it. Nothing is published (default false). Ignored when editId is set.
- `changesNotSentForReview` — Commit option: keep the changes out of review until sent from Play Console. Google requires this for some apps and rejects it for others — set it only if a commit error asks for it.

### `set_rollout_fraction` — write
Change the percentage of a staged rollout (e.g. 0.05 → 0.2). Finds the staged release on the track (default production); userFraction is strictly between 0 and 1 — use complete_rollout for 100%. Gated on production by PLAY_MCP_ALLOW_PRODUCTION_RELEASE. Set dryRun:true to preview before/after.
- `packageName` **(required)** — Application id (package name), e.g. com.example.app
- `track` — Default 'production'
- `userFraction` **(required)** — New fraction, 0 < fraction < 1 (0.2 = 20%)
- `versionCode` — Target the release containing this code (default: the staged one)
- `editId` — Optional: an open edit from insert_edit. The change is applied inside that edit and NOT committed — batch several changes, then call commit_edit.
- `dryRun` — Preview only: open a temporary edit, apply, validate, then delete it. Nothing is published (default false). Ignored when editId is set.
- `changesNotSentForReview` — Commit option: keep the changes out of review until sent from Play Console. Google requires this for some apps and rejects it for others — set it only if a commit error asks for it.

### `halt_rollout` — write
Halt a staged rollout: stop serving the staged release to new users (existing installs keep it). The emergency brake — it is NOT blocked by PLAY_MCP_ALLOW_PRODUCTION_RELEASE=false (only by read-only mode). Track defaults to production.
- `packageName` **(required)** — Application id (package name), e.g. com.example.app
- `track` — Default 'production'
- `versionCode` — Default: the inProgress release
- `editId` — Optional: an open edit from insert_edit. The change is applied inside that edit and NOT committed — batch several changes, then call commit_edit.
- `dryRun` — Preview only: open a temporary edit, apply, validate, then delete it. Nothing is published (default false). Ignored when editId is set.
- `changesNotSentForReview` — Commit option: keep the changes out of review until sent from Play Console. Google requires this for some apps and rejects it for others — set it only if a commit error asks for it.

### `resume_rollout` — write
Resume a halted rollout at its previous fraction (or a new userFraction). Track defaults to production. Gated on production by PLAY_MCP_ALLOW_PRODUCTION_RELEASE.
- `packageName` **(required)** — Application id (package name), e.g. com.example.app
- `track` — Default 'production'
- `userFraction` — Optional new fraction, 0 < fraction < 1
- `versionCode` — Default: the halted release
- `editId` — Optional: an open edit from insert_edit. The change is applied inside that edit and NOT committed — batch several changes, then call commit_edit.
- `dryRun` — Preview only: open a temporary edit, apply, validate, then delete it. Nothing is published (default false). Ignored when editId is set.
- `changesNotSentForReview` — Commit option: keep the changes out of review until sent from Play Console. Google requires this for some apps and rejects it for others — set it only if a commit error asks for it.

### `complete_rollout` — write
Finish a staged rollout: release to 100% of users (status 'completed'). Track defaults to production. Gated on production by PLAY_MCP_ALLOW_PRODUCTION_RELEASE. Set dryRun:true to preview.
- `packageName` **(required)** — Application id (package name), e.g. com.example.app
- `track` — Default 'production'
- `versionCode` — Default: the staged release
- `editId` — Optional: an open edit from insert_edit. The change is applied inside that edit and NOT committed — batch several changes, then call commit_edit.
- `dryRun` — Preview only: open a temporary edit, apply, validate, then delete it. Nothing is published (default false). Ignored when editId is set.
- `changesNotSentForReview` — Commit option: keep the changes out of review until sent from Play Console. Google requires this for some apps and rejects it for others — set it only if a commit error asks for it.

### `update_track` — write
Low-level: replace a track's `releases` array with exactly what you pass (TrackRelease objects). Prefer create_release / promote_release / the rollout tools; use this for unusual shapes. Production tracks are gated by PLAY_MCP_ALLOW_PRODUCTION_RELEASE. Set dryRun:true to validate without publishing.
- `packageName` **(required)** — Application id (package name), e.g. com.example.app
- `track` **(required)** — Track name: internal, alpha (closed testing), beta (open testing), production, a custom closed-testing track name, or a form-factor track such as wear:production
- `releases` **(required)** — TrackRelease objects: { status, versionCodes, userFraction?, name?, releaseNotes?, ... }
- `editId` — Optional: an open edit from insert_edit. The change is applied inside that edit and NOT committed — batch several changes, then call commit_edit.
- `dryRun` — Preview only: open a temporary edit, apply, validate, then delete it. Nothing is published (default false). Ignored when editId is set.
- `changesNotSentForReview` — Commit option: keep the changes out of review until sent from Play Console. Google requires this for some apps and rejects it for others — set it only if a commit error asks for it.

---

## Testers and availability

### `get_testers`
Read the tester Google Groups for a testing track (internal, alpha, beta or custom). Read-only.
- `packageName` **(required)** — Application id (package name), e.g. com.example.app
- `track` **(required)** — Track name: internal, alpha (closed testing), beta (open testing), production, a custom closed-testing track name, or a form-factor track such as wear:production
- `editId` — Optional: read from this open edit (to see uncommitted changes). Without it a temporary edit is opened and deleted.

### `update_testers` — write
Set the tester Google Groups (group email addresses) for a testing track. This REPLACES the list. Individual tester emails are managed in Play Console, not through the API. Set dryRun:true to validate without publishing.
- `packageName` **(required)** — Application id (package name), e.g. com.example.app
- `track` **(required)** — Track name: internal, alpha (closed testing), beta (open testing), production, a custom closed-testing track name, or a form-factor track such as wear:production
- `googleGroups` **(required)** — Google Group email addresses
- `editId` — Optional: an open edit from insert_edit. The change is applied inside that edit and NOT committed — batch several changes, then call commit_edit.
- `dryRun` — Preview only: open a temporary edit, apply, validate, then delete it. Nothing is published (default false). Ignored when editId is set.
- `changesNotSentForReview` — Commit option: keep the changes out of review until sent from Play Console. Google requires this for some apps and rejects it for others — set it only if a commit error asks for it.

### `get_country_availability`
Read which countries a track is available in (and whether it syncs with production). Read-only — availability itself is changed in Play Console.
- `packageName` **(required)** — Application id (package name), e.g. com.example.app
- `track` **(required)** — Track name: internal, alpha (closed testing), beta (open testing), production, a custom closed-testing track name, or a form-factor track such as wear:production
- `editId` — Optional: read from this open edit (to see uncommitted changes). Without it a temporary edit is opened and deleted.

---

## In-app products (one-time)

These are **not** part of edits — they take effect immediately.

### `list_inapp_products`
List managed (one-time) in-app products via the legacy inappproducts API: sku, status, listings, defaultPrice, per-region prices. Read-only. Subscriptions are under list_subscriptions.
- `packageName` **(required)** — Application id (package name), e.g. com.example.app

### `get_inapp_product`
Read one in-app product by sku. Read-only.
- `packageName` **(required)** — Application id (package name), e.g. com.example.app
- `sku` **(required)**

### `create_inapp_product` — write
Create a managed (one-time) in-app product. `product` is an InAppProduct: { sku, status: 'active'|'inactive', purchaseType: 'managedUser', defaultLanguage, listings: { 'en-US': { title, description } }, defaultPrice: { priceMicros: '990000', currency: 'USD' } }. autoConvertMissingPrices fills other regions from defaultPrice. Takes effect immediately (no edit).
- `packageName` **(required)** — Application id (package name), e.g. com.example.app
- `product` **(required)** — InAppProduct resource
- `autoConvertMissingPrices` — Default true

### `update_inapp_product` — write
Patch an in-app product: only the fields in `product` change (status, listings, defaultPrice, prices, ...). Changing defaultPrice/prices is a PRICE CHANGE and is gated by PLAY_MCP_ALLOW_PRICE_CHANGES. Set dryRun:true to see the before/after diff without writing. Takes effect immediately (no edit).
- `packageName` **(required)** — Application id (package name), e.g. com.example.app
- `sku` **(required)**
- `product` **(required)** — Partial InAppProduct
- `autoConvertMissingPrices` — Re-derive regional prices from defaultPrice (default false)
- `latencyTolerance` — Optional propagation latency tolerance (default latency-sensitive)
- `dryRun` — Preview the diff without writing (default false)

### `delete_inapp_product` — write
Delete an in-app product by sku. Irreversible; takes effect immediately.
- `packageName` **(required)** — Application id (package name), e.g. com.example.app
- `sku` **(required)**

### `list_one_time_products`
List one-time products via the NEW monetization.onetimeproducts API (purchase options, offers, regional pricing). Read-only; write them with raw_request until dedicated tools exist.
- `packageName` **(required)** — Application id (package name), e.g. com.example.app

---

## Subscriptions, base plans and offers

Not part of edits — changes take effect immediately. Resource bodies are passed through as documented in the [API reference](https://developers.google.com/android-publisher/api-ref/rest/v3/monetization.subscriptions).

### `list_subscriptions`
List subscriptions with their base plans (billing period, state, regional prices) and listings. Read-only.
- `packageName` **(required)** — Application id (package name), e.g. com.example.app

### `get_subscription`
Read one subscription (base plans, prices, listings, tax settings). Read-only.
- `packageName` **(required)** — Application id (package name), e.g. com.example.app
- `productId` **(required)** — Subscription product id

### `create_subscription` — write
Create a subscription. `subscription` is a Subscription resource: { listings: [{ languageCode, title, benefits?, description? }], basePlans: [{ basePlanId, autoRenewingBasePlanType: { billingPeriodDuration: 'P1M' }, regionalConfigs: [{ regionCode: 'US', price: { currencyCode: 'USD', units: '4', nanos: 990000000 } }] }] }. New base plans start as DRAFT — activate them with activate_base_plan. Takes effect immediately (no edit).
- `packageName` **(required)** — Application id (package name), e.g. com.example.app
- `productId` **(required)** — Subscription product id
- `subscription` **(required)** — Subscription resource
- `regionsVersion` — Regions version for regional prices (default 2022/02; override the default with PLAY_MCP_REGIONS_VERSION)

### `update_subscription` — write
Patch a subscription. `updateMask` lists the fields to replace (e.g. 'listings' or 'basePlans'); `subscription` carries their new values. Updating basePlans changes PRICES for NEW subscribers and is gated by PLAY_MCP_ALLOW_PRICE_CHANGES (existing subscribers move only via migrate_base_plan_prices). Set dryRun:true to see current vs proposed without writing.
- `packageName` **(required)** — Application id (package name), e.g. com.example.app
- `productId` **(required)** — Subscription product id
- `subscription` **(required)** — Partial Subscription resource
- `updateMask` **(required)** — Comma-separated field mask, e.g. 'listings' or 'basePlans'
- `regionsVersion` — Regions version for regional prices (default 2022/02; override the default with PLAY_MCP_REGIONS_VERSION)
- `latencyTolerance` — Optional propagation latency tolerance (default latency-sensitive)
- `dryRun` — Preview the diff without writing (default false)

### `delete_subscription` — write
Delete a subscription. Only possible if it never had a base plan published. Irreversible.
- `packageName` **(required)** — Application id (package name), e.g. com.example.app
- `productId` **(required)** — Subscription product id

### `activate_base_plan` — write
Activate a base plan: it becomes purchasable by users. Gated by PLAY_MCP_ALLOW_SUBSCRIPTION_ACTIVATION.
- `packageName` **(required)** — Application id (package name), e.g. com.example.app
- `productId` **(required)** — Subscription product id
- `basePlanId` **(required)**
- `latencyTolerance` — Optional propagation latency tolerance (default latency-sensitive)

### `deactivate_base_plan` — write
Deactivate a base plan: no NEW purchases (existing subscribers keep renewing). Gated by PLAY_MCP_ALLOW_SUBSCRIPTION_ACTIVATION.
- `packageName` **(required)** — Application id (package name), e.g. com.example.app
- `productId` **(required)** — Subscription product id
- `basePlanId` **(required)**
- `latencyTolerance` — Optional propagation latency tolerance (default latency-sensitive)

### `delete_base_plan` — write
Delete a base plan. Only draft base plans (never activated) can be deleted. Irreversible.
- `packageName` **(required)** — Application id (package name), e.g. com.example.app
- `productId` **(required)** — Subscription product id
- `basePlanId` **(required)**

### `migrate_base_plan_prices` — write
Move EXISTING subscribers on legacy price cohorts to the base plan's current price in the given regions. This is a price change for paying users (Google notifies them; increases may need opt-in). Gated by PLAY_MCP_ALLOW_PRICE_CHANGES. regionalPriceMigrations: [{ regionCode: 'US', oldestAllowedPriceVersionTime: '2024-01-01T00:00:00Z', priceIncreaseType?: 'PRICE_INCREASE_TYPE_OPT_IN'|'PRICE_INCREASE_TYPE_OPT_OUT' }].
- `packageName` **(required)** — Application id (package name), e.g. com.example.app
- `productId` **(required)** — Subscription product id
- `basePlanId` **(required)**
- `regionalPriceMigrations` **(required)**
- `regionsVersion` — Regions version for regional prices (default 2022/02; override the default with PLAY_MCP_REGIONS_VERSION)
- `latencyTolerance` — Optional propagation latency tolerance (default latency-sensitive)

### `list_subscription_offers`
List the offers (free trials, intro prices, upgrades) under a base plan. Pass basePlanId '-' to list offers across all base plans of the subscription. Read-only.
- `packageName` **(required)** — Application id (package name), e.g. com.example.app
- `productId` **(required)** — Subscription product id
- `basePlanId` — Base plan id, or '-' for all

### `get_subscription_offer`
Read one subscription offer (phases, regional prices, eligibility, state). Read-only.
- `packageName` **(required)** — Application id (package name), e.g. com.example.app
- `productId` **(required)** — Subscription product id
- `basePlanId` **(required)**
- `offerId` **(required)**

### `create_subscription_offer` — write
Create an offer on a base plan. `offer` is a SubscriptionOffer: { phases: [{ recurrenceCount, duration: 'P1W', regionalConfigs: [{ regionCode, free: {} | price | relativeDiscount | absoluteDiscount }] }], regionalConfigs: [{ regionCode, newSubscriberAvailability: true }], targeting?, offerTags? }. New offers start as DRAFT — activate with activate_subscription_offer.
- `packageName` **(required)** — Application id (package name), e.g. com.example.app
- `productId` **(required)** — Subscription product id
- `basePlanId` **(required)**
- `offerId` **(required)**
- `offer` **(required)** — SubscriptionOffer resource
- `regionsVersion` — Regions version for regional prices (default 2022/02; override the default with PLAY_MCP_REGIONS_VERSION)

### `update_subscription_offer` — write
Patch a subscription offer. `updateMask` lists the fields to replace (e.g. 'phases', 'regionalConfigs', 'offerTags'); `offer` carries the new values.
- `packageName` **(required)** — Application id (package name), e.g. com.example.app
- `productId` **(required)** — Subscription product id
- `basePlanId` **(required)**
- `offerId` **(required)**
- `offer` **(required)** — Partial SubscriptionOffer
- `updateMask` **(required)**
- `regionsVersion` — Regions version for regional prices (default 2022/02; override the default with PLAY_MCP_REGIONS_VERSION)
- `latencyTolerance` — Optional propagation latency tolerance (default latency-sensitive)

### `delete_subscription_offer` — write
Delete a subscription offer. Only draft offers (never activated) can be deleted. Irreversible.
- `packageName` **(required)** — Application id (package name), e.g. com.example.app
- `productId` **(required)** — Subscription product id
- `basePlanId` **(required)**
- `offerId` **(required)**

### `activate_subscription_offer` — write
Activate a subscription offer: eligible users can now get it. Gated by PLAY_MCP_ALLOW_SUBSCRIPTION_ACTIVATION.
- `packageName` **(required)** — Application id (package name), e.g. com.example.app
- `productId` **(required)** — Subscription product id
- `basePlanId` **(required)**
- `offerId` **(required)**
- `latencyTolerance` — Optional propagation latency tolerance (default latency-sensitive)

### `deactivate_subscription_offer` — write
Deactivate a subscription offer: no longer offered to new users. Gated by PLAY_MCP_ALLOW_SUBSCRIPTION_ACTIVATION.
- `packageName` **(required)** — Application id (package name), e.g. com.example.app
- `productId` **(required)** — Subscription product id
- `basePlanId` **(required)**
- `offerId` **(required)**
- `latencyTolerance` — Optional propagation latency tolerance (default latency-sensitive)

### `convert_region_prices`
Convert one price into Google's suggested local prices for every region (tax-exclusive input). A calculator only — it changes nothing. Use the output to fill regionalConfigs / prices. price: { currencyCode: 'USD', units: '4', nanos: 990000000 } = $4.99.
- `packageName` **(required)** — Application id (package name), e.g. com.example.app
- `price` **(required)** — Money: { currencyCode, units (string), nanos (integer) }
- `productTaxCategoryCode`

---

## Reviews

### `list_reviews`
List recent user reviews (rating, text, device, app version, any developer reply). NOTE: the API only returns reviews created or modified in roughly the last week, and only reviews that have a text comment. translationLanguage (e.g. 'en') returns translated text. Read-only.
- `packageName` **(required)** — Application id (package name), e.g. com.example.app
- `maxResults` — Page size (default 50)
- `translationLanguage` — BCP-47 language to translate review text into
- `token` — Page token from a previous call
- `allPages` — Follow page tokens and return everything (default false)

### `get_review`
Read one review by id, including the developer reply if any. Read-only.
- `packageName` **(required)** — Application id (package name), e.g. com.example.app
- `reviewId` **(required)**
- `translationLanguage`

### `reply_to_review` — write
Post (or replace) the PUBLIC developer reply to a review. Visible to everyone on Google Play. Max ~350 characters; HTML is stripped. Gated by PLAY_MCP_ALLOW_REVIEW_REPLIES. Set dryRun:true to see the review, any existing reply and length check without posting.
- `packageName` **(required)** — Application id (package name), e.g. com.example.app
- `reviewId` **(required)**
- `replyText` **(required)** — Reply text (max ~350 chars)
- `dryRun` — Preview without posting (default false)

---

## Snapshots

Snapshots are written to `~/.googleplay-api-mcp/snapshots` (override with `PLAY_MCP_SNAPSHOT_DIR`).

### `snapshot_listing`
Save a timestamped JSON snapshot of an app's editable TEXT metadata — app details plus title / short & full description / video for every language — so bulk edits can be reverted with restore_listing. includeImages:true also records each image's id, hashes and preview URL (a record only; image files are not downloaded). Returns the snapshot file path. Read-only on Google Play.
- `packageName` **(required)** — Application id (package name), e.g. com.example.app
- `label` — Optional label added to the filename
- `includeImages` — Also record image ids/hashes/urls per language and type (slower)

### `restore_listing` — write
Restore listing text (and optionally app details) from a snapshot_listing file, in one atomic edit. Languages added since the snapshot are left alone. Images are not restored. Set dryRun:true to see what would change and validate without publishing.
- `file` **(required)** — Path returned by snapshot_listing
- `packageName` — Defaults to the snapshot's packageName; pass to double-check the target
- `languages` — Restore only these languages (default: all in the snapshot)
- `includeDetails` — Also restore contact email/phone/website + defaultLanguage (default false)
- `editId` — Optional: an open edit from insert_edit. The change is applied inside that edit and NOT committed — batch several changes, then call commit_edit.
- `dryRun` — Preview only: open a temporary edit, apply, validate, then delete it. Nothing is published (default false). Ignored when editId is set.
- `changesNotSentForReview` — Commit option: keep the changes out of review until sent from Play Console. Google requires this for some apps and rejects it for others — set it only if a commit error asks for it.

---

## Reporting (optional, separate API)

These use the **Play Developer Reporting API** (`playdeveloperreporting.googleapis.com`, v1beta1), which must be enabled separately in the Cloud project. It covers Android vitals, error issues and anomalies. It does **not** provide install, rating or revenue statistics — those are only available as Play Console CSV exports in Cloud Storage, which this server does not read.

### `list_apps`
List the apps this service account can see (packageName + display name). Uses the OPTIONAL Play Developer Reporting API — the Publisher API has no 'list apps' call — so it needs that API enabled in the Cloud project and 'View app information' access. Read-only.
- `pageSize` — Default 100

### `reporting_get_metric_set`
Describe a vitals metric set: its data freshness (latest available end time per aggregation period). Call before reporting_query_metric_set to pick a valid time range. OPTIONAL Reporting API. Read-only.
- `packageName` **(required)** — Application id (package name), e.g. com.example.app
- `metricSet` **(required)** — `crashRateMetricSet`, `anrRateMetricSet`, `errorCountMetricSet`, `excessiveWakeupRateMetricSet`, `stuckBackgroundWakelockRateMetricSet`, `slowStartRateMetricSet`, `slowRenderingRateMetricSet`, `lmkRateMetricSet`, `anonRssAndSwapMemoryUsageMetricSet`, `bitmapMemoryUsageMetricSet`

### `reporting_query_metric_set`
Query an Android vitals metric set from the OPTIONAL Play Developer Reporting API (crash rate, ANR rate, error counts, slow start/rendering, wakeups, wakelocks, LMK). `query` is the request body: { timelineSpec: { aggregationPeriod: 'DAILY', startTime: { year, month, day, timeZone: { id: 'America/Los_Angeles' } }, endTime: {...} }, metrics: ['crashRate', 'distinctUsers'], dimensions: ['versionCode'], filter?, pageSize? }. Use reporting_get_metric_set first to see the freshness window. Read-only.
- `packageName` **(required)** — Application id (package name), e.g. com.example.app
- `metricSet` **(required)** — `crashRateMetricSet`, `anrRateMetricSet`, `errorCountMetricSet`, `excessiveWakeupRateMetricSet`, `stuckBackgroundWakelockRateMetricSet`, `slowStartRateMetricSet`, `slowRenderingRateMetricSet`, `lmkRateMetricSet`, `anonRssAndSwapMemoryUsageMetricSet`, `bitmapMemoryUsageMetricSet`
- `query` **(required)** — Query body (timelineSpec, metrics, dimensions, filter, pageSize, pageToken)

### `reporting_list_anomalies`
List anomalies Google detected in an app's vitals (sudden crash/ANR-rate changes). OPTIONAL Reporting API. Read-only.
- `packageName` **(required)** — Application id (package name), e.g. com.example.app
- `filter` — e.g. activeBetween("2026-01-01T00:00:00Z", UNBOUNDED)

### `reporting_search_error_issues`
Search grouped crash / ANR issues for an app (cause, location, affected users, first/last version). filter e.g. 'errorIssueType = CRASH'; orderBy e.g. 'errorReportCount desc'. OPTIONAL Reporting API. Read-only.
- `packageName` **(required)** — Application id (package name), e.g. com.example.app
- `filter`
- `orderBy`
- `pageSize` — Default 50

### `reporting_request`
Raw call to the OPTIONAL Play Developer Reporting API (playdeveloperreporting.googleapis.com, v1beta1) for anything not covered above, e.g. '/apps/{packageName}/errorReports:search'. path is relative to /v1beta1. The Reporting API is read-only, so this is allowed in read-only mode.
- `method` **(required)** — `GET`, `POST`
- `path` **(required)**
- `query` — Query params as a flat object
- `body` — JSON request body (for POST ...:query)

---

## Diagnostics and escape hatch

### `doctor`
Diagnose the setup: Node version, credentials present and parseable, whether Google issues an access token, whether the service account can actually reach a given app (pass packageName), whether the optional Reporting API is reachable, and the current safe-mode write settings. Changes nothing (the access probe opens and deletes an empty edit). Run this first if something isn't working.
- `packageName` — Optional: an app to test access against, e.g. com.example.app

### `raw_request` — write
Make a raw Google Play Android Publisher API call — use this for ANY endpoint not covered by a dedicated tool (orders, purchases, voided purchases, one-time product writes, device tier configs, app recovery, users/grants, data safety, etc.). path is relative (e.g. '/applications/{packageName}/reviews') and '/androidpublisher/v3' is added automatically. Edit-scoped paths need an editId from insert_edit — remember to commit_edit or delete_edit. Non-GET calls obey safe mode. See developers.google.com/android-publisher/api-ref/rest.
- `method` **(required)** — `GET`, `POST`, `PUT`, `PATCH`, `DELETE`
- `path` **(required)**
- `query` — Query params as a flat object
- `body` — JSON request body (for POST/PUT/PATCH)

---

## Verification status

What has been checked, and how:

- **Endpoint paths, HTTP methods, query parameter names, enums and response
  field names** were taken from Google's published discovery documents
  (`androidpublisher` v3 and `playdeveloperreporting` v1beta1, revision
  2026-11-08), not from memory.
- **Unit-tested with a mocked `fetch`** (`npm test`): service-account auth
  (assertion signature, scope, token caching/refresh), URL building, error
  shaping, 429 retry, paging, uploads, the full edit lifecycle (commit / dry-run
  / failure cleanup), release and rollout rules, listing validation, safe-mode
  gating, and the tool registry. Several tools are also exercised end-to-end
  against an in-memory stand-in for the API.
- **Not yet verified against the live API.** No tool in this release has been
  run against a real Play Console account. Expect the first live run to surface
  details the mocks can't, in particular:
  - Large `.aab` uploads use a single-request ("media") upload held in memory;
    very large bundles or slow links may need the resumable protocol.
  - Whether Google accepts the extra `:validate` call before `:commit` for apps
    that require `changesNotSentForReview`.
  - The rollout tools send only the modified release (as in Google's
    staged-rollout examples); confirm the previous full release is retained.
  - `regionsVersion` defaults to `2022/02`; newer region versions exist and
    Google may require the latest for some calls — override per call or with
    `PLAY_MCP_REGIONS_VERSION`.
  - Listing length limits (30 / 80 / 4000 / 500) come from Play Console Help,
    not the API reference.
  - Subscription / offer / in-app product bodies are passed through unmodified;
    their shapes in the tool descriptions are illustrative.
  - The exact Play Console permission each tool needs (see `docs/SETUP.md`).

Run `doctor` with a `packageName` first; it checks credentials, token issuance
and real access to that app without changing anything.
