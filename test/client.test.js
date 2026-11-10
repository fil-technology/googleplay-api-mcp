import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jwtVerify, importSPKI } from "jose";
import { GooglePlayClient, SCOPE_PUBLISHER, SCOPE_REPORTING } from "../src/client.js";

// A throwaway RSA key generated per test run — never a real credential.
const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const CREDS = {
  type: "service_account",
  project_id: "demo-project",
  client_email: "play-mcp@demo-project.iam.gserviceaccount.com",
  private_key: privateKey,
  token_uri: "https://oauth2.googleapis.com/token",
};

const json = (body, status = 200, headers = {}) =>
  new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

/** Fake fetch: answers the token endpoint itself, delegates API calls to `handler`. */
function fakeFetch(handler) {
  const calls = [];
  const tokenRequests = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(String(url));
    if (u.hostname === "oauth2.googleapis.com") {
      tokenRequests.push(new URLSearchParams(init.body));
      return json({ access_token: `tok-${tokenRequests.length}`, expires_in: 3600, token_type: "Bearer" });
    }
    calls.push({ url: u, init });
    return handler(u, init, calls.length);
  };
  return { fetchImpl, calls, tokenRequests };
}

const make = (handler, extra = {}) => {
  const f = fakeFetch(handler);
  const client = new GooglePlayClient({ credentials: CREDS, fetchImpl: f.fetchImpl, sleep: async () => {}, ...extra });
  return { client, ...f };
};

// ---- Credentials ----

test("missing credentials produce a helpful error", () => {
  assert.throws(() => new GooglePlayClient({}), /GOOGLE_SERVICE_ACCOUNT_JSON/);
});

test("credentials load from inline JSON, base64 and a file path", () => {
  const text = JSON.stringify(CREDS);
  assert.equal(new GooglePlayClient({ credentialsJson: text }).clientEmail, CREDS.client_email);
  assert.equal(
    new GooglePlayClient({ credentialsBase64: Buffer.from(text).toString("base64") }).clientEmail,
    CREDS.client_email,
  );
  const file = join(mkdtempSync(join(tmpdir(), "gp-mcp-")), "sa.json");
  writeFileSync(file, text);
  assert.equal(new GooglePlayClient({ credentialsPath: file }).projectId, "demo-project");
});

test("invalid JSON never echoes the key material", () => {
  try {
    new GooglePlayClient({ credentialsJson: `{"private_key": "SECRET-PEM" oops` });
    assert.fail("should throw");
  } catch (e) {
    assert.match(e.message, /not valid JSON/);
    assert.doesNotMatch(e.message, /SECRET-PEM/);
  }
});

test("a key without client_email / private_key is rejected", () => {
  assert.throws(() => new GooglePlayClient({ credentials: { private_key: "x" } }), /client_email/);
  assert.throws(() => new GooglePlayClient({ credentials: { client_email: "x" } }), /private_key/);
});

test("optionsFromEnv: GOOGLE_SERVICE_ACCOUNT_JSON is a path or inline JSON", () => {
  assert.deepEqual(GooglePlayClient.optionsFromEnv({ GOOGLE_SERVICE_ACCOUNT_JSON: "/keys/sa.json" }), {
    credentialsJson: undefined,
    credentialsBase64: undefined,
    credentialsPath: "/keys/sa.json",
  });
  const inline = GooglePlayClient.optionsFromEnv({ GOOGLE_SERVICE_ACCOUNT_JSON: ' {"a":1}' });
  assert.equal(inline.credentialsJson, '{"a":1}');
  assert.equal(inline.credentialsPath, undefined);
  assert.equal(
    GooglePlayClient.optionsFromEnv({ GOOGLE_APPLICATION_CREDENTIALS: "/adc.json" }).credentialsPath,
    "/adc.json",
  );
  assert.equal(GooglePlayClient.credentialSource({}), null);
  assert.match(GooglePlayClient.credentialSource({ GOOGLE_SERVICE_ACCOUNT_JSON: '{"private_key":"x"}' }), /inline/);
});

// ---- Auth / token ----

