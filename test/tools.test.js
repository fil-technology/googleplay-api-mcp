import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { GooglePlayClient } from "../src/client.js";
import { tools, __setClient } from "../src/index.js";

// End-to-end through the real tool code and the real client, against an
// in-memory stand-in for the Publisher API (mocked fetch — no network).

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const PKG = "com.example.app";
const ROOT = `/androidpublisher/v3/applications/${PKG}`;
const tool = (name) => tools.find((t) => t.name === name);

function fakePlay({ rejectValidate = false } = {}) {
  const live = {
    listings: { "en-US": { language: "en-US", title: "Old title", shortDescription: "Old short", fullDescription: "Old full" } },
    tracks: {
      production: {
        track: "production",
        releases: [
          { status: "completed", versionCodes: ["40"] },
          { status: "inProgress", versionCodes: ["42"], userFraction: 0.1 },
        ],
      },
      internal: { track: "internal", releases: [{ status: "completed", versionCodes: ["43"], releaseNotes: [{ language: "en-US", text: "New" }] }] },
    },
  };
  const edits = new Map(); // id -> working copy
  const log = [];
  let n = 0;
  const reply = (body, status = 200) =>
    new Response(body === null ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const notFound = () => reply({ error: { code: 404, message: "not found", status: "NOT_FOUND" } }, 404);

  const fetchImpl = async (url, init = {}) => {
    const u = new URL(String(url));
    if (u.hostname === "oauth2.googleapis.com") return reply({ access_token: "t", expires_in: 3600 });
    const method = init.method || "GET";
    const path = decodeURIComponent(u.pathname).replace(ROOT, "");
    log.push(`${method} ${path}`);
    const body = init.body && typeof init.body === "string" ? JSON.parse(init.body) : undefined;

    if (method === "POST" && path === "/edits") {
      const id = `E${++n}`;
      edits.set(id, structuredClone(live));
      return reply({ id, expiryTimeSeconds: "9999999999" });
    }
    const m = path.match(/^\/edits\/([^/:]+)(.*)$/);
    if (!m) return notFound();
    const [, id, rest] = m;
    const edit = edits.get(id);
    if (!edit) return notFound();

    if (rest === ":validate")
      return rejectValidate
        ? reply({ error: { code: 400, message: "Title too long", status: "INVALID_ARGUMENT" } }, 400)
        : reply({ id });
    if (rest === ":commit") {
      Object.assign(live, edit);
      edits.delete(id);
      return reply({ id });
    }
    if (rest === "" && method === "DELETE") {
      edits.delete(id);
      return reply(null, 204);
    }
    const listing = rest.match(/^\/listings\/([^/]+)$/);
    if (listing) {
      const lang = listing[1];
      if (method === "GET") return edit.listings[lang] ? reply(edit.listings[lang]) : notFound();
      if (method === "PATCH") return reply((edit.listings[lang] = { ...edit.listings[lang], ...body }));
      if (method === "PUT") return reply((edit.listings[lang] = { ...body, language: lang }));
    }
    const track = rest.match(/^\/tracks\/([^/]+)$/);
    if (track) {
      const name = track[1];
      if (method === "GET") return edit.tracks[name] ? reply(edit.tracks[name]) : notFound();
      if (method === "PUT") return reply((edit.tracks[name] = body));
    }
    return notFound();
  };

  __setClient(new GooglePlayClient({
    credentials: { client_email: "sa@demo.iam.gserviceaccount.com", private_key: privateKey },
    fetchImpl,
    sleep: async () => {},
  }));
  return { live, edits, log };
}

test("update_listing: patches, validates and commits in one call", async () => {
  const play = fakePlay();
  const out = await tool("update_listing").run({ packageName: PKG, language: "en-US", title: "New title" });
  assert.equal(out.committed, true);
  assert.equal(play.live.listings["en-US"].title, "New title");
  assert.equal(play.live.listings["en-US"].shortDescription, "Old short", "untouched fields survive");
  assert.deepEqual(out.result.changes, [
    { field: "title", from: "Old title", to: "New title", changed: true, newLength: 9, limit: 30, exceedsLimit: false },
  ]);
  assert.equal(play.edits.size, 0, "no dangling edit");
  assert.deepEqual(play.log.slice(-2), ["POST /edits/E1:validate", "POST /edits/E1:commit"]);
});

test("update_listing dryRun: shows the diff, changes nothing, leaves no edit", async () => {
  const play = fakePlay();
  const out = await tool("update_listing").run({ packageName: PKG, language: "en-US", title: "x".repeat(31), dryRun: true });
  assert.equal(out.dryRun, true);
  assert.deepEqual(out.validation, { ok: true });
  assert.equal(out.result.changes[0].exceedsLimit, true);
  assert.match(out.result._warnings[0], /limit of 30/);
  assert.equal(play.live.listings["en-US"].title, "Old title");
  assert.equal(play.edits.size, 0);
  assert.ok(!play.log.some((l) => l.endsWith(":commit")));
});

test("update_listing dryRun surfaces Google's validation error", async () => {
  const play = fakePlay({ rejectValidate: true });
  const out = await tool("update_listing").run({ packageName: PKG, language: "en-US", title: "T", dryRun: true });
  assert.equal(out.validation.ok, false);
  assert.match(out.validation.error, /INVALID_ARGUMENT: Title too long/);
  assert.equal(play.edits.size, 0);
});

test("update_listing: a rejected edit is discarded and nothing goes live", async () => {
  const play = fakePlay({ rejectValidate: true });
  await assert.rejects(
    tool("update_listing").run({ packageName: PKG, language: "en-US", title: "T" }),
    /Title too long.*the edit was discarded/,
  );
  assert.equal(play.live.listings["en-US"].title, "Old title");
  assert.equal(play.edits.size, 0);
});

test("bulk_upsert_listings: patches existing and creates new languages atomically", async () => {
  const play = fakePlay();
  const out = await tool("bulk_upsert_listings").run({
    packageName: PKG,
    listings: {
      "en-US": { shortDescription: "Fresh short" },
      "de-DE": { title: "Titel", shortDescription: "Kurz", fullDescription: "Lang" },
    },
  });
  assert.equal(out.result.languages, 2);
  assert.deepEqual(out.result.results.map((r) => [r.language, r.created]), [["en-US", false], ["de-DE", true]]);
  assert.equal(play.live.listings["de-DE"].title, "Titel");
  assert.equal(play.live.listings["en-US"].title, "Old title");
  assert.equal(play.log.filter((l) => l.endsWith(":commit")).length, 1, "one commit for all languages");
});

test("a caller-supplied editId batches without committing", async () => {
  const play = fakePlay();
  const { editId } = await tool("insert_edit").run({ packageName: PKG });
  const out = await tool("update_listing").run({ packageName: PKG, language: "en-US", title: "Batched", editId });
  assert.equal(out.committed, false);
  assert.equal(play.live.listings["en-US"].title, "Old title", "not live yet");
  await tool("commit_edit").run({ packageName: PKG, editId });
  assert.equal(play.live.listings["en-US"].title, "Batched");
  assert.equal(play.edits.size, 0);
});

test("get_listing reads through a temporary edit and deletes it", async () => {
  const play = fakePlay();
  const out = await tool("get_listing").run({ packageName: PKG, language: "en-US" });
  assert.equal(out.title, "Old title");
  assert.deepEqual(play.log, ["POST /edits", "GET /edits/E1/listings/en-US", "DELETE /edits/E1"]);
});

test("create_release puts one release on the track", async () => {
  const play = fakePlay();
  await tool("create_release").run({
    packageName: PKG,
    track: "internal",
    versionCodes: [50],
    status: "completed",
    releaseNotes: [{ language: "en-US", text: "Hello" }],
  });
  assert.deepEqual(play.live.tracks.internal, {
    track: "internal",
    releases: [{ status: "completed", versionCodes: ["50"], releaseNotes: [{ language: "en-US", text: "Hello" }] }],
  });
});

test("create_release rejects a bad rollout before opening an edit", async () => {
  const play = fakePlay();
  await assert.rejects(
    tool("create_release").run({ packageName: PKG, track: "production", versionCodes: [50], status: "inProgress" }),
    /needs a userFraction/,
  );
  assert.deepEqual(play.log, []);
});

test("set_rollout_fraction / halt / complete act on the staged production release", async () => {
  const play = fakePlay();
  const up = await tool("set_rollout_fraction").run({ packageName: PKG, userFraction: 0.5 });
  assert.equal(up.result.before.userFraction, 0.1);
  assert.deepEqual(play.live.tracks.production.releases, [{ status: "inProgress", versionCodes: ["42"], userFraction: 0.5 }]);

  await tool("halt_rollout").run({ packageName: PKG });
  assert.equal(play.live.tracks.production.releases[0].status, "halted");

  await tool("resume_rollout").run({ packageName: PKG });
  assert.equal(play.live.tracks.production.releases[0].status, "inProgress");

  await tool("complete_rollout").run({ packageName: PKG });
  assert.deepEqual(play.live.tracks.production.releases, [{ status: "completed", versionCodes: ["42"] }]);
  assert.equal(play.edits.size, 0);
});

test("promote_release copies version codes and notes to the target track", async () => {
  const play = fakePlay();
  await tool("promote_release").run({ packageName: PKG, fromTrack: "internal", toTrack: "production", userFraction: 0.2 });
  assert.deepEqual(play.live.tracks.production.releases, [
    { status: "inProgress", versionCodes: ["43"], userFraction: 0.2, releaseNotes: [{ language: "en-US", text: "New" }] },
  ]);
});

test("an invalid packageName is rejected before any request", async () => {
  const play = fakePlay();
  await assert.rejects(tool("get_listing").run({ packageName: "../oops", language: "en-US" }), /not a valid packageName/);
  assert.deepEqual(play.log, []);
});
