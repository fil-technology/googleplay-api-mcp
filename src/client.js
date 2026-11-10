import { readFileSync } from "node:fs";
import { importPKCS8, SignJWT } from "jose";

const PUBLISHER_HOST = "https://androidpublisher.googleapis.com";
const PUBLISHER_PREFIX = "/androidpublisher/v3";
const REPORTING_HOST = "https://playdeveloperreporting.googleapis.com";
const DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token";

export const SCOPE_PUBLISHER = "https://www.googleapis.com/auth/androidpublisher";
export const SCOPE_REPORTING = "https://www.googleapis.com/auth/playdeveloperreporting";

// The bearer token is only ever sent to these hosts.
const ALLOWED_HOSTS = new Set([
  "androidpublisher.googleapis.com",
  "playdeveloperreporting.googleapis.com",
]);

/**
 * Thin client for the Google Play Android Publisher API (v3) and, optionally,
 * the Play Developer Reporting API (v1beta1).
 * Handles the service-account OAuth2 flow (RS256 JWT assertion exchanged for
 * an access token, cached until shortly before expiry) and exposes request,
 * paging and media-upload helpers.
 */
export class GooglePlayClient {
  constructor({
    credentials,
    credentialsJson,
    credentialsBase64,
    credentialsPath,
    fetchImpl,
    sleep,
  } = {}) {
    // Accept the service-account key four ways, in priority order:
    //   1. an already-parsed object   (tests / embedding)
    //   2. inline JSON text           (GOOGLE_SERVICE_ACCOUNT_JSON starting with "{")
    //   3. base64-encoded JSON        (GOOGLE_SERVICE_ACCOUNT_JSON_BASE64)
    //   4. path to the .json key file (GOOGLE_SERVICE_ACCOUNT_JSON as a path)
    let creds = credentials || null;
    if (!creds) {
      const text =
        credentialsJson ||
        (credentialsBase64
          ? Buffer.from(credentialsBase64, "base64").toString("utf8")
          : null) ||
        (credentialsPath ? readFileSync(credentialsPath, "utf8") : null);
      if (!text)
        throw new Error(
          "Provide the service account key via GOOGLE_SERVICE_ACCOUNT_JSON (a file path or inline JSON) or GOOGLE_SERVICE_ACCOUNT_JSON_BASE64",
        );
      try {
        creds = JSON.parse(text);
      } catch {
        // Never echo the text — it contains the private key.
        throw new Error("The service account key is not valid JSON");
      }
    }
    if (!creds.client_email)
      throw new Error("The service account key is missing 'client_email'");
    if (!creds.private_key)
      throw new Error("The service account key is missing 'private_key'");
    this.clientEmail = creds.client_email;
    this.projectId = creds.project_id || null;
    this._pem = creds.private_key;
    this._tokenUri = creds.token_uri || DEFAULT_TOKEN_URI;
    this._fetch = fetchImpl || ((...args) => fetch(...args));
    this._sleep = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    this._tokens = new Map(); // scope -> { token, exp }
  }

  /**
   * Map the environment onto constructor options.
   * GOOGLE_SERVICE_ACCOUNT_JSON may be a file path OR the inline JSON itself;
   * GOOGLE_APPLICATION_CREDENTIALS (Google's standard path variable) is a fallback.
   */
  static optionsFromEnv(env = process.env) {
    const raw = (env.GOOGLE_SERVICE_ACCOUNT_JSON || "").trim();
    const inline = raw.startsWith("{");
    return {
      credentialsJson: inline ? raw : undefined,
      credentialsBase64: env.GOOGLE_SERVICE_ACCOUNT_JSON_BASE64 || undefined,
      credentialsPath:
        (!inline && raw) || env.GOOGLE_APPLICATION_CREDENTIALS || undefined,
    };
  }

