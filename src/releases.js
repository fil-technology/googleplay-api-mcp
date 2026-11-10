// Pure helpers for track releases and staged rollouts (unit-tested).
import { validateReleaseNotes } from "./validation.js";

export const RELEASE_STATUSES = ["draft", "inProgress", "halted", "completed"];

/**
 * Build a TrackRelease body from tool args, enforcing the API's rules:
 * userFraction is only valid for inProgress/halted releases and must be
 * strictly between 0 and 1; an inProgress release needs a userFraction.
 * Returns { release, warnings }.
 */
export function buildRelease(a) {
  const status = a.status;
  if (!RELEASE_STATUSES.includes(status))
    throw new Error(`status must be one of ${RELEASE_STATUSES.join(", ")}`);
  const versionCodes = (a.versionCodes || []).map(String);
  if (!versionCodes.length)
    throw new Error("versionCodes is required (the build(s) in this release)");
  if (versionCodes.some((v) => !/^\d+$/.test(v)))
    throw new Error("versionCodes must be integers");

  const release = { status, versionCodes };
  const f = a.userFraction;
  if (f !== undefined && f !== null) {
    if (status !== "inProgress" && status !== "halted")
      throw new Error(
        "userFraction can only be set when status is 'inProgress' or 'halted'. For a full rollout use status 'completed' with no userFraction.",
      );
    if (!(typeof f === "number" && f > 0 && f < 1))
      throw new Error(
        "userFraction must be a number strictly between 0 and 1 (e.g. 0.1 for 10%). For 100% use status 'completed'.",
      );
    release.userFraction = f;
  } else if (status === "inProgress") {
    throw new Error(
      "A staged rollout (status 'inProgress') needs a userFraction between 0 and 1. For a full rollout use status 'completed'.",
    );
  }
  if (a.name) release.name = a.name;
  if (a.releaseNotes && a.releaseNotes.length) release.releaseNotes = a.releaseNotes;
  if (a.inAppUpdatePriority !== undefined) {
    const p = a.inAppUpdatePriority;
    if (!Number.isInteger(p) || p < 0 || p > 5)
      throw new Error("inAppUpdatePriority must be an integer from 0 to 5");
    release.inAppUpdatePriority = p;
  }
  if (a.countryTargeting) release.countryTargeting = a.countryTargeting;
  return { release, warnings: validateReleaseNotes(a.releaseNotes) };
}

const maxCode = (r) => Math.max(0, ...(r.versionCodes || []).map(Number));

/**
 * Pick one release from a track: the one containing `versionCode` when given,
 * else the first with one of `statuses`, else the one with the highest code.
 */
export function pickRelease(track, { versionCode, statuses } = {}) {
  const releases = (track && track.releases) || [];
  if (versionCode !== undefined && versionCode !== null) {
    const v = String(versionCode);
    return releases.find((r) => (r.versionCodes || []).map(String).includes(v)) || null;
  }
  if (statuses) return releases.find((r) => statuses.includes(r.status)) || null;
  return [...releases].sort((x, y) => maxCode(y) - maxCode(x))[0] || null;
}

/**
 * Compute the release to send for a rollout change on an existing staged
 * release. `action` is 'setFraction' | 'halt' | 'resume' | 'complete'.
 * Only the modified release is sent, as in Google's staged-rollout examples.
 */
export function rolloutUpdate(track, action, { versionCode, userFraction } = {}) {
  const want = action === "resume" ? ["halted"] : ["inProgress", "halted"];
  const current =
    versionCode !== undefined && versionCode !== null
      ? pickRelease(track, { versionCode })
      : pickRelease(track, { statuses: action === "halt" ? ["inProgress"] : want });
  if (!current)
    throw new Error(
      `No ${action === "resume" ? "halted" : "staged (inProgress/halted)"} release found on track '${track?.track}'. Current releases: ${JSON.stringify(
        ((track && track.releases) || []).map((r) => ({ status: r.status, versionCodes: r.versionCodes, userFraction: r.userFraction })),
      )}`,
    );
  if (current.status !== "inProgress" && current.status !== "halted")
    throw new Error(
      `Release ${JSON.stringify(current.versionCodes)} is '${current.status}', not a staged rollout — nothing to ${action}.`,
    );

  const next = { ...current };
  if (action === "setFraction") {
    if (!(typeof userFraction === "number" && userFraction > 0 && userFraction < 1))
      throw new Error(
        "userFraction must be a number strictly between 0 and 1. To reach 100% use complete_rollout.",
      );
    next.status = "inProgress";
    next.userFraction = userFraction;
  } else if (action === "halt") {
    next.status = "halted";
  } else if (action === "resume") {
    next.status = "inProgress";
    if (userFraction !== undefined) {
      if (!(typeof userFraction === "number" && userFraction > 0 && userFraction < 1))
        throw new Error("userFraction must be a number strictly between 0 and 1.");
      next.userFraction = userFraction;
    }
  } else if (action === "complete") {
    next.status = "completed";
    delete next.userFraction;
  } else {
    throw new Error(`Unknown rollout action: ${action}`);
  }
  return { before: current, after: next };
}
