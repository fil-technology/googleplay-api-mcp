import { test } from "node:test";
import assert from "node:assert/strict";
import { withEdit, readInEdit } from "../src/edits.js";
import { buildRelease, pickRelease, rolloutUpdate } from "../src/releases.js";

const PKG = "com.example.app";
const BASE = `/applications/${PKG}/edits`;

/** Fake client that records calls; `failOn(method, path)` makes one throw. */
function fakeClient(failOn = () => false) {
  const calls = [];
  const call = (method) => async (path, body, query) => {
    calls.push(`${method} ${path}`);
    if (failOn(method, path)) throw Object.assign(new Error(`${method} ${path} failed`), { status: 400 });
    if (method === "POST" && path === BASE) return { id: "E1", expiryTimeSeconds: "1" };
    if (method === "POST" && path.endsWith(":commit")) return { id: "E1", query };
    return {};
  };
  return { calls, post: call("POST"), get: call("GET"), put: call("PUT"), patch: call("PATCH"), delete: call("DELETE") };
}

// ---- The edit lifecycle: never leave a dangling edit ----

test("default: insert → mutate → validate → commit, and no delete", async () => {
  const c = fakeClient();
  const out = await withEdit(c, { packageName: PKG }, async (editId) => {
    await c.patch(`${BASE}/${editId}/listings/en-US`);
    return { done: true };
  });
  assert.deepEqual(c.calls, [
    `POST ${BASE}`,
    `PATCH ${BASE}/E1/listings/en-US`,
    `POST ${BASE}/E1:validate`,
    `POST ${BASE}/E1:commit`,
  ]);
  assert.equal(out.committed, true);
  assert.deepEqual(out.result, { done: true });
});

test("dryRun: insert → mutate → validate → DELETE, never commit", async () => {
  const c = fakeClient();
  const out = await withEdit(c, { packageName: PKG, dryRun: true }, async () => ({ preview: 1 }));
  assert.deepEqual(c.calls, [`POST ${BASE}`, `POST ${BASE}/E1:validate`, `DELETE ${BASE}/E1`]);
  assert.equal(out.dryRun, true);
  assert.deepEqual(out.validation, { ok: true });
  assert.deepEqual(out.result, { preview: 1 });
  assert.match(out.note, /No changes were written/);
});

test("dryRun: a validation failure is reported (not thrown) and the edit is still deleted", async () => {
  const c = fakeClient((m, p) => p.endsWith(":validate"));
  const out = await withEdit(c, { packageName: PKG, dryRun: true }, async () => ({ preview: 1 }));
  assert.equal(out.validation.ok, false);
  assert.match(out.validation.error, /validate failed/);
  assert.equal(c.calls.at(-1), `DELETE ${BASE}/E1`);
  assert.ok(!c.calls.some((x) => x.endsWith(":commit")));
});

test("dryRun: a failing mutation deletes the edit and rethrows", async () => {
  const c = fakeClient();
  await assert.rejects(
    withEdit(c, { packageName: PKG, dryRun: true }, async () => {
      throw new Error("boom");
    }),
    /boom/,
  );
  assert.deepEqual(c.calls, [`POST ${BASE}`, `DELETE ${BASE}/E1`]);
});

test("a failing mutation deletes the edit and never commits", async () => {
  const c = fakeClient();
  await assert.rejects(
    withEdit(c, { packageName: PKG }, async () => {
      throw new Error("upload rejected");
    }),
    /upload rejected \(the edit was discarded — nothing was changed\)/,
  );
  assert.deepEqual(c.calls, [`POST ${BASE}`, `DELETE ${BASE}/E1`]);
});

test("a failing validate deletes the edit and never commits", async () => {
  const c = fakeClient((m, p) => p.endsWith(":validate"));
  await assert.rejects(withEdit(c, { packageName: PKG }, async () => ({})), /discarded/);
  assert.deepEqual(c.calls, [`POST ${BASE}`, `POST ${BASE}/E1:validate`, `DELETE ${BASE}/E1`]);
});