test("mints a signed RS256 assertion and sends the bearer token", async () => {
  const { client, calls, tokenRequests } = make(() => json({ reviews: [] }));
  await client.get("/applications/com.example.app/reviews", { maxResults: 5 });

  assert.equal(tokenRequests.length, 1);
  assert.equal(tokenRequests[0].get("grant_type"), "urn:ietf:params:oauth:grant-type:jwt-bearer");
  const { payload, protectedHeader } = await jwtVerify(
    tokenRequests[0].get("assertion"),
    await importSPKI(publicKey, "RS256"),
    { issuer: CREDS.client_email, audience: CREDS.token_uri },
  );
  assert.equal(protectedHeader.alg, "RS256");
  assert.equal(payload.scope, SCOPE_PUBLISHER);
  assert.ok(payload.exp - payload.iat <= 3600);

  assert.equal(
    calls[0].url.href,
    "https://androidpublisher.googleapis.com/androidpublisher/v3/applications/com.example.app/reviews?maxResults=5",
  );
  assert.equal(calls[0].init.headers.Authorization, "Bearer tok-1");
});

test("the access token is cached across requests", async () => {
  const { client, tokenRequests } = make(() => json({}));
  await client.get("/applications/com.example.app/reviews");
  await client.get("/applications/com.example.app/subscriptions");
  assert.equal(tokenRequests.length, 1);
});

test("an expiring token is refreshed", async () => {
  const { client, tokenRequests } = make(() => json({}));
  await client.get("/applications/com.example.app/reviews");
  client._tokens.get(SCOPE_PUBLISHER).exp = Math.floor(Date.now() / 1000) + 30; // <60s left
  await client.get("/applications/com.example.app/reviews");
  assert.equal(tokenRequests.length, 2);
});

test("the Reporting API gets its own scope and host", async () => {
  const { client, calls, tokenRequests } = make(() => json({ apps: [] }));
  await client.get("/v1beta1/apps:search");
  const { payload } = await jwtVerify(tokenRequests[0].get("assertion"), await importSPKI(publicKey, "RS256"));
  assert.equal(payload.scope, SCOPE_REPORTING);
  assert.equal(calls[0].url.href, "https://playdeveloperreporting.googleapis.com/v1beta1/apps:search");
});

test("a failed token exchange is reported without key material", async () => {
  const client = new GooglePlayClient({
    credentials: CREDS,
    fetchImpl: async () =>
      json({ error: "invalid_grant", error_description: "Invalid JWT Signature." }, 400),
  });
  await assert.rejects(client.get("/applications/com.example.app/reviews"), (e) => {
    assert.match(e.message, /OAuth token request failed: 400/);
    assert.match(e.message, /invalid_grant: Invalid JWT Signature/);
    assert.doesNotMatch(e.message, /BEGIN PRIVATE KEY/);
    return true;
  });
});

// ---- URL building ----

test("the bearer token is never sent to a non-Google-Play host", async () => {
  const { client, calls } = make(() => json({}));
  await assert.rejects(client.get("https://evil.example.com/steal"), /Refusing to send credentials/);
  await assert.rejects(client.get("http://androidpublisher.googleapis.com/x"), /Refusing/);
  assert.equal(calls.length, 0);
});

test("paths with an explicit prefix are not double-prefixed; arrays repeat", async () => {
  const { client, calls } = make(() => json({}));
  await client.get("/androidpublisher/v3/applications/a.b/subscriptions:batchGet", { productIds: ["x", "y"] });
  assert.equal(
    calls[0].url.href,
    "https://androidpublisher.googleapis.com/androidpublisher/v3/applications/a.b/subscriptions:batchGet?productIds=x&productIds=y",
  );
});

test("JSON bodies are serialized with a content type", async () => {
  const { client, calls } = make(() => json({ ok: true }));
  await client.patch("/applications/a.b/edits/1/details", { contactEmail: "a@b.c" });
  assert.equal(calls[0].init.method, "PATCH");
  assert.equal(calls[0].init.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(calls[0].init.body), { contactEmail: "a@b.c" });
});

// ---- Error shaping ----

