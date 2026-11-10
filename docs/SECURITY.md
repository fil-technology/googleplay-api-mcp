# Security

This server talks to Google on your behalf using a service account key.
That key can **read and modify your live Google Play presence**. Treat it with
the same care as a password.

## What the key can do

Depending on the permissions you grant in Play Console, the service account can
edit listings and screenshots, upload builds, release to testing or production,
change rollout percentages, change prices, activate subscriptions, and reply
publicly to reviews. Scope it down.

## Safe mode (tool-level write guardrails)

Beyond least-privilege permissions, the server can **refuse** writes regardless
of what an agent tries. Set env vars to enforce it:

- `PLAY_MCP_READ_ONLY=true` — blocks every write (great for demos, audits, CI).
- `PLAY_MCP_ALLOW_PRODUCTION_RELEASE=false`, `..._ALLOW_PRICE_CHANGES=false`,
  `..._ALLOW_REVIEW_REPLIES=false`, `..._ALLOW_SUBSCRIPTION_ACTIVATION=false` —
  block individual high-impact categories.

Blocked calls return a clear error. This turns "the agent should ask" into "the
tool cannot do it." Run `doctor` to see the active mode.

Things worth knowing:

- `raw_request` is checked against the same categories (by HTTP method and
  path), so it is not a way around a gate.
- `halt_rollout` is intentionally **not** blocked by
  `PLAY_MCP_ALLOW_PRODUCTION_RELEASE=false` — stopping a bad rollout is the safe
  direction. Read-only mode blocks it like any other write.
- Read tools for listings, images and tracks open a temporary edit and delete
  it. That is a `POST` and a `DELETE` on the wire but changes no app state, so
  they are allowed in read-only mode.
- Safe mode guards this server's tools. It is not a substitute for limiting the
  service account's permissions in Play Console.

## Principle of least privilege

- Create a **dedicated service account** just for this server — don't reuse one.
- Grant it **only the apps and permissions** it needs (see
  [SETUP.md](SETUP.md#3-grant-access-in-play-console)). "View app information"
  is enough for read-only audits. Avoid account-wide **Admin**.
- It needs **no Google Cloud IAM roles** at all.
- You can **remove** it at any time in Play Console → Users and permissions, or
  delete the key in Google Cloud → IAM & Admin → Service Accounts → Keys. Either
  breaks only this integration.

## Where credentials live

- Credentials are read from **environment variables**. They are never accepted
  as tool arguments, so an agent cannot be talked into passing or echoing one.
- They are used **only** to sign a short-lived assertion, exchange it at the key
  file's `token_uri` (Google's OAuth endpoint) for an access token (≤ 1 hour),
  and call `androidpublisher.googleapis.com` /
  `playdeveloperreporting.googleapis.com` **directly**. Nothing is proxied
  through any third party.
- The client refuses to attach the access token to any other host.
- The token is held in memory only. Error messages and `doctor` output include
  the service account's `client_email` but never the private key or token.
- Nothing is logged to disk. The only files written are listing snapshots you
  ask for (`snapshot_listing`, or `PLAY_MCP_AUTO_SNAPSHOT=true`), which contain
  store text — not credentials.

## Never commit secrets

This project is set up to keep secrets out of git and npm:

- `.gitignore` excludes `secrets/`, `.env`, `*.key`, `*.pem`, `*.jks`,
  `*.keystore` and common service-account file names.
- `package.json` uses a `files` allow-list, so **only** `src/`, docs, README,
  LICENSE, CHANGELOG and `.env.example` are published to npm — even if a key
  sits in the folder, `npm publish` won't include it.

**Before committing or publishing, always verify:**

```bash
git status                 # no service-account json, no .env, no secrets/
npm pack --dry-run         # review the file list — there must be NO key files
```

If a key is ever exposed (committed, pasted, shared), **delete it immediately**
in Google Cloud and create a new one — that's a 60-second operation and the
only safe response.

## Handling the key file

- Store it outside any repo (e.g. `~/.googleplay/`), `chmod 600`.
- Prefer `GOOGLE_SERVICE_ACCOUNT_JSON` as a path. For containers/CI where files
  are awkward, use `GOOGLE_SERVICE_ACCOUNT_JSON_BASE64` injected as a secret —
  not committed to the repo.

## Publishing this package

The npm publish workflow uses **OIDC trusted publishing** — there is no
`NPM_TOKEN` in the repository or its secrets. See the README's Development
section for the one-time npm-side setup.

## Reporting a vulnerability

Found a security issue in this server? Please open a private report / security
advisory on the GitHub repository rather than a public issue.