test("a failing commit deletes the edit", async () => {
  const c = fakeClient((m, p) => p.endsWith(":commit"));
  await assert.rejects(withEdit(c, { packageName: PKG }, async () => ({})), /commit failed/);
  assert.equal(c.calls.at(-1), `DELETE ${BASE}/E1`);
});

test("if even the cleanup delete fails, the error names the dangling edit", async () => {
  const c = fakeClient((m, p) => m === "DELETE" || p.endsWith(":commit"));
  await assert.rejects(
    withEdit(c, { packageName: PKG }, async () => ({})),
    /NOT committed; deleting edit E1 also failed.*delete_edit/,
  );
});

test("caller-supplied editId: mutate only — no insert, validate, commit or delete", async () => {
  const c = fakeClient();
  const out = await withEdit(c, { packageName: PKG, editId: "MINE", dryRun: true }, async (editId) => {
    await c.put(`${BASE}/${editId}/tracks/internal`);
    return {};
  });
  assert.deepEqual(c.calls, [`PUT ${BASE}/MINE/tracks/internal`]);
  assert.equal(out.committed, false);
  assert.equal(out.editId, "MINE");
  assert.match(out.note, /commit_edit/);
});

test("a failure inside a caller-supplied edit leaves that edit alone", async () => {
  const c = fakeClient();
  await assert.rejects(
    withEdit(c, { packageName: PKG, editId: "MINE" }, async () => {
      throw new Error("nope");
    }),
    /^Error: nope$/,
  );
  assert.deepEqual(c.calls, []);
});

test("commit options are forwarded as query params", async () => {
  const seen = [];
  const c = fakeClient();
  const post = c.post;
  c.post = async (path, body, query) => {
    if (path.endsWith(":commit")) seen.push(query);
    return post(path, body, query);
  };
  await withEdit(c, { packageName: PKG, changesNotSentForReview: true }, async () => ({}));
  assert.deepEqual(seen, [{ changesNotSentForReview: true }]);
});

test("readInEdit opens a temporary edit and always deletes it", async () => {
  const c = fakeClient();
  const out = await readInEdit(c, { packageName: PKG }, async (editId) => {
    await c.get(`${BASE}/${editId}/listings`);
    return "data";
  });
  assert.equal(out, "data");
  assert.deepEqual(c.calls, [`POST ${BASE}`, `GET ${BASE}/E1/listings`, `DELETE ${BASE}/E1`]);

  const c2 = fakeClient((m) => m === "GET");
  await assert.rejects(readInEdit(c2, { packageName: PKG }, (id) => c2.get(`${BASE}/${id}/listings`)));
  assert.equal(c2.calls.at(-1), `DELETE ${BASE}/E1`);
});

test("readInEdit with a caller editId reads from it and does not delete it", async () => {
  const c = fakeClient();
  await readInEdit(c, { packageName: PKG, editId: "MINE" }, (id) => c.get(`${BASE}/${id}/details`));
  assert.deepEqual(c.calls, [`GET ${BASE}/MINE/details`]);
});

// ---- Releases / staged rollout rules ----

test("buildRelease: a full rollout", () => {
  const { release, warnings } = buildRelease({ versionCodes: [42], status: "completed" });
  assert.deepEqual(release, { status: "completed", versionCodes: ["42"] });
  assert.deepEqual(warnings, []);
});

test("buildRelease: a staged rollout carries userFraction and notes", () => {
  const { release } = buildRelease({
    versionCodes: ["42", 43],
    status: "inProgress",
    userFraction: 0.1,
    name: "1.2.0",
    releaseNotes: [{ language: "en-US", text: "Fixes" }],
    inAppUpdatePriority: 3,
  });
  assert.deepEqual(release, {
    status: "inProgress",
    versionCodes: ["42", "43"],
    userFraction: 0.1,
    name: "1.2.0",
    releaseNotes: [{ language: "en-US", text: "Fixes" }],
    inAppUpdatePriority: 3,
  });
});