test("Google errors are shaped into one readable message with status + body", async () => {
  const { client } = make(() =>
    json(
      {
        error: {
          code: 403,
          message: "The caller does not have permission",
          status: "PERMISSION_DENIED",
          errors: [{ reason: "permissionDenied", message: "x" }],
        },
      },
      403,
    ),
  );
  await assert.rejects(client.get("/applications/com.example.app/reviews"), (e) => {
    assert.equal(e.status, 403);
    assert.equal(e.body.error.status, "PERMISSION_DENIED");
    assert.match(e.message, /^Google Play GET \/androidpublisher\/v3\/applications\/com\.example\.app\/reviews failed: 403/);
    assert.match(e.message, /PERMISSION_DENIED \(permissionDenied\): The caller does not have permission/);
    assert.match(e.message, /Users and permissions/);
    assert.doesNotMatch(e.message, /tok-1/);
    return true;
  });
});

test("non-JSON error bodies are passed through", async () => {
  const { client } = make(() => new Response("upstream exploded", { status: 500 }));
  await assert.rejects(client.get("/applications/a.b/reviews"), /500 .*upstream exploded/);
});

test("empty 204 responses resolve to null", async () => {
  const { client } = make(() => new Response(null, { status: 204 }));
  assert.equal(await client.delete("/applications/a.b/edits/1"), null);
});

// ---- Retry ----

test("429 is retried (honouring Retry-After) and then succeeds", async () => {
  const waits = [];
  const { client, calls } = make(
    (u, init, n) => (n < 3 ? json({ error: { code: 429, message: "quota" } }, 429, { "retry-after": "2" }) : json({ done: true })),
    { sleep: async (ms) => waits.push(ms) },
  );
  assert.deepEqual(await client.get("/applications/a.b/reviews"), { done: true });
  assert.equal(calls.length, 3);
  assert.deepEqual(waits, [2000, 2000]);
});

test("429 gives up after a few attempts", async () => {
  const { client, calls } = make(() => json({ error: { code: 429, message: "quota", status: "RESOURCE_EXHAUSTED" } }, 429));
  await assert.rejects(client.get("/applications/a.b/reviews"), /429/);
  assert.equal(calls.length, 5);
});

// ---- Paging ----

test("getAll follows nextPageToken → pageToken", async () => {
  const { client, calls } = make((u) =>
    u.searchParams.get("pageToken") === "p2"
      ? json({ subscriptions: [{ productId: "b" }] })
      : json({ subscriptions: [{ productId: "a" }], nextPageToken: "p2" }),
  );
  const all = await client.getAll("/applications/a.b/subscriptions", { pageSize: 1 }, { itemsKey: "subscriptions" });
  assert.deepEqual(all.map((s) => s.productId), ["a", "b"]);
  assert.equal(calls[1].url.searchParams.get("pageSize"), "1");
});

test("getAll follows tokenPagination.nextPageToken → token (reviews style)", async () => {
  const { client } = make((u) =>
    u.searchParams.get("token") === "t2"
      ? json({ reviews: [{ reviewId: "2" }] })
      : json({ reviews: [{ reviewId: "1" }], tokenPagination: { nextPageToken: "t2" } }),
  );
  const all = await client.getAll("/applications/a.b/reviews", {}, { itemsKey: "reviews", tokenParam: "token" });
  assert.deepEqual(all.map((r) => r.reviewId), ["1", "2"]);
});

test("getAll stops at maxPages", async () => {
  const { client, calls } = make(() => json({ items: [1], nextPageToken: "again" }));
  const all = await client.getAll("/applications/a.b/x", {}, { itemsKey: "items", maxPages: 3 });
  assert.equal(all.length, 3);
  assert.equal(calls.length, 3);
});

// ---- Upload ----

test("upload posts raw bytes to the /upload endpoint and is not retried", async () => {
  const { client, calls } = make(() => json({ error: { code: 503, message: "busy" } }, 503));
  await assert.rejects(
    client.upload("/applications/a.b/edits/7/bundles", {
      buffer: Buffer.from("PK-fake-aab"),
      query: { ackBundleInstallationWarning: true },
    }),
    /503/,
  );
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url.href,
    "https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications/a.b/edits/7/bundles?ackBundleInstallationWarning=true&uploadType=media",
  );
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers["Content-Type"], "application/octet-stream");
  assert.equal(calls[0].init.body.toString(), "PK-fake-aab");
});
