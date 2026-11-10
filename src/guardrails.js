// Safe-mode guardrails: tool-level enforcement of read-only / category blocks.
// Extracted so it can be unit-tested without a live server.

// Tools that change Google Play state (or restore saved state onto it).
// Read tools that need an edit (get_listing, list_images, get_track, ...) open
// a temporary edit and delete it again; they change nothing and are not writes.
export const WRITE_TOOLS = new Set([
  // edit sessions
  "insert_edit",
  "validate_edit",
  "commit_edit",
  "delete_edit",
  // store listing / texts
  "update_listing",
  "delete_listing",
  "bulk_upsert_listings",
  "update_app_details",
  // images / screenshots
  "upload_image",
  "delete_image",
  "delete_all_images",
  "replace_images",
  // builds
  "upload_bundle",
  "upload_apk",
  "upload_deobfuscation_file",
  "upload_internal_app_sharing",
  // tracks / releases
  "update_track",
  "create_release",
  "promote_release",
  "set_rollout_fraction",
  "halt_rollout",
  "resume_rollout",
  "complete_rollout",
  // testers
  "update_testers",
  // in-app products (legacy one-time)
  "create_inapp_product",
  "update_inapp_product",
  "delete_inapp_product",
  // subscriptions, base plans, offers
  "create_subscription",
  "update_subscription",
  "delete_subscription",
  "activate_base_plan",
  "deactivate_base_plan",
  "delete_base_plan",
  "migrate_base_plan_prices",
  "create_subscription_offer",
  "update_subscription_offer",
  "delete_subscription_offer",
  "activate_subscription_offer",
  "deactivate_subscription_offer",
  // reviews
  "reply_to_review",
  // snapshots
  "restore_listing",
]);

// High-impact categories with their own opt-out env flags.
export const CATEGORY_TOOLS = {
  // Only when the call targets a production track (see isProductionTrack).
  // halt_rollout is deliberately absent: stopping a bad rollout is the safe
  // direction and stays available unless the server is fully read-only.
  PRODUCTION_RELEASE: new Set([
    "update_track",
    "create_release",
    "promote_release",
    "set_rollout_fraction",
    "resume_rollout",
    "complete_rollout",
  ]),
  // update_inapp_product / update_subscription join this category only when
  // the call actually carries prices (see touchesPrices).
  PRICE_CHANGES: new Set(["migrate_base_plan_prices"]),
  REVIEW_REPLIES: new Set(["reply_to_review"]),
  SUBSCRIPTION_ACTIVATION: new Set([
    "activate_base_plan",
    "deactivate_base_plan",
    "activate_subscription_offer",
    "deactivate_subscription_offer",
  ]),
};

/** Parse an env var as a boolean, with a default when unset/blank. */
export function envBool(value, dflt = false) {
  if (value === undefined || value === null || value === "") return dflt;
  return /^(1|true|yes|on)$/i.test(String(value).trim());
}

/** 'production', plus form-factor tracks like 'wear:production'. */
export function isProductionTrack(track) {
  return typeof track === "string" && /(^|:)production$/i.test(track.trim());
}

const RAW_PRODUCTION_PATH = /\/tracks\/([^/?]*(:|%3A))?production(\/|\?|$)/i;
const RAW_REPLY_PATH = /\/reviews\/[^/]+:reply/i;
const RAW_PRICE_PATH = /:(batch)?migratePrices/i;
const RAW_ACTIVATION_PATH = /:(de)?activate|:batchUpdateStates/i;

/** Does this call change prices of an existing product? */
function touchesPrices(name, args) {
  if (CATEGORY_TOOLS.PRICE_CHANGES.has(name)) return true;
  if (name === "update_inapp_product") {
    const p = args.product || {};
    return p.defaultPrice !== undefined || p.prices !== undefined;
  }
  if (name === "update_subscription") {
    const s = args.subscription || {};
    return s.basePlans !== undefined || /basePlans/i.test(args.updateMask || "");
  }
  if (name === "raw_request") return RAW_PRICE_PATH.test(args.path || "");
  return false;
}

