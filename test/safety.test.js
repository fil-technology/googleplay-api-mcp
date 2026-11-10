import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LIMITS,
  IMAGE_TYPES,
  validateAttributes,
  validateReleaseNotes,
  validateReplyText,
  assertPackageName,
  buildDiff,
} from "../src/validation.js";
import {
  WRITE_TOOLS,
  CATEGORY_TOOLS,
  isWriteTool,
  isProductionTrack,
  categoriesFor,
  writeBlockReason,
  envBool,
  writeModeSummary,
} from "../src/guardrails.js";
import { tools } from "../src/index.js";

// ---- Validation: listing length limits ----

test("listing limits are 30 / 80 / 4000", () => {
  assert.deepEqual(LIMITS, { title: 30, shortDescription: 80, fullDescription: 4000 });
});

test("title over 30 chars produces a warning; exactly 30 is fine", () => {
  const w = validateAttributes({ title: "x".repeat(31) });
  assert.equal(w.length, 1);
  assert.match(w[0], /exceeds Google Play's limit of 30/);
  assert.deepEqual(validateAttributes({ title: "x".repeat(30) }), []);
});

test("short and full description limits are enforced", () => {
  assert.equal(validateAttributes({ shortDescription: "x".repeat(81) }).length, 1);
  assert.equal(validateAttributes({ shortDescription: "x".repeat(80) }).length, 0);
  assert.equal(validateAttributes({ fullDescription: "x".repeat(4001) }).length, 1);
  assert.equal(validateAttributes({ video: "https://youtu.be/" + "x".repeat(200) }).length, 0);
});

test("buildDiff flags an over-limit change", () => {
  const d = buildDiff({ title: "Old" }, { title: "x".repeat(40) });
  assert.equal(d[0].from, "Old");
  assert.equal(d[0].changed, true);
  assert.equal(d[0].exceedsLimit, true);
  assert.equal(d[0].newLength, 40);
  assert.equal(buildDiff({ title: "Same" }, { title: "Same" })[0].changed, false);
  assert.equal(buildDiff({}, { title: "New" })[0].from, null);
});

test("release notes over 500 chars and malformed notes warn", () => {
  assert.deepEqual(validateReleaseNotes([{ language: "en-US", text: "x".repeat(500) }]), []);
  assert.match(validateReleaseNotes([{ language: "en-US", text: "x".repeat(501) }])[0], /limit of 500/);
  assert.equal(validateReleaseNotes([{ text: "no language" }]).length, 1);
  assert.deepEqual(validateReleaseNotes(undefined), []);
});

test("review replies over ~350 chars warn", () => {
  assert.deepEqual(validateReplyText("Thanks!"), []);
  assert.equal(validateReplyText("x".repeat(351)).length, 1);
});

test("package names are sanity-checked", () => {
  assert.equal(assertPackageName("com.example.app"), "com.example.app");
  assert.equal(assertPackageName("technology.fil.Speaker_Mate2"), "technology.fil.Speaker_Mate2");
  for (const bad of ["", "app", "com..app", "com.example/app", "../etc", "123456789", undefined])
    assert.throws(() => assertPackageName(bad), /not a valid packageName/, String(bad));
});

test("image types match the API enum", () => {
  assert.deepEqual([...IMAGE_TYPES].sort(), [
    "featureGraphic", "icon", "phoneScreenshots", "sevenInchScreenshots",
    "tenInchScreenshots", "tvBanner", "tvScreenshots", "wearScreenshots",
  ]);
});

// ---- Guardrails: writes are blocked when the env says so ----

test("read tools are never writes", () => {
  for (const n of ["list_listings", "get_listing", "list_tracks", "list_reviews", "doctor", "list_subscriptions", "convert_region_prices", "snapshot_listing", "reporting_request", "get_edit"])
    assert.equal(isWriteTool(n), false, n);
});

test("write tools are detected", () => {
  for (const n of ["update_listing", "upload_bundle", "create_release", "reply_to_review", "insert_edit", "commit_edit", "restore_listing", "migrate_base_plan_prices"])
    assert.equal(isWriteTool(n), true, n);
});

test("raw_request is a write only for non-GET", () => {
  assert.equal(isWriteTool("raw_request", { method: "GET" }), false);
  assert.equal(isWriteTool("raw_request", {}), false);
  for (const method of ["POST", "PUT", "PATCH", "DELETE", "post"])
    assert.equal(isWriteTool("raw_request", { method }), true, method);
});

test("READ_ONLY blocks all writes but not reads", () => {
  const env = { PLAY_MCP_READ_ONLY: "true" };
  for (const n of WRITE_TOOLS) assert.match(writeBlockReason(n, {}, env), /READ-ONLY/, n);
  assert.match(writeBlockReason("raw_request", { method: "DELETE", path: "/x" }, env), /READ-ONLY/);
  assert.equal(writeBlockReason("list_listings", {}, env), null);
  assert.equal(writeBlockReason("doctor", {}, env), null);
  assert.equal(writeBlockReason("raw_request", { method: "GET", path: "/x" }, env), null);
});

test("READ_ONLY also blocks dry-runs of write tools (they still call mutating endpoints)", () => {
  assert.match(
    writeBlockReason("update_listing", { dryRun: true }, { PLAY_MCP_READ_ONLY: "1" }),
    /READ-ONLY/,
  );
});

test("with no env set, every write is allowed", () => {
  for (const n of WRITE_TOOLS)
    assert.equal(writeBlockReason(n, { track: "production", toTrack: "production" }, {}), null, n);
});

test("isProductionTrack covers form-factor production tracks", () => {
  for (const t of ["production", "wear:production", "automotive:production", "Production"])
    assert.equal(isProductionTrack(t), true, t);
  for (const t of ["internal", "alpha", "beta", "my-production-qa", "production-like", undefined, 7])
    assert.equal(isProductionTrack(t), false, String(t));
});

test("ALLOW_PRODUCTION_RELEASE=false blocks production releases only", () => {
  const env = { PLAY_MCP_ALLOW_PRODUCTION_RELEASE: "false" };
  assert.match(writeBlockReason("create_release", { track: "production" }, env), /PLAY_MCP_ALLOW_PRODUCTION_RELEASE=false/);
  assert.match(writeBlockReason("update_track", { track: "wear:production" }, env), /production/);
  assert.equal(writeBlockReason("create_release", { track: "internal" }, env), null);
  assert.equal(writeBlockReason("create_release", { track: "beta" }, env), null);
  assert.equal(writeBlockReason("upload_bundle", {}, env), null);
  assert.equal(writeBlockReason("update_listing", {}, env), null);
});

test("promote_release is judged by its destination track", () => {
  const env = { PLAY_MCP_ALLOW_PRODUCTION_RELEASE: "false" };
  assert.match(writeBlockReason("promote_release", { fromTrack: "beta", toTrack: "production" }, env), /Blocked/);
  assert.equal(writeBlockReason("promote_release", { fromTrack: "production", toTrack: "beta" }, env), null);
  assert.equal(writeBlockReason("promote_release", { fromTrack: "internal", toTrack: "alpha" }, env), null);
});

test("rollout % changes default to production and are gated; halting is not", () => {
  const env = { PLAY_MCP_ALLOW_PRODUCTION_RELEASE: "false" };
  for (const n of ["set_rollout_fraction", "resume_rollout", "complete_rollout"]) {
    assert.match(writeBlockReason(n, {}, env), /Blocked/, `${n} (default track)`);
    assert.match(writeBlockReason(n, { track: "production" }, env), /Blocked/, n);
    assert.equal(writeBlockReason(n, { track: "beta" }, env), null, `${n} beta`);
  }
  // The emergency brake stays available…
  assert.equal(writeBlockReason("halt_rollout", {}, env), null);
  // …unless the server is fully read-only.
  assert.match(writeBlockReason("halt_rollout", {}, { PLAY_MCP_READ_ONLY: "true" }), /READ-ONLY/);
});

test("ALLOW_PRICE_CHANGES=false blocks price changes, not other product edits", () => {
  const env = { PLAY_MCP_ALLOW_PRICE_CHANGES: "false" };
  assert.match(writeBlockReason("migrate_base_plan_prices", {}, env), /PLAY_MCP_ALLOW_PRICE_CHANGES=false/);
  assert.match(writeBlockReason("update_inapp_product", { product: { defaultPrice: { priceMicros: "1", currency: "USD" } } }, env), /changing prices/);
  assert.match(writeBlockReason("update_inapp_product", { product: { prices: {} } }, env), /changing prices/);
  assert.equal(writeBlockReason("update_inapp_product", { product: { status: "inactive" } }, env), null);
  assert.match(writeBlockReason("update_subscription", { subscription: { basePlans: [] }, updateMask: "basePlans" }, env), /changing prices/);
  assert.match(writeBlockReason("update_subscription", { subscription: {}, updateMask: "listings,basePlans" }, env), /changing prices/);
  assert.equal(writeBlockReason("update_subscription", { subscription: { listings: [] }, updateMask: "listings" }, env), null);
  assert.equal(writeBlockReason("create_release", { track: "production" }, env), null);
});

test("ALLOW_REVIEW_REPLIES=false blocks replies only", () => {
  const env = { PLAY_MCP_ALLOW_REVIEW_REPLIES: "false" };
  assert.match(writeBlockReason("reply_to_review", {}, env), /PLAY_MCP_ALLOW_REVIEW_REPLIES=false/);
  assert.equal(writeBlockReason("list_reviews", {}, env), null);
  assert.equal(writeBlockReason("update_listing", {}, env), null);
});

test("ALLOW_SUBSCRIPTION_ACTIVATION=false blocks (de)activation only", () => {
  const env = { PLAY_MCP_ALLOW_SUBSCRIPTION_ACTIVATION: "false" };
  for (const n of CATEGORY_TOOLS.SUBSCRIPTION_ACTIVATION)
    assert.match(writeBlockReason(n, {}, env), /PLAY_MCP_ALLOW_SUBSCRIPTION_ACTIVATION=false/, n);
  assert.equal(writeBlockReason("create_subscription", {}, env), null);
  assert.equal(writeBlockReason("create_subscription_offer", {}, env), null);
});

test("raw_request cannot be used to sidestep the category gates", () => {
  const P = "/applications/com.example.app";
  assert.match(
    writeBlockReason("raw_request", { method: "PUT", path: `${P}/edits/1/tracks/production` }, { PLAY_MCP_ALLOW_PRODUCTION_RELEASE: "false" }),
    /PLAY_MCP_ALLOW_PRODUCTION_RELEASE/,
  );
  assert.match(
    writeBlockReason("raw_request", { method: "PATCH", path: `${P}/edits/1/tracks/wear%3Aproduction` }, { PLAY_MCP_ALLOW_PRODUCTION_RELEASE: "false" }),
    /Blocked/,
  );
  assert.equal(
    writeBlockReason("raw_request", { method: "PUT", path: `${P}/edits/1/tracks/internal` }, { PLAY_MCP_ALLOW_PRODUCTION_RELEASE: "false" }),
    null,
  );
  assert.equal(
    writeBlockReason("raw_request", { method: "GET", path: `${P}/edits/1/tracks/production` }, { PLAY_MCP_ALLOW_PRODUCTION_RELEASE: "false" }),
    null,
  );
  assert.match(
    writeBlockReason("raw_request", { method: "POST", path: `${P}/reviews/abc:reply` }, { PLAY_MCP_ALLOW_REVIEW_REPLIES: "false" }),
    /REVIEW_REPLIES/,
  );
  assert.match(
    writeBlockReason("raw_request", { method: "POST", path: `${P}/subscriptions/s/basePlans/b:migratePrices` }, { PLAY_MCP_ALLOW_PRICE_CHANGES: "false" }),
    /PRICE_CHANGES/,
  );
  assert.match(
    writeBlockReason("raw_request", { method: "POST", path: `${P}/subscriptions/s/basePlans/b:activate` }, { PLAY_MCP_ALLOW_SUBSCRIPTION_ACTIVATION: "false" }),
    /SUBSCRIPTION_ACTIVATION/,
  );
});

test("categoriesFor reports every category a call falls into", () => {
  assert.deepEqual(categoriesFor("create_release", { track: "production" }), ["PRODUCTION_RELEASE"]);
  assert.deepEqual(categoriesFor("create_release", { track: "internal" }), []);
  assert.deepEqual(categoriesFor("update_listing", {}), []);
});

test("envBool parses truthy strings and honours the default", () => {
  for (const v of ["1", "true", "TRUE", "yes", "on", " true "]) assert.equal(envBool(v), true, v);
  for (const v of ["0", "false", "no", "off", "nope"]) assert.equal(envBool(v, true), false, v);
  assert.equal(envBool(undefined, true), true);
  assert.equal(envBool("", true), true);
  assert.equal(envBool(undefined), false);
});

test("writeModeSummary reflects the env", () => {
  assert.deepEqual(writeModeSummary({}), {
    readOnly: false,
    allowProductionRelease: true,
    allowPriceChanges: true,
    allowReviewReplies: true,
    allowSubscriptionActivation: true,
  });
  const s = writeModeSummary({ PLAY_MCP_READ_ONLY: "true", PLAY_MCP_ALLOW_PRICE_CHANGES: "false" });
  assert.equal(s.readOnly, true);
  assert.equal(s.allowPriceChanges, false);
});

// ---- Tool registry ----

test("no duplicate tool names", () => {
  const names = tools.map((t) => t.name);
  const dupes = names.filter((n, i) => names.indexOf(n) !== i);
  assert.deepEqual(dupes, []);
});

test("every tool has a name, description, object schema and run()", () => {
  for (const t of tools) {
    assert.match(t.name, /^[a-z][a-z0-9_]*$/, t.name);
    assert.ok(t.description && t.description.length > 20, `${t.name} description`);
    assert.equal(t.inputSchema.type, "object", t.name);
    assert.equal(typeof t.run, "function", t.name);
    for (const r of t.inputSchema.required || [])
      assert.ok(t.inputSchema.properties[r], `${t.name}: required '${r}' is not a declared property`);
  }
});

test("every guarded tool name exists in the registry (no stale gates)", () => {
  const names = new Set(tools.map((t) => t.name));
  for (const n of WRITE_TOOLS) assert.ok(names.has(n), `WRITE_TOOLS has unknown tool '${n}'`);
  for (const [cat, set] of Object.entries(CATEGORY_TOOLS))
    for (const n of set) {
      assert.ok(names.has(n), `${cat} has unknown tool '${n}'`);
      assert.ok(WRITE_TOOLS.has(n), `${cat} tool '${n}' is not in WRITE_TOOLS`);
    }
});

test("every tool that takes an editId / dryRun-in-edit is registered as a write", () => {
  for (const t of tools) {
    const p = t.inputSchema.properties || {};
    if (p.changesNotSentForReview && t.name !== "commit_edit")
      assert.ok(WRITE_TOOLS.has(t.name), `${t.name} commits edits but is not in WRITE_TOOLS`);
  }
});

test("credentials are never accepted as tool arguments", () => {
  for (const t of tools)
    for (const key of Object.keys(t.inputSchema.properties || {}))
      assert.doesNotMatch(key, /private_?key|credential|service_?account|password|secret|access_?token/i, `${t.name}.${key}`);
});
