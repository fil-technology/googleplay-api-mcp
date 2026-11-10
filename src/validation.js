// Field validation + diffing for Google Play store metadata.
// Extracted into its own module so it can be unit-tested.

// Google Play's length limits for editable listing fields. These come from
// Play Console Help ("Create and set up your app"), not the API reference —
// the API itself is the final judge and rejects over-limit text on validate.
export const LIMITS = {
  title: 30,
  shortDescription: 80,
  fullDescription: 4000,
};

// Per-language "What's new" text on a release.
export const RELEASE_NOTES_LIMIT = 500;
// reviews.reply: "Replies of more than approximately 350 characters will be rejected."
export const REVIEW_REPLY_LIMIT = 350;

export const IMAGE_TYPES = [
  "icon",
  "featureGraphic",
  "phoneScreenshots",
  "sevenInchScreenshots",
  "tenInchScreenshots",
  "tvBanner",
  "tvScreenshots",
  "wearScreenshots",
];

/** Warn about fields that exceed Google Play's limits. Non-blocking. */
export function validateAttributes(attributes) {
  const warnings = [];
  for (const [field, value] of Object.entries(attributes || {})) {
    const limit = LIMITS[field];
    if (limit && typeof value === "string" && value.length > limit) {
      warnings.push(
        `'${field}' is ${value.length} chars — exceeds Google Play's limit of ${limit}.`,
      );
    }
  }
  return warnings;
}

/** Warn about release notes over the per-language limit or malformed entries. */
export function validateReleaseNotes(releaseNotes) {
  const warnings = [];
  for (const note of releaseNotes || []) {
    if (!note || !note.language || typeof note.text !== "string") {
      warnings.push("Each release note needs { language, text }.");
      continue;
    }
    if (note.text.length > RELEASE_NOTES_LIMIT)
      warnings.push(
        `Release notes for '${note.language}' are ${note.text.length} chars — exceeds Google Play's limit of ${RELEASE_NOTES_LIMIT}.`,
      );
  }
  return warnings;
}

/** Warn about a review reply that Google is likely to reject for length. */
export function validateReplyText(text) {
  return typeof text === "string" && text.length > REVIEW_REPLY_LIMIT
    ? [
        `Reply is ${text.length} chars — Google Play rejects replies over ~${REVIEW_REPLY_LIMIT}.`,
      ]
    : [];
}

/** Throw a clear error for something that is obviously not a package name. */
export function assertPackageName(packageName) {
  if (
    typeof packageName !== "string" ||
    !/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/.test(packageName)
  )
    throw new Error(
      `'${packageName}' is not a valid packageName — expected an application id like 'com.example.app'.`,
    );
  return packageName;
}

/**
 * Build a field-by-field diff between current attributes and proposed changes,
 * including length/limit info. Used by dry-run mode.
 */
export function buildDiff(current = {}, attributes = {}) {
  const changes = [];
  for (const [field, to] of Object.entries(attributes)) {
    const from = current[field] ?? null;
    const limit = LIMITS[field];
    changes.push({
      field,
      from,
      to,
      changed: from !== to,
      ...(limit
        ? {
            newLength: typeof to === "string" ? to.length : null,
            limit,
            exceedsLimit: typeof to === "string" ? to.length > limit : false,
          }
        : {}),
    });
  }
  return changes;
}