  /** Which credential source the environment provides (never the value). */
  static credentialSource(env = process.env) {
    const raw = (env.GOOGLE_SERVICE_ACCOUNT_JSON || "").trim();
    if (raw.startsWith("{")) return "inline JSON (GOOGLE_SERVICE_ACCOUNT_JSON)";
    if (env.GOOGLE_SERVICE_ACCOUNT_JSON_BASE64)
      return "base64 (GOOGLE_SERVICE_ACCOUNT_JSON_BASE64)";
    if (raw) return `path: ${raw}`;
    if (env.GOOGLE_APPLICATION_CREDENTIALS)
      return `path: ${env.GOOGLE_APPLICATION_CREDENTIALS} (GOOGLE_APPLICATION_CREDENTIALS)`;
    return null;
  }

  async _getToken(scope = SCOPE_PUBLISHER) {
    const now = Math.floor(Date.now() / 1000);
    const cached = this._tokens.get(scope);
    // Reuse token while it still has >60s of life.
    if (cached && now < cached.exp - 60) return cached.token;
    const key = await importPKCS8(this._pem, "RS256");
    const assertion = await new SignJWT({ scope })
      .setProtectedHeader({ alg: "RS256", typ: "JWT" })
      .setIssuer(this.clientEmail)
      .setAudience(this._tokenUri)
      .setIssuedAt(now)
      .setExpirationTime(now + 3600) // Google caps assertion life at 1 hour.
      .sign(key);
    const res = await this._fetch(this._tokenUri, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }).toString(),
    });
    const text = await res.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      /* non-JSON error body */
    }
    if (!res.ok || !data || !data.access_token) {
      const detail = data
        ? [data.error, data.error_description].filter(Boolean).join(": ")
        : text.slice(0, 200);
      const err = new Error(
        `Google OAuth token request failed: ${res.status} ${res.statusText || ""} — ${detail || "no access_token in response"}`,
      );
      err.status = res.status;
      throw err;
    }
    this._tokens.set(scope, {
      token: data.access_token,
      exp: now + (Number(data.expires_in) || 3600),
    });
    return data.access_token;
  }

  /**
   * Resolve `path` to a URL. Accepts:
   *   - a path relative to the Publisher API root ('/applications/{pkg}/reviews'),
   *     '/androidpublisher/v3' is added automatically
   *   - a path that already starts with '/androidpublisher/' or '/upload/androidpublisher/'
   *   - a Reporting API path starting with '/v1beta1/'
   *   - a full https URL on one of the two Google Play API hosts
   */
  _buildUrl(path, query) {
    let url;
    if (/^https?:\/\//i.test(path)) {
      url = new URL(path);
      if (url.protocol !== "https:" || !ALLOWED_HOSTS.has(url.hostname))
        throw new Error(
          `Refusing to send credentials to ${url.hostname} — only ${[...ALLOWED_HOSTS].join(" and ")} are allowed`,
        );
    } else {
      const clean = path.startsWith("/") ? path : `/${path}`;
      if (clean.startsWith("/v1beta1/")) url = new URL(REPORTING_HOST + clean);
      else if (
        clean.startsWith("/androidpublisher/") ||
        clean.startsWith("/upload/androidpublisher/")
      )
        url = new URL(PUBLISHER_HOST + clean);
      else url = new URL(PUBLISHER_HOST + PUBLISHER_PREFIX + clean);
    }
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v === undefined || v === null) continue;
        // Google expects repeated params (productIds=a&productIds=b), not CSV.
        if (Array.isArray(v)) for (const item of v) url.searchParams.append(k, String(item));
        else url.searchParams.set(k, String(v));
      }
    }
    return url;
  }

  static _scopeFor(url) {
    return url.hostname === "playdeveloperreporting.googleapis.com"
      ? SCOPE_REPORTING
      : SCOPE_PUBLISHER;
  }

  /** Turn a Google error payload into one readable line. */
  static _errorDetail(data) {
    if (data && data.error && typeof data.error === "object") {
      const e = data.error;
      const reasons = Array.isArray(e.errors)
        ? e.errors.map((x) => x.reason).filter(Boolean)
        : [];
      return [
        e.status || e.code,
        reasons.length ? `(${[...new Set(reasons)].join(", ")})` : null,
        e.message ? `: ${e.message}` : null,
      ]
        .filter(Boolean)
        .join(" ")
        .replace(" :", ":");
    }
    return typeof data === "string" ? data.slice(0, 500) : JSON.stringify(data);
  }

  static _hint(status) {
    if (status === 401)
      return " Hint: the access token was rejected — check the service account key is current and not deleted.";
    if (status === 403)
      return " Hint: the service account needs access to this app — invite its client_email in Play Console → Users and permissions and grant the relevant app permissions (and enable the API in the Google Cloud project). New grants can take a while to apply.";
    if (status === 404)
      return " Hint: check the packageName (and that the app exists in this Play Console account); an expired or already-committed editId also returns 404.";
    return "";
  }

  async _send(method, url, { headers = {}, payload, retry, _attempt = 0 }) {
    const token = await this._getToken(GooglePlayClient._scopeFor(url));
    const res = await this._fetch(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...headers },
      body: payload,
    });

    // Quota: Google returns 429 (or 503) when a per-minute/daily bucket is hit.
    // Respect Retry-After if present, else exponential backoff; retry a few times.
    if ((res.status === 429 || res.status === 503) && retry && _attempt < 4) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const waitMs =
        retryAfter > 0 ? retryAfter * 1000 : Math.min(1000 * 2 ** _attempt, 16000);
      await this._sleep(waitMs);
      return this._send(method, url, { headers, payload, retry, _attempt: _attempt + 1 });
    }

    const text = await res.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    if (!res.ok) {
      const err = new Error(
        `Google Play ${method} ${url.pathname} failed: ${res.status} ${res.statusText || ""} — ${GooglePlayClient._errorDetail(data)}.${GooglePlayClient._hint(res.status)}`,
      );
      err.status = res.status;
      err.body = data;
      throw err;
    }
    return data;
  }

  async request(method, path, { query, body } = {}) {
    const url = this._buildUrl(path, query);
    const headers = {};
    let payload;
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(body);
    }
    return this._send(method, url, { headers, payload, retry: true });
  }

  get(path, query) {
    return this.request("GET", path, { query });
  }
  post(path, body, query) {
    return this.request("POST", path, { body, query });
  }
  put(path, body, query) {
    return this.request("PUT", path, { body, query });
  }
  patch(path, body, query) {
    return this.request("PATCH", path, { body, query });
  }
  delete(path, query) {
    return this.request("DELETE", path, { query });
  }

  /**
   * Follow page tokens and concatenate one array field, up to `maxPages`.
   * Google Play uses two paging styles:
   *   - nextPageToken → pageToken              (subscriptions, offers, reporting)
   *   - tokenPagination.nextPageToken → token  (reviews, inappproducts)
   */
  async getAll(path, query, { itemsKey, tokenParam = "pageToken", maxPages = 20 } = {}) {
    const all = [];
    let q = { ...(query || {}) };
    for (let pages = 0; pages < maxPages; pages++) {
      const page = (await this.get(path, q)) || {};
      if (Array.isArray(page[itemsKey])) all.push(...page[itemsKey]);
      const next =
        page.nextPageToken ||
        (page.tokenPagination && page.tokenPagination.nextPageToken);
      if (!next) break;
      q = { ...q, [tokenParam]: next };
    }
    return all;
  }

  /**
   * Simple ("media") upload of one file to an upload endpoint. `path` is the
   * regular resource path; '/upload' is prefixed automatically. The file is
   * read into memory, so very large bundles need a matching amount of RAM.
   * Uploads are not retried automatically.
   */
  async upload(path, { filePath, buffer, contentType = "application/octet-stream", query } = {}) {
    const data = buffer || readFileSync(filePath);
    const clean = path.startsWith("/") ? path : `/${path}`;
    const url = this._buildUrl(`/upload${PUBLISHER_PREFIX}${clean}`, {
      ...(query || {}),
      uploadType: "media",
    });
    return this._send("POST", url, {
      headers: { "Content-Type": contentType },
      payload: data,
      retry: false,
    });
  }

  /** Fetch raw bytes from a public URL (no credentials attached). */
  async fetchBinary(url) {
    const res = await this._fetch(url);
    if (!res.ok) throw new Error(`Download failed (${res.status}) for ${url}`);
    return Buffer.from(await res.arrayBuffer());
  }
}
