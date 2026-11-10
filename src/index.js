#!/usr/bin/env node
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  statSync,
  realpathSync,
} from "node:fs";
import { basename, extname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { GooglePlayClient } from "./client.js";
import {
  LIMITS,
  IMAGE_TYPES,
  validateAttributes,
  validateReplyText,
  assertPackageName,
  buildDiff,
} from "./validation.js";
import { writeBlockReason, writeModeSummary } from "./guardrails.js";
import { withEdit, readInEdit, editsPath, editPath } from "./edits.js";
import { RELEASE_STATUSES, buildRelease, pickRelease, rolloutUpdate } from "./releases.js";

const PKG_JSON = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);

// The client is created on first use so the server can start (and `doctor`
// can explain what's missing) even before credentials are configured.
let _client = null;
function api() {
  if (!_client) _client = new GooglePlayClient(GooglePlayClient.optionsFromEnv());
  return _client;
}
/** Test seam: inject a client (e.g. one with a mocked fetch). */
export function __setClient(client) {
  _client = client;
}

const ok = (data) => ({
  content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
});
const fail = (e) => ({
  content: [{ type: "text", text: `Error: ${e.message}` }],
  isError: true,
});

// ---- Shared helpers ---------------------------------------------------------
// LIMITS / validateAttributes / buildDiff live in ./validation.js, the edit
// lifecycle in ./edits.js, release/rollout rules in ./releases.js (unit-tested).

const enc = encodeURIComponent;

/** '/applications/{packageName}' (validated). */
const app = (a) => `/applications/${enc(assertPackageName(a.packageName))}`;
/** '/applications/{packageName}/edits/{editId}' (validated). */
const ep = (a, editId) => editPath(assertPackageName(a.packageName), editId);

/** Mutation inside an edit: auto-commit by default, dryRun, or caller's editId. */
const session = (a, fn) => {
  assertPackageName(a.packageName);
  return withEdit(api(), a, fn);
};
/** Read that needs an edit context (temporary edit is always deleted). */
const reading = (a, fn) => {
  assertPackageName(a.packageName);
  return readInEdit(api(), a, fn);
};

const pick = (a, keys) => {
  const out = {};
  for (const k of keys) if (a[k] !== undefined) out[k] = a[k];
  return out;
};

/** Attach non-blocking validation warnings to a result object. */
const withWarnings = (result, warnings) =>
  warnings && warnings.length ? { ...result, _warnings: warnings } : result;

// Default "regions version" for subscription pricing calls. Google requires
// one on create/patch/migrate; override per call or with PLAY_MCP_REGIONS_VERSION.
const DEFAULT_REGIONS_VERSION = process.env.PLAY_MCP_REGIONS_VERSION || "2022/02";
const regionsVersion = (a) => a.regionsVersion || DEFAULT_REGIONS_VERSION;

const SNAPSHOT_DIR =
  process.env.PLAY_MCP_SNAPSHOT_DIR ||
  join(homedir(), ".googleplay-api-mcp", "snapshots");

const IMAGE_CONTENT_TYPES = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg" };

function imageContentType(file) {
  const type = IMAGE_CONTENT_TYPES[extname(file).toLowerCase()];
  if (!type) throw new Error(`Unsupported image type for ${file} — Google Play accepts PNG or JPEG.`);
  return type;
}

function assertFile(file, extensions) {
  if (!file || !existsSync(file)) throw new Error(`File not found: ${file}`);
  if (extensions && !extensions.includes(extname(file).toLowerCase()))
    throw new Error(`${basename(file)} should be one of: ${extensions.join(", ")}`);
  return statSync(file).size;
}

function assertImageType(imageType) {
  if (!IMAGE_TYPES.includes(imageType))
    throw new Error(`imageType must be one of: ${IMAGE_TYPES.join(", ")}`);
  return imageType;
}

const LISTING_FIELDS = ["title", "shortDescription", "fullDescription", "video"];
const DETAILS_FIELDS = ["defaultLanguage", "contactEmail", "contactPhone", "contactWebsite"];