/** Which high-impact categories does this (write) call fall into? */
export function categoriesFor(name, args = {}) {
  const cats = [];
  if (name === "raw_request") {
    const path = args.path || "";
    if (RAW_PRODUCTION_PATH.test(path)) cats.push("PRODUCTION_RELEASE");
    if (RAW_REPLY_PATH.test(path)) cats.push("REVIEW_REPLIES");
    if (RAW_ACTIVATION_PATH.test(path)) cats.push("SUBSCRIPTION_ACTIVATION");
  } else {
    if (CATEGORY_TOOLS.PRODUCTION_RELEASE.has(name)) {
      // promote_release is judged by where the build is going.
      const target = name === "promote_release" ? args.toTrack : args.track;
      // The rollout tools default to the production track when none is given.
      const dflt = /rollout/.test(name) ? "production" : undefined;
      if (isProductionTrack(target ?? dflt)) cats.push("PRODUCTION_RELEASE");
    }
    if (CATEGORY_TOOLS.REVIEW_REPLIES.has(name)) cats.push("REVIEW_REPLIES");
    if (CATEGORY_TOOLS.SUBSCRIPTION_ACTIVATION.has(name))
      cats.push("SUBSCRIPTION_ACTIVATION");
  }
  if (touchesPrices(name, args)) cats.push("PRICE_CHANGES");
  return cats;
}

/** Is this tool call a write? raw_request is a write unless GET. */
export function isWriteTool(name, args = {}) {
  if (name === "raw_request") {
    const m = (args.method || "GET").toUpperCase();
    return m !== "GET";
  }
  return WRITE_TOOLS.has(name);
}

const GATES = [
  ["PRODUCTION_RELEASE", "PLAY_MCP_ALLOW_PRODUCTION_RELEASE", "releasing to production / changing a production rollout"],
  ["PRICE_CHANGES", "PLAY_MCP_ALLOW_PRICE_CHANGES", "changing prices"],
  ["REVIEW_REPLIES", "PLAY_MCP_ALLOW_REVIEW_REPLIES", "posting public review replies"],
  ["SUBSCRIPTION_ACTIVATION", "PLAY_MCP_ALLOW_SUBSCRIPTION_ACTIVATION", "activating/deactivating subscription base plans and offers"],
];

/**
 * Return a human-readable reason this tool call is blocked by the current env,
 * or null if it's allowed. `env` defaults to process.env.
 */
export function writeBlockReason(name, args = {}, env = process.env) {
  if (!isWriteTool(name, args)) return null;
  if (envBool(env.PLAY_MCP_READ_ONLY)) {
    return "Blocked: the server is in READ-ONLY mode (PLAY_MCP_READ_ONLY=true). Unset it to allow writes.";
  }
  const cats = categoriesFor(name, args);
  for (const [cat, flag, label] of GATES) {
    if (cats.includes(cat) && envBool(env[flag], true) === false) {
      return `Blocked: ${label} is disabled (${flag}=false). Set ${flag}=true to allow it.`;
    }
  }
  return null;
}

/** Summarize the current write-mode for the doctor tool. */
export function writeModeSummary(env = process.env) {
  return {
    readOnly: envBool(env.PLAY_MCP_READ_ONLY),
    allowProductionRelease: envBool(env.PLAY_MCP_ALLOW_PRODUCTION_RELEASE, true),
    allowPriceChanges: envBool(env.PLAY_MCP_ALLOW_PRICE_CHANGES, true),
    allowReviewReplies: envBool(env.PLAY_MCP_ALLOW_REVIEW_REPLIES, true),
    allowSubscriptionActivation: envBool(env.PLAY_MCP_ALLOW_SUBSCRIPTION_ACTIVATION, true),
  };
}