test("buildRelease rejects invalid combinations before any API call", () => {
  assert.throws(() => buildRelease({ versionCodes: [1], status: "live" }), /status must be one of/);
  assert.throws(() => buildRelease({ versionCodes: [], status: "draft" }), /versionCodes is required/);
  assert.throws(() => buildRelease({ versionCodes: ["1.2"], status: "draft" }), /integers/);
  assert.throws(() => buildRelease({ versionCodes: [1], status: "inProgress" }), /needs a userFraction/);
  assert.throws(() => buildRelease({ versionCodes: [1], status: "completed", userFraction: 0.5 }), /only be set when status/);
  for (const f of [0, 1, 1.5, -0.1, "0.5"])
    assert.throws(() => buildRelease({ versionCodes: [1], status: "inProgress", userFraction: f }), /strictly between 0 and 1/, String(f));
  assert.throws(() => buildRelease({ versionCodes: [1], status: "draft", inAppUpdatePriority: 6 }), /0 to 5/);
});

test("buildRelease warns on over-long release notes", () => {
  const { warnings } = buildRelease({
    versionCodes: [1],
    status: "draft",
    releaseNotes: [{ language: "en-US", text: "x".repeat(501) }],
  });
  assert.equal(warnings.length, 1);
});

const TRACK = {
  track: "production",
  releases: [
    { status: "completed", versionCodes: ["40"] },
    { status: "inProgress", versionCodes: ["42"], userFraction: 0.1, name: "1.2.0" },
  ],
};

test("pickRelease: by version code, by status, or the newest", () => {
  assert.equal(pickRelease(TRACK, { versionCode: 40 }).status, "completed");
  assert.equal(pickRelease(TRACK, { versionCode: 99 }), null);
  assert.deepEqual(pickRelease(TRACK, { statuses: ["inProgress"] }).versionCodes, ["42"]);
  assert.deepEqual(pickRelease(TRACK).versionCodes, ["42"]);
  assert.equal(pickRelease({ releases: [] }), null);
});

test("rolloutUpdate: raise the fraction", () => {
  const { before, after } = rolloutUpdate(TRACK, "setFraction", { userFraction: 0.5 });
  assert.equal(before.userFraction, 0.1);
  assert.deepEqual(after, { status: "inProgress", versionCodes: ["42"], userFraction: 0.5, name: "1.2.0" });
  assert.equal(TRACK.releases[1].userFraction, 0.1, "input is not mutated");
  assert.throws(() => rolloutUpdate(TRACK, "setFraction", { userFraction: 1 }), /complete_rollout/);
});

test("rolloutUpdate: halt keeps the fraction; resume restores inProgress", () => {
  const halted = rolloutUpdate(TRACK, "halt").after;
  assert.deepEqual(halted, { status: "halted", versionCodes: ["42"], userFraction: 0.1, name: "1.2.0" });
  const resumed = rolloutUpdate({ track: "production", releases: [halted] }, "resume").after;
  assert.equal(resumed.status, "inProgress");
  assert.equal(resumed.userFraction, 0.1);
  assert.throws(() => rolloutUpdate(TRACK, "resume"), /No halted release/);
});

test("rolloutUpdate: complete drops userFraction", () => {
  const { after } = rolloutUpdate(TRACK, "complete");
  assert.deepEqual(after, { status: "completed", versionCodes: ["42"], name: "1.2.0" });
});

test("rolloutUpdate refuses when there is no staged release", () => {
  const full = { track: "production", releases: [{ status: "completed", versionCodes: ["40"] }] };
  assert.throws(() => rolloutUpdate(full, "setFraction", { userFraction: 0.2 }), /No staged/);
  assert.throws(() => rolloutUpdate(full, "complete", { versionCode: 40 }), /not a staged rollout/);
  assert.throws(() => rolloutUpdate(full, "halt"), /No staged/);
});