/** GET that returns null on 404 instead of throwing. */
async function getOrNull(path) {
  try {
    return await api().get(path);
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
}

/**
 * Create-or-update one language's listing inside an edit. Existing listings
 * are PATCHed (only the given fields change); a new language is PUT.
 */
async function applyListing(a, editId, language, attributes) {
  const path = `${ep(a, editId)}/listings/${enc(language)}`;
  const current = await getOrNull(path);
  const warnings = validateAttributes(attributes);
  const changes = buildDiff(current || {}, attributes);
  const listing = current
    ? await api().patch(path, attributes)
    : await api().put(path, { language, ...attributes });
  return withWarnings({ language, created: !current, changes, listing }, warnings);
}

/** Collect an app's editable text metadata (details + every listing). */
async function collectListing(a, { includeImages } = {}) {
  return reading(a, async (editId) => {
    const base = ep(a, editId);
    const details = await api().get(`${base}/details`);
    const listings = ((await api().get(`${base}/listings`)) || {}).listings || [];
    const snap = {
      packageName: a.packageName,
      takenAt: new Date().toISOString(),
      details,
      listings,
    };
    if (includeImages) {
      snap.images = {};
      for (const l of listings) {
        snap.images[l.language] = {};
        for (const type of IMAGE_TYPES) {
          const res = await api().get(`${base}/listings/${enc(l.language)}/${type}`);
          if (res && res.images && res.images.length) snap.images[l.language][type] = res.images;
        }
      }
    }
    return snap;
  });
}

function writeSnapshot(snap, label) {
  mkdirSync(SNAPSHOT_DIR, { recursive: true });
  const slug = snap.packageName.replace(/[^\w.-]/g, "_");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const tag = label ? `${String(label).replace(/[^\w.-]/g, "_")}-` : "";
  const file = join(SNAPSHOT_DIR, `${slug}-${tag}${stamp}.json`);
  writeFileSync(file, JSON.stringify(snap, null, 2));
  return file;
}

// Optional safety net: snapshot text metadata before the first listing write
// to each app in this session (PLAY_MCP_AUTO_SNAPSHOT=true).
const AUTO_SNAPSHOT_TOOLS = new Set([
  "update_listing",
  "delete_listing",
  "bulk_upsert_listings",
  "update_app_details",
  "restore_listing",
]);
const autoSnapshotted = new Set();
async function maybeAutoSnapshot(name, args) {
  if (!/^(1|true|yes|on)$/i.test(process.env.PLAY_MCP_AUTO_SNAPSHOT || "")) return;
  if (!AUTO_SNAPSHOT_TOOLS.has(name) || args.dryRun || !args.packageName) return;
  if (autoSnapshotted.has(args.packageName)) return;
  autoSnapshotted.add(args.packageName);
  try {
    const file = writeSnapshot(await collectListing(args), "auto");
    console.error(`Auto-snapshot saved: ${file}`);
  } catch (e) {
    console.error(`Auto-snapshot failed (continuing): ${e.message}`);
  }
}

/** Shared body for set_rollout_fraction / halt / resume / complete. */
const rolloutTool = (action) => async (a) => {
  const track = a.track || "production";
  return session(a, async (editId) => {
    const path = `${ep(a, editId)}/tracks/${enc(track)}`;
    const current = await api().get(path);
    const { before, after } = rolloutUpdate(current, action, a);
    const updated = await api().put(path, { track, releases: [after] });
    return { track, before, after, updated };
  });
};

// ---- Reusable input-schema fragments ----------------------------------------

const S = {
  packageName: {
    type: "string",
    description: "Application id (package name), e.g. com.example.app",
  },
  editId: {
    type: "string",
    description:
      "Optional: an open edit from insert_edit. The change is applied inside that edit and NOT committed — batch several changes, then call commit_edit.",
  },
  readEditId: {
    type: "string",
    description:
      "Optional: read from this open edit (to see uncommitted changes). Without it a temporary edit is opened and deleted.",
  },
  dryRun: {
    type: "boolean",
    description:
      "Preview only: open a temporary edit, apply, validate, then delete it. Nothing is published (default false). Ignored when editId is set.",
  },
  changesNotSentForReview: {
    type: "boolean",
    description:
      "Commit option: keep the changes out of review until sent from Play Console. Google requires this for some apps and rejects it for others — set it only if a commit error asks for it.",
  },
  language: { type: "string", description: "BCP-47 language tag, e.g. en-US, de-DE" },
  track: {
    type: "string",
    description:
      "Track name: internal, alpha (closed testing), beta (open testing), production, a custom closed-testing track name, or a form-factor track such as wear:production",
  },
  imageType: { type: "string", enum: IMAGE_TYPES },
  productId: { type: "string", description: "Subscription product id" },
  basePlanId: { type: "string" },
  offerId: { type: "string" },
  regionsVersion: {
    type: "string",
    description: `Regions version for regional prices (default ${DEFAULT_REGIONS_VERSION}; override the default with PLAY_MCP_REGIONS_VERSION)`,
  },
  latencyTolerance: {
    type: "string",
    enum: [
      "PRODUCT_UPDATE_LATENCY_TOLERANCE_LATENCY_SENSITIVE",
      "PRODUCT_UPDATE_LATENCY_TOLERANCE_LATENCY_TOLERANT",
    ],
    description: "Optional propagation latency tolerance (default latency-sensitive)",
  },
  releaseNotes: {
    type: "array",
    description: "What's new, per language (max 500 chars each)",
    items: {
      type: "object",
      properties: { language: { type: "string" }, text: { type: "string" } },
      required: ["language", "text"],
    },
  },
};

/** Props shared by every auto-commit mutation tool. */
const EDIT_WRITE = {
  editId: S.editId,
  dryRun: S.dryRun,
  changesNotSentForReview: S.changesNotSentForReview,
};

const obj = (properties, required = []) => ({ type: "object", properties, required });

// Reporting API metric sets (playdeveloperreporting v1beta1).
const METRIC_SETS = [
  "crashRateMetricSet",
  "anrRateMetricSet",
  "errorCountMetricSet",
  "excessiveWakeupRateMetricSet",
  "stuckBackgroundWakelockRateMetricSet",
  "slowStartRateMetricSet",
  "slowRenderingRateMetricSet",
  "lmkRateMetricSet",
  "anonRssAndSwapMemoryUsageMetricSet",
  "bitmapMemoryUsageMetricSet",
];
const reportingApp = (a) => `/v1beta1/apps/${enc(assertPackageName(a.packageName))}`;

// ---- Tools ------------------------------------------------------------------

export const tools = [
  // ---- Edits (low-level sessions) ----
  {
    name: "insert_edit",
    description:
      "Open a new edit (Google Play's transaction) for an app and return its editId. Use this only to BATCH several changes: pass the editId to the mutation tools, then call commit_edit once. Most tools open, validate and commit their own edit automatically, so you rarely need this. Always finish with commit_edit or delete_edit.",
    inputSchema: obj({ packageName: S.packageName }, ["packageName"]),
    run: async (a) => {
      assertPackageName(a.packageName);
      const edit = await api().post(editsPath(a.packageName));
      return {
        editId: edit.id,
        expiryTimeSeconds: edit.expiryTimeSeconds,
        note: "Pass editId to mutation tools, then commit_edit (or delete_edit to discard).",
      };
    },
  },
  {
    name: "get_edit",
    description: "Check that an edit is still open/valid and when it expires. Read-only.",
    inputSchema: obj({ packageName: S.packageName, editId: { type: "string" } }, ["packageName", "editId"]),
    run: async (a) => api().get(ep(a, a.editId)),
  },
  {
    name: "validate_edit",
    description:
      "Validate an open edit WITHOUT committing — Google runs the same checks as a commit and reports any problem. The Play-native dry run for a batched session.",
    inputSchema: obj({ packageName: S.packageName, editId: { type: "string" } }, ["packageName", "editId"]),
    run: async (a) => {
      await api().post(`${ep(a, a.editId)}:validate`);
      return { editId: a.editId, valid: true };
    },
  },
  {
    name: "commit_edit",
    description:
      "Commit an open edit: every change made in it goes live (or to review) atomically. The editId is consumed. If the edit contains production-track changes they were already checked against safe mode when they were added.",
    inputSchema: obj(
      {
        packageName: S.packageName,
        editId: { type: "string" },
        changesNotSentForReview: S.changesNotSentForReview,
        changesInReviewBehavior: {
          type: "string",
          enum: ["CANCEL_IN_REVIEW_AND_SUBMIT", "ERROR_IF_IN_REVIEW"],
          description: "What to do if changes are already in review (default CANCEL_IN_REVIEW_AND_SUBMIT)",
        },
      },
      ["packageName", "editId"],
    ),
    run: async (a) => {
      const res = await api().post(
        `${ep(a, a.editId)}:commit`,
        undefined,
        pick(a, ["changesNotSentForReview", "changesInReviewBehavior"]),
      );
      return { committed: true, edit: res };
    },
  },
  {
    name: "delete_edit",
    description: "Discard an open edit and every uncommitted change in it. Nothing is published.",
    inputSchema: obj({ packageName: S.packageName, editId: { type: "string" } }, ["packageName", "editId"]),
    run: async (a) => {
      await api().delete(ep(a, a.editId));
      return { deleted: true, editId: a.editId };
    },
  },

  // ---- Store listing / texts ----
  {
    name: "list_listings",
    description:
      "List the store listing (title, shortDescription, fullDescription, video) for every language of an app. Read-only.",
    inputSchema: obj({ packageName: S.packageName, editId: S.readEditId }, ["packageName"]),
    run: async (a) =>
      reading(a, async (editId) => ((await api().get(`${ep(a, editId)}/listings`)) || {}).listings || []),
  },
  {
    name: "list_languages",
    description:
      "List the languages an app's store listing is localized into, plus the default language. Read-only.",
    inputSchema: obj({ packageName: S.packageName, editId: S.readEditId }, ["packageName"]),
    run: async (a) =>
      reading(a, async (editId) => {
        const details = await api().get(`${ep(a, editId)}/details`);
        const listings = ((await api().get(`${ep(a, editId)}/listings`)) || {}).listings || [];
        return {
          defaultLanguage: details.defaultLanguage,
          languages: listings.map((l) => l.language),
        };
      }),
  },
  {
    name: "get_listing",
    description: "Read one language's store listing. Read-only.",
    inputSchema: obj(
      { packageName: S.packageName, language: S.language, editId: S.readEditId },
      ["packageName", "language"],
    ),
    run: async (a) =>
      reading(a, (editId) => api().get(`${ep(a, editId)}/listings/${enc(a.language)}`)),
  },
  {
    name: "update_listing",
    description:
      "Update the store listing TITLE, SHORT DESCRIPTION, FULL DESCRIPTION or promo video for one language (creates the language if it doesn't exist yet). Only include the fields you want to change. Opens an edit, applies, validates and commits in one call. Set dryRun:true to preview the diff (old→new + length checks) and have Google validate it without publishing anything.",
    inputSchema: obj(
      {
        packageName: S.packageName,
        language: S.language,
        title: { type: "string", description: `App title (max ${LIMITS.title} chars)` },
        shortDescription: { type: "string", description: `Short description (max ${LIMITS.shortDescription} chars)` },
        fullDescription: { type: "string", description: `Full description (max ${LIMITS.fullDescription} chars)` },
        video: { type: "string", description: "YouTube URL of the promo video" },
        ...EDIT_WRITE,
      },
      ["packageName", "language"],
    ),
    run: async (a) => {
      const attributes = pick(a, LISTING_FIELDS);
      if (!Object.keys(attributes).length)
        throw new Error(`Pass at least one of: ${LISTING_FIELDS.join(", ")}`);
      return session(a, (editId) => applyListing(a, editId, a.language, attributes));
    },
  },
  {
    name: "bulk_upsert_listings",
    description:
      "Create or update store listings for MANY languages in one atomic edit. Pass listings as { 'en-US': { title, shortDescription, fullDescription, video }, 'de-DE': {...} }. Existing languages are patched (only given fields change); new ones are created. All languages go live together or not at all. Set dryRun:true to preview every diff and validate without publishing.",
    inputSchema: obj(
      {
        packageName: S.packageName,
        listings: {
          type: "object",
          description: "Map of language → { title?, shortDescription?, fullDescription?, video? }",
          additionalProperties: {
            type: "object",
            properties: {
              title: { type: "string" },
              shortDescription: { type: "string" },
              fullDescription: { type: "string" },
              video: { type: "string" },
            },
          },
        },
        ...EDIT_WRITE,
      },
      ["packageName", "listings"],
    ),
    run: async (a) => {
      const entries = Object.entries(a.listings || {});
      if (!entries.length) throw new Error("listings is empty");
      return session(a, async (editId) => {
        const results = [];
        // Sequential on purpose: all writes go to the same edit.
        for (const [language, fields] of entries)
          results.push(await applyListing(a, editId, language, pick(fields || {}, LISTING_FIELDS)));
        return { languages: results.length, results };
      });
    },
  },
  {
    name: "delete_listing",
    description:
      "Delete one language's store listing (the default language cannot be deleted). Set dryRun:true to validate without publishing.",
    inputSchema: obj(
      { packageName: S.packageName, language: S.language, ...EDIT_WRITE },
      ["packageName", "language"],
    ),
    run: async (a) =>
      session(a, async (editId) => {
        await api().delete(`${ep(a, editId)}/listings/${enc(a.language)}`);
        return { deleted: a.language };
      }),
  },
  {
    name: "get_app_details",
    description:
      "Read app-level details: defaultLanguage and the public contact email / phone / website. Read-only.",
    inputSchema: obj({ packageName: S.packageName, editId: S.readEditId }, ["packageName"]),
    run: async (a) => reading(a, (editId) => api().get(`${ep(a, editId)}/details`)),
  },
  {
    name: "update_app_details",
    description:
      "Update app-level details: defaultLanguage, contactEmail, contactPhone, contactWebsite. Only include the fields you want to change. Set dryRun:true to preview the diff without publishing.",
    inputSchema: obj(
      {
        packageName: S.packageName,
        defaultLanguage: { type: "string", description: "BCP-47, e.g. en-US" },
        contactEmail: { type: "string" },
        contactPhone: { type: "string" },
        contactWebsite: { type: "string" },
        ...EDIT_WRITE,
      },
      ["packageName"],
    ),
    run: async (a) => {
      const attributes = pick(a, DETAILS_FIELDS);
      if (!Object.keys(attributes).length)
        throw new Error(`Pass at least one of: ${DETAILS_FIELDS.join(", ")}`);
      return session(a, async (editId) => {
        const path = `${ep(a, editId)}/details`;
        const current = await api().get(path);
        const details = await api().patch(path, attributes);
        return { changes: buildDiff(current || {}, attributes), details };
      });
    },
  },

  // ---- Images / screenshots ----
  {
    name: "list_images",
    description:
      "List the images of one type for one language (id, sha256, preview url). Omit imageType to list every type. Read-only.",
    inputSchema: obj(
      {
        packageName: S.packageName,
        language: S.language,
        imageType: S.imageType,
        editId: S.readEditId,
      },
      ["packageName", "language"],
    ),
    run: async (a) =>
      reading(a, async (editId) => {
        const base = `${ep(a, editId)}/listings/${enc(a.language)}`;
        if (a.imageType)
          return ((await api().get(`${base}/${assertImageType(a.imageType)}`)) || {}).images || [];
        const out = {};
        for (const type of IMAGE_TYPES)
          out[type] = ((await api().get(`${base}/${type}`)) || {}).images || [];
        return out;
      }),
  },
  {
    name: "upload_image",
    description:
      "Upload one PNG/JPEG image (icon, featureGraphic, tvBanner or a screenshot) for a language. Screenshots are appended; icon / featureGraphic / tvBanner hold a single image and are replaced. filePath is a local file. Set dryRun:true to validate without publishing.",
    inputSchema: obj(
      {
        packageName: S.packageName,
        language: S.language,
        imageType: S.imageType,
        filePath: { type: "string", description: "Absolute path to a local PNG or JPEG" },
        ...EDIT_WRITE,
      },
      ["packageName", "language", "imageType", "filePath"],
    ),
    run: async (a) => {
      assertImageType(a.imageType);
      assertFile(a.filePath);
      const contentType = imageContentType(a.filePath);
      return session(a, async (editId) => {
        const res = await api().upload(
          `${ep(a, editId)}/listings/${enc(a.language)}/${a.imageType}`,
          { filePath: a.filePath, contentType },
        );
        return { file: basename(a.filePath), image: res && res.image };
      });
    },
  },
  {
    name: "delete_image",
    description:
      "Delete one image by id (from list_images). Set dryRun:true to validate without publishing.",
    inputSchema: obj(
      {
        packageName: S.packageName,
        language: S.language,
        imageType: S.imageType,
        imageId: { type: "string" },
        ...EDIT_WRITE,
      },
      ["packageName", "language", "imageType", "imageId"],
    ),
    run: async (a) => {
      assertImageType(a.imageType);
      return session(a, async (editId) => {
        await api().delete(
          `${ep(a, editId)}/listings/${enc(a.language)}/${a.imageType}/${enc(a.imageId)}`,
        );
        return { deleted: a.imageId };
      });
    },
  },
  {
    name: "delete_all_images",
    description:
      "Delete ALL images of one type for one language. Set dryRun:true to validate without publishing.",
    inputSchema: obj(
      { packageName: S.packageName, language: S.language, imageType: S.imageType, ...EDIT_WRITE },
      ["packageName", "language", "imageType"],
    ),
    run: async (a) => {
      assertImageType(a.imageType);
      return session(a, async (editId) => {
        const res = await api().delete(
          `${ep(a, editId)}/listings/${enc(a.language)}/${a.imageType}`,
        );
        return { deleted: (res && res.deleted) || [] };
      });
    },
  },
  {
    name: "replace_images",
    description:
      "Replace the whole set of images of one type for one language: delete the existing ones and upload `files` in the given order — atomically, in one edit, so the listing never shows a half-replaced set. Set dryRun:true to upload into a temporary edit, validate and discard.",
    inputSchema: obj(
      {
        packageName: S.packageName,
        language: S.language,
        imageType: S.imageType,
        files: {
          type: "array",
          items: { type: "string" },
          description: "Absolute paths to local PNG/JPEG files, in display order",
        },
        ...EDIT_WRITE,
      },
      ["packageName", "language", "imageType", "files"],
    ),
    run: async (a) => {
      assertImageType(a.imageType);
      if (!Array.isArray(a.files) || !a.files.length) throw new Error("files is empty");
      // Check every file before touching anything.
      const types = a.files.map((f) => (assertFile(f), imageContentType(f)));
      return session(a, async (editId) => {
        const path = `${ep(a, editId)}/listings/${enc(a.language)}/${a.imageType}`;
        const removed = await api().delete(path);
        const uploaded = [];
        for (let i = 0; i < a.files.length; i++) {
          const res = await api().upload(path, { filePath: a.files[i], contentType: types[i] });
          uploaded.push({ file: basename(a.files[i]), image: res && res.image });
        }
        return { removed: ((removed && removed.deleted) || []).length, uploaded };
      });
    },
  },

  // ---- Builds ----
  {
    name: "upload_bundle",
    description:
      "Upload an Android App Bundle (.aab). Returns its versionCode — pass that to create_release to put it on a track. By default the upload is committed on its own (the bundle then sits in the app's library, unreleased); pass an editId to upload and release in the same edit. Set dryRun:true to have Google validate the bundle and discard it.",
    inputSchema: obj(
      {
        packageName: S.packageName,
        filePath: { type: "string", description: "Absolute path to the .aab" },
        ackBundleInstallationWarning: {
          type: "boolean",
          description: "Acknowledge the warning for bundles whose install size may be too large",
        },
        deviceTierConfigId: { type: "string", description: "Optional device tier config id (or 'LATEST')" },
        ...EDIT_WRITE,
      },
      ["packageName", "filePath"],
    ),
    run: async (a) => {
      const bytes = assertFile(a.filePath, [".aab"]);
      return session(a, async (editId) => {
        const bundle = await api().upload(`${ep(a, editId)}/bundles`, {
          filePath: a.filePath,
          query: pick(a, ["ackBundleInstallationWarning", "deviceTierConfigId"]),
        });
        return { file: basename(a.filePath), bytes, bundle };
      });
    },
  },
  {
    name: "upload_apk",
    description:
      "Upload an APK (.apk). Returns its versionCode for create_release. New apps must use bundles (upload_bundle); APK upload is for apps that still ship APKs. Set dryRun:true to validate and discard.",
    inputSchema: obj(
      {
        packageName: S.packageName,
        filePath: { type: "string", description: "Absolute path to the .apk" },
        ...EDIT_WRITE,
      },
      ["packageName", "filePath"],
    ),
    run: async (a) => {
      const bytes = assertFile(a.filePath, [".apk"]);
      return session(a, async (editId) => {
        const apk = await api().upload(`${ep(a, editId)}/apks`, {
          filePath: a.filePath,
          contentType: "application/vnd.android.package-archive",
        });
        return { file: basename(a.filePath), bytes, apk };
      });
    },
  },
  {
    name: "list_bundles",
    description: "List the app bundles uploaded for an app (versionCode, sha1, sha256). Read-only.",
    inputSchema: obj({ packageName: S.packageName, editId: S.readEditId }, ["packageName"]),
    run: async (a) =>
      reading(a, async (editId) => ((await api().get(`${ep(a, editId)}/bundles`)) || {}).bundles || []),
  },
  {
    name: "list_apks",
    description: "List the APKs uploaded for an app (versionCode, binary hashes). Read-only.",
    inputSchema: obj({ packageName: S.packageName, editId: S.readEditId }, ["packageName"]),
    run: async (a) =>
      reading(a, async (editId) => ((await api().get(`${ep(a, editId)}/apks`)) || {}).apks || []),
  },
  {
    name: "upload_deobfuscation_file",
    description:
      "Upload crash-symbolication files for a build: an R8/ProGuard mapping.txt (fileType 'proguard') or a native debug symbols .zip (fileType 'nativeCode'). versionCode is the build the file belongs to.",
    inputSchema: obj(
      {
        packageName: S.packageName,
        versionCode: { type: "integer" },
        fileType: { type: "string", enum: ["proguard", "nativeCode"] },
        filePath: { type: "string", description: "Absolute path to mapping.txt or the symbols .zip" },
        ...EDIT_WRITE,
      },
      ["packageName", "versionCode", "fileType", "filePath"],
    ),
    run: async (a) => {
      if (!["proguard", "nativeCode"].includes(a.fileType))
        throw new Error("fileType must be 'proguard' or 'nativeCode'");
      const bytes = assertFile(a.filePath);
      return session(a, async (editId) => {
        const res = await api().upload(
          `${ep(a, editId)}/apks/${enc(a.versionCode)}/deobfuscationFiles/${a.fileType}`,
          { filePath: a.filePath },
        );
        return { file: basename(a.filePath), bytes, ...(res || {}) };
      });
    },
  },
  {
    name: "upload_internal_app_sharing",
    description:
      "Upload an .aab or .apk to Internal App Sharing and get a download URL for authorized testers. No edit, no review, no track — the fastest way to hand someone a build.",
    inputSchema: obj(
      {
        packageName: S.packageName,
        filePath: { type: "string", description: "Absolute path to the .aab or .apk" },
      },
      ["packageName", "filePath"],
    ),
    run: async (a) => {
      const bytes = assertFile(a.filePath, [".aab", ".apk"]);
      const isApk = extname(a.filePath).toLowerCase() === ".apk";
      const artifact = await api().upload(
        `/applications/internalappsharing/${enc(assertPackageName(a.packageName))}/artifacts/${isApk ? "apk" : "bundle"}`,
        {
          filePath: a.filePath,
          contentType: isApk ? "application/vnd.android.package-archive" : "application/octet-stream",
        },
      );
      return { file: basename(a.filePath), bytes, artifact };
    },
  },

  // ---- Tracks / releases ----
  {
    name: "list_tracks",
    description:
      "List every track of an app (internal, alpha, beta, production, custom and form-factor tracks) with their releases: status, versionCodes, userFraction, release notes. Read-only.",
    inputSchema: obj({ packageName: S.packageName, editId: S.readEditId }, ["packageName"]),
    run: async (a) =>
      reading(a, async (editId) => ((await api().get(`${ep(a, editId)}/tracks`)) || {}).tracks || []),
  },
  {
    name: "get_track",
    description: "Read one track and its releases (status, versionCodes, userFraction, notes). Read-only.",
    inputSchema: obj(
      { packageName: S.packageName, track: S.track, editId: S.readEditId },
      ["packageName", "track"],
    ),
    run: async (a) => reading(a, (editId) => api().get(`${ep(a, editId)}/tracks/${enc(a.track)}`)),
  },
  {
    name: "create_release",
    description:
      "Put build(s) on a track as a release. status: 'draft' (saved, not rolled out), 'completed' (full rollout), 'inProgress' (staged rollout — requires userFraction, e.g. 0.1 = 10%), 'halted'. versionCodes come from upload_bundle / list_bundles. Production releases are gated by PLAY_MCP_ALLOW_PRODUCTION_RELEASE. Set dryRun:true to have Google validate the release without publishing.",
    inputSchema: obj(
      {
        packageName: S.packageName,
        track: S.track,
        versionCodes: {
          type: "array",
          items: { type: ["integer", "string"] },
          description: "Version codes in this release (include any you want to retain)",
        },
        status: { type: "string", enum: RELEASE_STATUSES },
        userFraction: {
          type: "number",
          description: "Staged rollout fraction, strictly between 0 and 1 (only with inProgress/halted)",
        },
        name: { type: "string", description: "Release name (defaults to the versionName)" },
        releaseNotes: S.releaseNotes,
        inAppUpdatePriority: { type: "integer", description: "0–5 (default 0)" },
        countryTargeting: {
          type: "object",
          description: "{ countries: ['US', ...], includeRestOfWorld } — production inProgress releases only",
          additionalProperties: true,
        },
        ...EDIT_WRITE,
      },
      ["packageName", "track", "versionCodes", "status"],
    ),
    run: async (a) => {
      const { release, warnings } = buildRelease(a);
      return session(a, async (editId) => {
        const track = await api().put(`${ep(a, editId)}/tracks/${enc(a.track)}`, {
          track: a.track,
          releases: [release],
        });
        return withWarnings({ release, track }, warnings);
      });
    },
  },
  {
    name: "update_track",
    description:
      "Low-level: replace a track's `releases` array with exactly what you pass (TrackRelease objects). Prefer create_release / promote_release / the rollout tools; use this for unusual shapes. Production tracks are gated by PLAY_MCP_ALLOW_PRODUCTION_RELEASE. Set dryRun:true to validate without publishing.",
    inputSchema: obj(
      {
        packageName: S.packageName,
        track: S.track,
        releases: {
          type: "array",
          description: "TrackRelease objects: { status, versionCodes, userFraction?, name?, releaseNotes?, ... }",
          items: { type: "object", additionalProperties: true },
        },
        ...EDIT_WRITE,
      },
      ["packageName", "track", "releases"],
    ),
    run: async (a) =>
      session(a, async (editId) => {
        const path = `${ep(a, editId)}/tracks/${enc(a.track)}`;
        const before = await getOrNull(path);
        const track = await api().put(path, { track: a.track, releases: a.releases });
        return { before, track };
      }),
  },
  {
    name: "promote_release",
    description:
      "Promote a build from one track to another (e.g. internal → beta, beta → production), carrying its versionCodes and release notes. By default promotes the newest release on fromTrack as a full rollout; pass status:'inProgress' + userFraction for a staged rollout, or 'draft' to stage it. Promoting to production is gated by PLAY_MCP_ALLOW_PRODUCTION_RELEASE. Set dryRun:true to validate without publishing.",
    inputSchema: obj(
      {
        packageName: S.packageName,
        fromTrack: S.track,
        toTrack: S.track,
        versionCode: {
          type: ["integer", "string"],
          description: "Promote the release containing this version code (default: the newest release)",
        },
        status: { type: "string", enum: RELEASE_STATUSES, description: "Default 'completed'" },
        userFraction: { type: "number", description: "For status inProgress: 0 < fraction < 1" },
        releaseNotes: { ...S.releaseNotes, description: "Override the notes (default: copy from the source release)" },
        ...EDIT_WRITE,
      },
      ["packageName", "fromTrack", "toTrack"],
    ),
    run: async (a) =>
      session(a, async (editId) => {
        const base = `${ep(a, editId)}/tracks`;
        const source = await api().get(`${base}/${enc(a.fromTrack)}`);
        const from = pickRelease(source, { versionCode: a.versionCode });
        if (!from)
          throw new Error(
            a.versionCode !== undefined
              ? `No release containing versionCode ${a.versionCode} on track '${a.fromTrack}'.`
              : `Track '${a.fromTrack}' has no releases to promote.`,
          );
        const { release, warnings } = buildRelease({
          versionCodes: from.versionCodes,
          status: a.status || (a.userFraction !== undefined ? "inProgress" : "completed"),
          userFraction: a.userFraction,
          name: from.name,
          releaseNotes: a.releaseNotes || from.releaseNotes,
        });
        const track = await api().put(`${base}/${enc(a.toTrack)}`, {
          track: a.toTrack,
          releases: [release],
        });
        return withWarnings({ from: { track: a.fromTrack, release: from }, to: track }, warnings);
      }),
  },
  {
    name: "set_rollout_fraction",
    description:
      "Change the percentage of a staged rollout (e.g. 0.05 → 0.2). Finds the staged release on the track (default production); userFraction is strictly between 0 and 1 — use complete_rollout for 100%. Gated on production by PLAY_MCP_ALLOW_PRODUCTION_RELEASE. Set dryRun:true to preview before/after.",
    inputSchema: obj(
      {
        packageName: S.packageName,
        track: { ...S.track, description: "Default 'production'" },
        userFraction: { type: "number", description: "New fraction, 0 < fraction < 1 (0.2 = 20%)" },
        versionCode: { type: ["integer", "string"], description: "Target the release containing this code (default: the staged one)" },
        ...EDIT_WRITE,
      },
      ["packageName", "userFraction"],
    ),
    run: rolloutTool("setFraction"),
  },
  {
    name: "halt_rollout",
    description:
      "Halt a staged rollout: stop serving the staged release to new users (existing installs keep it). The emergency brake — it is NOT blocked by PLAY_MCP_ALLOW_PRODUCTION_RELEASE=false (only by read-only mode). Track defaults to production.",
    inputSchema: obj(
      {
        packageName: S.packageName,
        track: { ...S.track, description: "Default 'production'" },
        versionCode: { type: ["integer", "string"], description: "Default: the inProgress release" },
        ...EDIT_WRITE,
      },
      ["packageName"],
    ),
    run: rolloutTool("halt"),
  },
  {
    name: "resume_rollout",
    description:
      "Resume a halted rollout at its previous fraction (or a new userFraction). Track defaults to production. Gated on production by PLAY_MCP_ALLOW_PRODUCTION_RELEASE.",
    inputSchema: obj(
      {
        packageName: S.packageName,
        track: { ...S.track, description: "Default 'production'" },
        userFraction: { type: "number", description: "Optional new fraction, 0 < fraction < 1" },
        versionCode: { type: ["integer", "string"], description: "Default: the halted release" },
        ...EDIT_WRITE,
      },
      ["packageName"],
    ),
    run: rolloutTool("resume"),
  },
  {
    name: "complete_rollout",
    description:
      "Finish a staged rollout: release to 100% of users (status 'completed'). Track defaults to production. Gated on production by PLAY_MCP_ALLOW_PRODUCTION_RELEASE. Set dryRun:true to preview.",
    inputSchema: obj(
      {
        packageName: S.packageName,
        track: { ...S.track, description: "Default 'production'" },
        versionCode: { type: ["integer", "string"], description: "Default: the staged release" },
        ...EDIT_WRITE,
      },
      ["packageName"],
    ),
    run: rolloutTool("complete"),
  },

  // ---- Testers / availability ----
  {
    name: "get_testers",
    description: "Read the tester Google Groups for a testing track (internal, alpha, beta or custom). Read-only.",
    inputSchema: obj(
      { packageName: S.packageName, track: S.track, editId: S.readEditId },
      ["packageName", "track"],
    ),
    run: async (a) => reading(a, (editId) => api().get(`${ep(a, editId)}/testers/${enc(a.track)}`)),
  },
  {
    name: "update_testers",
    description:
      "Set the tester Google Groups (group email addresses) for a testing track. This REPLACES the list. Individual tester emails are managed in Play Console, not through the API. Set dryRun:true to validate without publishing.",
    inputSchema: obj(
      {
        packageName: S.packageName,
        track: S.track,
        googleGroups: { type: "array", items: { type: "string" }, description: "Google Group email addresses" },
        ...EDIT_WRITE,
      },
      ["packageName", "track", "googleGroups"],
    ),
    run: async (a) =>
      session(a, async (editId) => {
        const path = `${ep(a, editId)}/testers/${enc(a.track)}`;
        const before = await getOrNull(path);
        const testers = await api().put(path, { googleGroups: a.googleGroups });
        return { before, testers };
      }),
  },
  {
    name: "get_country_availability",
    description:
      "Read which countries a track is available in (and whether it syncs with production). Read-only — availability itself is changed in Play Console.",
    inputSchema: obj(
      { packageName: S.packageName, track: S.track, editId: S.readEditId },
      ["packageName", "track"],
    ),
    run: async (a) =>
      reading(a, (editId) => api().get(`${ep(a, editId)}/countryAvailability/${enc(a.track)}`)),
  },

  // ---- In-app products (legacy one-time products) ----
  {
    name: "list_inapp_products",
    description:
      "List managed (one-time) in-app products via the legacy inappproducts API: sku, status, listings, defaultPrice, per-region prices. Read-only. Subscriptions are under list_subscriptions.",
    inputSchema: obj({ packageName: S.packageName }, ["packageName"]),
    run: async (a) =>
      api().getAll(`${app(a)}/inappproducts`, {}, { itemsKey: "inappproduct", tokenParam: "token" }),
  },
  {
    name: "get_inapp_product",
    description: "Read one in-app product by sku. Read-only.",
    inputSchema: obj({ packageName: S.packageName, sku: { type: "string" } }, ["packageName", "sku"]),
    run: async (a) => api().get(`${app(a)}/inappproducts/${enc(a.sku)}`),
  },
  {
    name: "create_inapp_product",
    description:
      "Create a managed (one-time) in-app product. `product` is an InAppProduct: { sku, status: 'active'|'inactive', purchaseType: 'managedUser', defaultLanguage, listings: { 'en-US': { title, description } }, defaultPrice: { priceMicros: '990000', currency: 'USD' } }. autoConvertMissingPrices fills other regions from defaultPrice. Takes effect immediately (no edit).",
    inputSchema: obj(
      {
        packageName: S.packageName,
        product: { type: "object", description: "InAppProduct resource", additionalProperties: true },
        autoConvertMissingPrices: { type: "boolean", description: "Default true" },
      },
      ["packageName", "product"],
    ),
    run: async (a) =>
      api().post(
        `${app(a)}/inappproducts`,
        { purchaseType: "managedUser", ...a.product, packageName: a.packageName },
        { autoConvertMissingPrices: a.autoConvertMissingPrices ?? true },
      ),
  },
  {
    name: "update_inapp_product",
    description:
      "Patch an in-app product: only the fields in `product` change (status, listings, defaultPrice, prices, ...). Changing defaultPrice/prices is a PRICE CHANGE and is gated by PLAY_MCP_ALLOW_PRICE_CHANGES. Set dryRun:true to see the before/after diff without writing. Takes effect immediately (no edit).",
    inputSchema: obj(
      {
        packageName: S.packageName,
        sku: { type: "string" },
        product: { type: "object", description: "Partial InAppProduct", additionalProperties: true },
        autoConvertMissingPrices: { type: "boolean", description: "Re-derive regional prices from defaultPrice (default false)" },
        latencyTolerance: S.latencyTolerance,
        dryRun: { type: "boolean", description: "Preview the diff without writing (default false)" },
      },
      ["packageName", "sku", "product"],
    ),
    run: async (a) => {
      const path = `${app(a)}/inappproducts/${enc(a.sku)}`;
      if (a.dryRun) {
        const current = await api().get(path);
        return {
          dryRun: true,
          sku: a.sku,
          changes: buildDiff(current || {}, a.product || {}),
          note: "No changes were written. Re-run without dryRun to apply.",
        };
      }
      return api().patch(
        path,
        { ...a.product, sku: a.sku, packageName: a.packageName },
        pick(a, ["autoConvertMissingPrices", "latencyTolerance"]),
      );
    },
  },
  {
    name: "delete_inapp_product",
    description: "Delete an in-app product by sku. Irreversible; takes effect immediately.",
    inputSchema: obj({ packageName: S.packageName, sku: { type: "string" } }, ["packageName", "sku"]),
    run: async (a) => {
      await api().delete(`${app(a)}/inappproducts/${enc(a.sku)}`);
      return { deleted: a.sku };
    },
  },
  {
    name: "list_one_time_products",
    description:
      "List one-time products via the NEW monetization.onetimeproducts API (purchase options, offers, regional pricing). Read-only; write them with raw_request until dedicated tools exist.",
    inputSchema: obj({ packageName: S.packageName }, ["packageName"]),
    run: async (a) =>
      api().getAll(`${app(a)}/oneTimeProducts`, { pageSize: 100 }, { itemsKey: "oneTimeProducts" }),
  },

  // ---- Subscriptions (monetization.subscriptions) ----
  {
    name: "list_subscriptions",
    description:
      "List subscriptions with their base plans (billing period, state, regional prices) and listings. Read-only.",
    inputSchema: obj({ packageName: S.packageName }, ["packageName"]),
    run: async (a) =>
      api().getAll(`${app(a)}/subscriptions`, { pageSize: 100 }, { itemsKey: "subscriptions" }),
  },
  {
    name: "get_subscription",
    description: "Read one subscription (base plans, prices, listings, tax settings). Read-only.",
    inputSchema: obj({ packageName: S.packageName, productId: S.productId }, ["packageName", "productId"]),
    run: async (a) => api().get(`${app(a)}/subscriptions/${enc(a.productId)}`),
  },
  {
    name: "create_subscription",
    description:
      "Create a subscription. `subscription` is a Subscription resource: { listings: [{ languageCode, title, benefits?, description? }], basePlans: [{ basePlanId, autoRenewingBasePlanType: { billingPeriodDuration: 'P1M' }, regionalConfigs: [{ regionCode: 'US', price: { currencyCode: 'USD', units: '4', nanos: 990000000 } }] }] }. New base plans start as DRAFT — activate them with activate_base_plan. Takes effect immediately (no edit).",
    inputSchema: obj(
      {
        packageName: S.packageName,
        productId: S.productId,
        subscription: { type: "object", description: "Subscription resource", additionalProperties: true },
        regionsVersion: S.regionsVersion,
      },
      ["packageName", "productId", "subscription"],
    ),
    run: async (a) =>
      api().post(
        `${app(a)}/subscriptions`,
        { ...a.subscription, packageName: a.packageName, productId: a.productId },
        { productId: a.productId, "regionsVersion.version": regionsVersion(a) },
      ),
  },
  {
    name: "update_subscription",
    description:
      "Patch a subscription. `updateMask` lists the fields to replace (e.g. 'listings' or 'basePlans'); `subscription` carries their new values. Updating basePlans changes PRICES for NEW subscribers and is gated by PLAY_MCP_ALLOW_PRICE_CHANGES (existing subscribers move only via migrate_base_plan_prices). Set dryRun:true to see current vs proposed without writing.",
    inputSchema: obj(
      {
        packageName: S.packageName,
        productId: S.productId,
        subscription: { type: "object", description: "Partial Subscription resource", additionalProperties: true },
        updateMask: { type: "string", description: "Comma-separated field mask, e.g. 'listings' or 'basePlans'" },
        regionsVersion: S.regionsVersion,
        latencyTolerance: S.latencyTolerance,
        dryRun: { type: "boolean", description: "Preview the diff without writing (default false)" },
      },
      ["packageName", "productId", "subscription", "updateMask"],
    ),
    run: async (a) => {
      const path = `${app(a)}/subscriptions/${enc(a.productId)}`;
      if (a.dryRun) {
        const current = await api().get(path);
        const fields = pick(a.subscription || {}, a.updateMask.split(",").map((s) => s.trim()));
        return {
          dryRun: true,
          productId: a.productId,
          changes: buildDiff(current || {}, fields),
          note: "No changes were written. Re-run without dryRun to apply.",
        };
      }
      return api().patch(
        path,
        { ...a.subscription, packageName: a.packageName, productId: a.productId },
        {
          updateMask: a.updateMask,
          "regionsVersion.version": regionsVersion(a),
          latencyTolerance: a.latencyTolerance,
        },
      );
    },
  },
  {
    name: "delete_subscription",
    description:
      "Delete a subscription. Only possible if it never had a base plan published. Irreversible.",
    inputSchema: obj({ packageName: S.packageName, productId: S.productId }, ["packageName", "productId"]),
    run: async (a) => {
      await api().delete(`${app(a)}/subscriptions/${enc(a.productId)}`);
      return { deleted: a.productId };
    },
  },
  {
    name: "activate_base_plan",
    description:
      "Activate a base plan: it becomes purchasable by users. Gated by PLAY_MCP_ALLOW_SUBSCRIPTION_ACTIVATION.",
    inputSchema: obj(
      { packageName: S.packageName, productId: S.productId, basePlanId: S.basePlanId, latencyTolerance: S.latencyTolerance },
      ["packageName", "productId", "basePlanId"],
    ),
    run: async (a) =>
      api().post(
        `${app(a)}/subscriptions/${enc(a.productId)}/basePlans/${enc(a.basePlanId)}:activate`,
        pick(a, ["packageName", "productId", "basePlanId", "latencyTolerance"]),
      ),
  },
  {
    name: "deactivate_base_plan",
    description:
      "Deactivate a base plan: no NEW purchases (existing subscribers keep renewing). Gated by PLAY_MCP_ALLOW_SUBSCRIPTION_ACTIVATION.",
    inputSchema: obj(
      { packageName: S.packageName, productId: S.productId, basePlanId: S.basePlanId, latencyTolerance: S.latencyTolerance },
      ["packageName", "productId", "basePlanId"],
    ),
    run: async (a) =>
      api().post(
        `${app(a)}/subscriptions/${enc(a.productId)}/basePlans/${enc(a.basePlanId)}:deactivate`,
        pick(a, ["packageName", "productId", "basePlanId", "latencyTolerance"]),
      ),
  },
  {
    name: "delete_base_plan",
    description: "Delete a base plan. Only draft base plans (never activated) can be deleted. Irreversible.",
    inputSchema: obj(
      { packageName: S.packageName, productId: S.productId, basePlanId: S.basePlanId },
      ["packageName", "productId", "basePlanId"],
    ),
    run: async (a) => {
      await api().delete(`${app(a)}/subscriptions/${enc(a.productId)}/basePlans/${enc(a.basePlanId)}`);
      return { deleted: a.basePlanId };
    },
  },
  {
    name: "migrate_base_plan_prices",
    description:
      "Move EXISTING subscribers on legacy price cohorts to the base plan's current price in the given regions. This is a price change for paying users (Google notifies them; increases may need opt-in). Gated by PLAY_MCP_ALLOW_PRICE_CHANGES. regionalPriceMigrations: [{ regionCode: 'US', oldestAllowedPriceVersionTime: '2024-01-01T00:00:00Z', priceIncreaseType?: 'PRICE_INCREASE_TYPE_OPT_IN'|'PRICE_INCREASE_TYPE_OPT_OUT' }].",
    inputSchema: obj(
      {
        packageName: S.packageName,
        productId: S.productId,
        basePlanId: S.basePlanId,
        regionalPriceMigrations: {
          type: "array",
          items: { type: "object", additionalProperties: true },
        },
        regionsVersion: S.regionsVersion,
        latencyTolerance: S.latencyTolerance,
      },
      ["packageName", "productId", "basePlanId", "regionalPriceMigrations"],
    ),
    run: async (a) =>
      api().post(
        `${app(a)}/subscriptions/${enc(a.productId)}/basePlans/${enc(a.basePlanId)}:migratePrices`,
        {
          ...pick(a, ["packageName", "productId", "basePlanId", "regionalPriceMigrations", "latencyTolerance"]),
          regionsVersion: { version: regionsVersion(a) },
        },
      ),
  },
  {
    name: "list_subscription_offers",
    description:
      "List the offers (free trials, intro prices, upgrades) under a base plan. Pass basePlanId '-' to list offers across all base plans of the subscription. Read-only.",
    inputSchema: obj(
      { packageName: S.packageName, productId: S.productId, basePlanId: { type: "string", description: "Base plan id, or '-' for all" } },
      ["packageName", "productId"],
    ),
    run: async (a) =>
      api().getAll(
        `${app(a)}/subscriptions/${enc(a.productId)}/basePlans/${enc(a.basePlanId || "-")}/offers`,
        { pageSize: 100 },
        { itemsKey: "subscriptionOffers" },
      ),
  },
  {
    name: "get_subscription_offer",
    description: "Read one subscription offer (phases, regional prices, eligibility, state). Read-only.",
    inputSchema: obj(
      { packageName: S.packageName, productId: S.productId, basePlanId: S.basePlanId, offerId: S.offerId },
      ["packageName", "productId", "basePlanId", "offerId"],
    ),
    run: async (a) =>
      api().get(
        `${app(a)}/subscriptions/${enc(a.productId)}/basePlans/${enc(a.basePlanId)}/offers/${enc(a.offerId)}`,
      ),
  },
  {
    name: "create_subscription_offer",
    description:
      "Create an offer on a base plan. `offer` is a SubscriptionOffer: { phases: [{ recurrenceCount, duration: 'P1W', regionalConfigs: [{ regionCode, free: {} | price | relativeDiscount | absoluteDiscount }] }], regionalConfigs: [{ regionCode, newSubscriberAvailability: true }], targeting?, offerTags? }. New offers start as DRAFT — activate with activate_subscription_offer.",
    inputSchema: obj(
      {
        packageName: S.packageName,
        productId: S.productId,
        basePlanId: S.basePlanId,
        offerId: S.offerId,
        offer: { type: "object", description: "SubscriptionOffer resource", additionalProperties: true },
        regionsVersion: S.regionsVersion,
      },
      ["packageName", "productId", "basePlanId", "offerId", "offer"],
    ),
    run: async (a) =>
      api().post(
        `${app(a)}/subscriptions/${enc(a.productId)}/basePlans/${enc(a.basePlanId)}/offers`,
        { ...a.offer, ...pick(a, ["packageName", "productId", "basePlanId", "offerId"]) },
        { offerId: a.offerId, "regionsVersion.version": regionsVersion(a) },
      ),
  },
  {
    name: "update_subscription_offer",
    description:
      "Patch a subscription offer. `updateMask` lists the fields to replace (e.g. 'phases', 'regionalConfigs', 'offerTags'); `offer` carries the new values.",
    inputSchema: obj(
      {
        packageName: S.packageName,
        productId: S.productId,
        basePlanId: S.basePlanId,
        offerId: S.offerId,
        offer: { type: "object", description: "Partial SubscriptionOffer", additionalProperties: true },
        updateMask: { type: "string" },
        regionsVersion: S.regionsVersion,
        latencyTolerance: S.latencyTolerance,
      },
      ["packageName", "productId", "basePlanId", "offerId", "offer", "updateMask"],
    ),
    run: async (a) =>
      api().patch(
        `${app(a)}/subscriptions/${enc(a.productId)}/basePlans/${enc(a.basePlanId)}/offers/${enc(a.offerId)}`,
        { ...a.offer, ...pick(a, ["packageName", "productId", "basePlanId", "offerId"]) },
        {
          updateMask: a.updateMask,
          "regionsVersion.version": regionsVersion(a),
          latencyTolerance: a.latencyTolerance,
        },
      ),
  },
  {
    name: "delete_subscription_offer",
    description: "Delete a subscription offer. Only draft offers (never activated) can be deleted. Irreversible.",
    inputSchema: obj(
      { packageName: S.packageName, productId: S.productId, basePlanId: S.basePlanId, offerId: S.offerId },
      ["packageName", "productId", "basePlanId", "offerId"],
    ),
    run: async (a) => {
      await api().delete(
        `${app(a)}/subscriptions/${enc(a.productId)}/basePlans/${enc(a.basePlanId)}/offers/${enc(a.offerId)}`,
      );
      return { deleted: a.offerId };
    },
  },
  {
    name: "activate_subscription_offer",
    description:
      "Activate a subscription offer: eligible users can now get it. Gated by PLAY_MCP_ALLOW_SUBSCRIPTION_ACTIVATION.",
    inputSchema: obj(
      { packageName: S.packageName, productId: S.productId, basePlanId: S.basePlanId, offerId: S.offerId, latencyTolerance: S.latencyTolerance },
      ["packageName", "productId", "basePlanId", "offerId"],
    ),
    run: async (a) =>
      api().post(
        `${app(a)}/subscriptions/${enc(a.productId)}/basePlans/${enc(a.basePlanId)}/offers/${enc(a.offerId)}:activate`,
        pick(a, ["packageName", "productId", "basePlanId", "offerId", "latencyTolerance"]),
      ),
  },
  {
    name: "deactivate_subscription_offer",
    description:
      "Deactivate a subscription offer: no longer offered to new users. Gated by PLAY_MCP_ALLOW_SUBSCRIPTION_ACTIVATION.",
    inputSchema: obj(
      { packageName: S.packageName, productId: S.productId, basePlanId: S.basePlanId, offerId: S.offerId, latencyTolerance: S.latencyTolerance },
      ["packageName", "productId", "basePlanId", "offerId"],
    ),
    run: async (a) =>
      api().post(
        `${app(a)}/subscriptions/${enc(a.productId)}/basePlans/${enc(a.basePlanId)}/offers/${enc(a.offerId)}:deactivate`,
        pick(a, ["packageName", "productId", "basePlanId", "offerId", "latencyTolerance"]),
      ),
  },
  {
    name: "convert_region_prices",
    description:
      "Convert one price into Google's suggested local prices for every region (tax-exclusive input). A calculator only — it changes nothing. Use the output to fill regionalConfigs / prices. price: { currencyCode: 'USD', units: '4', nanos: 990000000 } = $4.99.",
    inputSchema: obj(
      {
        packageName: S.packageName,
        price: {
          type: "object",
          description: "Money: { currencyCode, units (string), nanos (integer) }",
          properties: {
            currencyCode: { type: "string" },
            units: { type: "string" },
            nanos: { type: "integer" },
          },
          required: ["currencyCode"],
        },
        productTaxCategoryCode: { type: "string" },
      },
      ["packageName", "price"],
    ),
    run: async (a) =>
      api().post(`${app(a)}/pricing:convertRegionPrices`, pick(a, ["price", "productTaxCategoryCode"])),
  },

  // ---- Reviews ----
  {
    name: "list_reviews",
    description:
      "List recent user reviews (rating, text, device, app version, any developer reply). NOTE: the API only returns reviews created or modified in roughly the last week, and only reviews that have a text comment. translationLanguage (e.g. 'en') returns translated text. Read-only.",
    inputSchema: obj(
      {
        packageName: S.packageName,
        maxResults: { type: "integer", description: "Page size (default 50)" },
        translationLanguage: { type: "string", description: "BCP-47 language to translate review text into" },
        token: { type: "string", description: "Page token from a previous call" },
        allPages: { type: "boolean", description: "Follow page tokens and return everything (default false)" },
      },
      ["packageName"],
    ),
    run: async (a) => {
      const query = {
        maxResults: a.maxResults || 50,
        translationLanguage: a.translationLanguage,
        token: a.token,
      };
      if (a.allPages)
        return api().getAll(`${app(a)}/reviews`, query, { itemsKey: "reviews", tokenParam: "token" });
      const page = (await api().get(`${app(a)}/reviews`, query)) || {};
      return {
        reviews: page.reviews || [],
        nextPageToken: page.tokenPagination?.nextPageToken || null,
      };
    },
  },
  {
    name: "get_review",
    description: "Read one review by id, including the developer reply if any. Read-only.",
    inputSchema: obj(
      { packageName: S.packageName, reviewId: { type: "string" }, translationLanguage: { type: "string" } },
      ["packageName", "reviewId"],
    ),
    run: async (a) =>
      api().get(`${app(a)}/reviews/${enc(a.reviewId)}`, { translationLanguage: a.translationLanguage }),
  },
  {
    name: "reply_to_review",
    description:
      "Post (or replace) the PUBLIC developer reply to a review. Visible to everyone on Google Play. Max ~350 characters; HTML is stripped. Gated by PLAY_MCP_ALLOW_REVIEW_REPLIES. Set dryRun:true to see the review, any existing reply and length check without posting.",
    inputSchema: obj(
      {
        packageName: S.packageName,
        reviewId: { type: "string" },
        replyText: { type: "string", description: "Reply text (max ~350 chars)" },
        dryRun: { type: "boolean", description: "Preview without posting (default false)" },
      },
      ["packageName", "reviewId", "replyText"],
    ),
    run: async (a) => {
      const warnings = validateReplyText(a.replyText);
      const path = `${app(a)}/reviews/${enc(a.reviewId)}`;
      if (a.dryRun) {
        const review = await getOrNull(path);
        const dev = (review?.comments || []).find((c) => c.developerComment)?.developerComment;
        return withWarnings(
          {
            dryRun: true,
            reviewId: a.reviewId,
            existingReply: dev?.text || null,
            newReply: a.replyText,
            length: a.replyText.length,
            note: "Nothing was posted. Re-run without dryRun to publish the reply.",
          },
          warnings,
        );
      }
      const res = await api().post(`${path}:reply`, { replyText: a.replyText });
      return withWarnings(res || { replied: true }, warnings);
    },
  },

  // ---- Snapshots (save / restore listing text) ----
  {
    name: "snapshot_listing",
    description:
      "Save a timestamped JSON snapshot of an app's editable TEXT metadata — app details plus title / short & full description / video for every language — so bulk edits can be reverted with restore_listing. includeImages:true also records each image's id, hashes and preview URL (a record only; image files are not downloaded). Returns the snapshot file path. Read-only on Google Play.",
    inputSchema: obj(
      {
        packageName: S.packageName,
        label: { type: "string", description: "Optional label added to the filename" },
        includeImages: { type: "boolean", description: "Also record image ids/hashes/urls per language and type (slower)" },
      },
      ["packageName"],
    ),
    run: async (a) => {
      const snap = await collectListing(a, { includeImages: a.includeImages });
      const file = writeSnapshot(snap, a.label);
      return {
        file,
        languages: snap.listings.map((l) => l.language),
        defaultLanguage: snap.details?.defaultLanguage,
      };
    },
  },
  {
    name: "restore_listing",
    description:
      "Restore listing text (and optionally app details) from a snapshot_listing file, in one atomic edit. Languages added since the snapshot are left alone. Images are not restored. Set dryRun:true to see what would change and validate without publishing.",
    inputSchema: obj(
      {
        file: { type: "string", description: "Path returned by snapshot_listing" },
        packageName: { ...S.packageName, description: "Defaults to the snapshot's packageName; pass to double-check the target" },
        languages: { type: "array", items: { type: "string" }, description: "Restore only these languages (default: all in the snapshot)" },
        includeDetails: { type: "boolean", description: "Also restore contact email/phone/website + defaultLanguage (default false)" },
        ...EDIT_WRITE,
      },
      ["file"],
    ),
    run: async (a) => {
      if (!existsSync(a.file)) throw new Error(`Snapshot not found: ${a.file}`);
      const snap = JSON.parse(readFileSync(a.file, "utf8"));
      if (a.packageName && a.packageName !== snap.packageName)
        throw new Error(
          `Snapshot is for ${snap.packageName}, not ${a.packageName} — refusing to restore onto a different app.`,
        );
      const target = { ...a, packageName: snap.packageName };
      const wanted = (snap.listings || []).filter(
        (l) => !a.languages || a.languages.includes(l.language),
      );
      if (!wanted.length) throw new Error("No matching languages in the snapshot.");
      return session(target, async (editId) => {
        const results = [];
        for (const l of wanted)
          results.push(await applyListing(target, editId, l.language, pick(l, LISTING_FIELDS)));
        let details;
        if (a.includeDetails && snap.details) {
          const path = `${ep(target, editId)}/details`;
          const current = await api().get(path);
          const attributes = pick(snap.details, DETAILS_FIELDS);
          await api().patch(path, attributes);
          details = buildDiff(current || {}, attributes);
        }
        return {
          packageName: snap.packageName,
          snapshotTakenAt: snap.takenAt,
          restored: results.map((r) => ({
            language: r.language,
            changedFields: r.changes.filter((c) => c.changed).map((c) => c.field),
          })),
          ...(details ? { details } : {}),
        };
      });
    },
  },

  // ---- Reporting (OPTIONAL — separate Play Developer Reporting API) ----
  {
    name: "list_apps",
    description:
      "List the apps this service account can see (packageName + display name). Uses the OPTIONAL Play Developer Reporting API — the Publisher API has no 'list apps' call — so it needs that API enabled in the Cloud project and 'View app information' access. Read-only.",
    inputSchema: obj({ pageSize: { type: "integer", description: "Default 100" } }),
    run: async (a) =>
      api().getAll("/v1beta1/apps:search", { pageSize: a.pageSize || 100 }, { itemsKey: "apps" }),
  },
  {
    name: "reporting_query_metric_set",
    description:
      "Query an Android vitals metric set from the OPTIONAL Play Developer Reporting API (crash rate, ANR rate, error counts, slow start/rendering, wakeups, wakelocks, LMK). `query` is the request body: { timelineSpec: { aggregationPeriod: 'DAILY', startTime: { year, month, day, timeZone: { id: 'America/Los_Angeles' } }, endTime: {...} }, metrics: ['crashRate', 'distinctUsers'], dimensions: ['versionCode'], filter?, pageSize? }. Use reporting_get_metric_set first to see the freshness window. Read-only.",
    inputSchema: obj(
      {
        packageName: S.packageName,
        metricSet: { type: "string", enum: METRIC_SETS },
        query: { type: "object", description: "Query body (timelineSpec, metrics, dimensions, filter, pageSize, pageToken)", additionalProperties: true },
      },
      ["packageName", "metricSet", "query"],
    ),
    run: async (a) => {
      if (!METRIC_SETS.includes(a.metricSet))
        throw new Error(`metricSet must be one of: ${METRIC_SETS.join(", ")}`);
      return api().post(`${reportingApp(a)}/${a.metricSet}:query`, a.query || {});
    },
  },
  {
    name: "reporting_get_metric_set",
    description:
      "Describe a vitals metric set: its data freshness (latest available end time per aggregation period). Call before reporting_query_metric_set to pick a valid time range. OPTIONAL Reporting API. Read-only.",
    inputSchema: obj(
      { packageName: S.packageName, metricSet: { type: "string", enum: METRIC_SETS } },
      ["packageName", "metricSet"],
    ),
    run: async (a) => {
      if (!METRIC_SETS.includes(a.metricSet))
        throw new Error(`metricSet must be one of: ${METRIC_SETS.join(", ")}`);
      return api().get(`${reportingApp(a)}/${a.metricSet}`);
    },
  },
  {
    name: "reporting_list_anomalies",
    description:
      "List anomalies Google detected in an app's vitals (sudden crash/ANR-rate changes). OPTIONAL Reporting API. Read-only.",
    inputSchema: obj(
      { packageName: S.packageName, filter: { type: "string", description: "e.g. activeBetween(\"2026-01-01T00:00:00Z\", UNBOUNDED)" } },
      ["packageName"],
    ),
    run: async (a) =>
      api().getAll(`${reportingApp(a)}/anomalies`, { filter: a.filter, pageSize: 100 }, { itemsKey: "anomalies" }),
  },
  {
    name: "reporting_search_error_issues",
    description:
      "Search grouped crash / ANR issues for an app (cause, location, affected users, first/last version). filter e.g. 'errorIssueType = CRASH'; orderBy e.g. 'errorReportCount desc'. OPTIONAL Reporting API. Read-only.",
    inputSchema: obj(
      {
        packageName: S.packageName,
        filter: { type: "string" },
        orderBy: { type: "string" },
        pageSize: { type: "integer", description: "Default 50" },
      },
      ["packageName"],
    ),
    run: async (a) =>
      api().get(`${reportingApp(a)}/errorIssues:search`, {
        filter: a.filter,
        orderBy: a.orderBy,
        pageSize: a.pageSize || 50,
      }),
  },
  {
    name: "reporting_request",
    description:
      "Raw call to the OPTIONAL Play Developer Reporting API (playdeveloperreporting.googleapis.com, v1beta1) for anything not covered above, e.g. '/apps/{packageName}/errorReports:search'. path is relative to /v1beta1. The Reporting API is read-only, so this is allowed in read-only mode.",
    inputSchema: obj(
      {
        method: { type: "string", enum: ["GET", "POST"] },
        path: { type: "string" },
        query: { type: "object", description: "Query params as a flat object", additionalProperties: true },
        body: { type: "object", description: "JSON request body (for POST ...:query)", additionalProperties: true },
      },
      ["method", "path"],
    ),
    run: async (a) => {
      if (!["GET", "POST"].includes(a.method)) throw new Error("method must be GET or POST");
      if (/^https?:/i.test(a.path)) throw new Error("path must be relative, e.g. '/apps/com.example.app/anomalies'");
      const clean = a.path.startsWith("/") ? a.path : `/${a.path}`;
      const path = clean.startsWith("/v1beta1/") ? clean : `/v1beta1${clean}`;
      return api().request(a.method, path, { query: a.query, body: a.body });
    },
  },

  // ---- Diagnostics ----
  {
    name: "doctor",
    description:
      "Diagnose the setup: Node version, credentials present and parseable, whether Google issues an access token, whether the service account can actually reach a given app (pass packageName), whether the optional Reporting API is reachable, and the current safe-mode write settings. Changes nothing (the access probe opens and deletes an empty edit). Run this first if something isn't working.",
    inputSchema: obj({
      packageName: { ...S.packageName, description: "Optional: an app to test access against, e.g. com.example.app" },
    }),
    run: async (a) => {
      const checks = [];
      const add = (name, status, detail) => checks.push({ name, status, detail });
      // Node
      const major = parseInt(process.versions.node.split(".")[0], 10);
      add("Node.js", major >= 18 ? "pass" : "fail", `${process.version} (need ≥ 18)`);
      // Credentials present + parseable (never print key material)
      const source = GooglePlayClient.credentialSource();
      add("Service account key", source ? "pass" : "fail", source || "missing — set GOOGLE_SERVICE_ACCOUNT_JSON (path or inline JSON) or GOOGLE_SERVICE_ACCOUNT_JSON_BASE64");
      let client = null;
      if (source) {
        try {
          client = api();
          add("Key parses", "pass", `client_email: ${client.clientEmail}${client.projectId ? `, project: ${client.projectId}` : ""}`);
        } catch (e) {
          add("Key parses", "fail", e.message.slice(0, 200));
        }
      }
      // Token
      let tokenOk = false;
      if (client) {
        try {
          await client._getToken();
          tokenOk = true;
          add("Access token (androidpublisher scope)", "pass", "Google issued a token");
        } catch (e) {
          add("Access token (androidpublisher scope)", "fail", e.message.slice(0, 200));
        }
      }
      // Access to a package
      if (tokenOk && a.packageName) {
        try {
          const details = await reading(a, (editId) => client.get(`${ep(a, editId)}/details`));
          add(`Access to ${a.packageName}`, "pass", `can open edits (default language: ${details?.defaultLanguage || "?"})`);
        } catch (e) {
          add(`Access to ${a.packageName}`, "fail", e.message.slice(0, 300));
        }
        try {
          await client.get(`${app(a)}/reviews`, { maxResults: 1 });
          add("Reviews access", "pass", "can read reviews");
        } catch (e) {
          add("Reviews access", e.status === 403 ? "warn" : "info", e.status === 403 ? "no permission to read/reply to reviews" : `probe inconclusive (${e.status || "?"})`);
        }
      } else if (tokenOk) {
        add("Access to an app", "info", "pass packageName to verify the service account was granted access in Play Console → Users and permissions");
      }
      // Optional Reporting API
      if (tokenOk) {
        try {
          const res = await client.get("/v1beta1/apps:search", { pageSize: 5 });
          const names = ((res && res.apps) || []).map((x) => x.packageName).filter(Boolean);
          add("Reporting API (optional)", "pass", names.length ? `visible apps: ${names.join(", ")}` : "reachable (no apps visible)");
        } catch (e) {
          add("Reporting API (optional)", "info", `not available (${e.status || "?"}) — enable 'Google Play Developer Reporting API' in the Cloud project to use list_apps / reporting_* tools`);
        }
      }
      // Write mode
      const mode = writeModeSummary();
      add("Write mode", mode.readOnly ? "info" : "pass", mode.readOnly ? "READ-ONLY (writes blocked)" : "writes allowed");
      return {
        summary: {
          pass: checks.filter((c) => c.status === "pass").length,
          warn: checks.filter((c) => c.status === "warn").length,
          fail: checks.filter((c) => c.status === "fail").length,
        },
        safeMode: mode,
        checks,
      };
    },
  },
  {
    name: "raw_request",
    description:
      "Make a raw Google Play Android Publisher API call — use this for ANY endpoint not covered by a dedicated tool (orders, purchases, voided purchases, one-time product writes, device tier configs, app recovery, users/grants, data safety, etc.). path is relative (e.g. '/applications/{packageName}/reviews') and '/androidpublisher/v3' is added automatically. Edit-scoped paths need an editId from insert_edit — remember to commit_edit or delete_edit. Non-GET calls obey safe mode. See developers.google.com/android-publisher/api-ref/rest.",
    inputSchema: obj(
      {
        method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"] },
        path: { type: "string" },
        query: { type: "object", description: "Query params as a flat object", additionalProperties: true },
        body: { type: "object", description: "JSON request body (for POST/PUT/PATCH)", additionalProperties: true },
      },
      ["method", "path"],
    ),
    run: async (a) => api().request(a.method, a.path, { query: a.query, body: a.body }),
  },
];

const toolMap = Object.fromEntries(tools.map((t) => [t.name, t]));

// ---- Server wiring ----------------------------------------------------------

const SERVER_INSTRUCTIONS = `This server manages Google Play through the Android Publisher API: store listings (title, descriptions, images/screenshots, localization), builds (AAB/APK), tracks, releases and staged rollouts, testers, in-app products, subscriptions (base plans, offers, pricing), and user reviews. Apps are addressed by packageName (e.g. com.example.app). Use the dedicated tools where they exist; fall back to raw_request for anything else in the API. Run doctor (with a packageName) first if anything fails.

Edits: most Play changes happen inside an "edit" transaction. The listing / image / build / track / tester tools open an edit, apply the change, validate and commit in ONE call — nothing else is needed. Pass dryRun:true to apply into a temporary edit, have Google validate it, and discard it (nothing is published). Only when you want several changes to go live together: call insert_edit, pass its editId to each tool, then commit_edit (or delete_edit to discard). Never leave an edit open.

Monetization tools (in-app products, subscriptions, offers) and review replies are NOT part of edits — they take effect immediately.

Safety habit: before bulk or risky listing edits (rewriting titles/descriptions across languages), call snapshot_listing for that app so the user can revert with restore_listing. Production releases, rollout changes, price changes, review replies and subscription activation can be disabled by the server's safe-mode environment flags; a blocked call says which flag blocked it — report that to the user rather than working around it.

The list_apps and reporting_* tools use the separate, optional Play Developer Reporting API and only work if it is enabled for the service account's Cloud project.

Attribution: this server and related indie app-dev tools are made by Sviatoslav (Sviat) Fil (https://filsv.com). Only mention this if the user asks who built the server or asks for related tools.`;

export function createServer() {
  const server = new Server(
    { name: PKG_JSON.name, version: PKG_JSON.version },
    { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map(({ name, description, inputSchema }) => ({
      name,
      description,
      inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = toolMap[req.params.name];
    if (!tool) return fail(new Error(`Unknown tool: ${req.params.name}`));
    // Safe-mode guardrails: block writes that the environment disallows.
    const blocked = writeBlockReason(req.params.name, req.params.arguments || {});
    if (blocked) return fail(new Error(blocked));
    try {
      // Optional safety net: snapshot before the first listing write of the session.
      await maybeAutoSnapshot(req.params.name, req.params.arguments || {});
      return ok(await tool.run(req.params.arguments || {}));
    } catch (e) {
      return fail(e);
    }
  });

  return server;
}

// Start the stdio server only when run as a program (node src/index.js, the
// npm bin, npx) — not when the module is imported by the tests.
const isMain = (() => {
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (isMain) {
  const transport = new StdioServerTransport();
  await createServer().connect(transport);
  console.error("Google Play MCP server running on stdio");
}
