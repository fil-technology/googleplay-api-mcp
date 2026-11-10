// The Google Play "edit" transaction model, wrapped so tools feel atomic.
// Most Play changes happen inside an edit: edits.insert → mutate → edits.commit.
// These helpers guarantee an edit this server opened is never left dangling:
// it is committed, or deleted (on dry-run, on failure, and after pure reads).
// Extracted so the lifecycle can be unit-tested with a fake client.

const enc = encodeURIComponent;

export const editsPath = (packageName) => `/applications/${enc(packageName)}/edits`;
export const editPath = (packageName, editId) =>
  `${editsPath(packageName)}/${enc(editId)}`;

/** Delete an edit, reporting (not throwing) if that fails. */
async function discard(client, packageName, editId) {
  try {
    await client.delete(editPath(packageName, editId));
    return null;
  } catch (e) {
    return e;
  }
}

function commitQuery({ changesNotSentForReview, changesInReviewBehavior } = {}) {
  const q = {};
  if (changesNotSentForReview !== undefined)
    q.changesNotSentForReview = changesNotSentForReview;
  if (changesInReviewBehavior) q.changesInReviewBehavior = changesInReviewBehavior;
  return q;
}

/**
 * Run a mutation inside an edit.
 *   - editId given  → apply inside the caller's open edit; nothing is committed
 *                     (the caller batches changes and calls commit_edit).
 *   - dryRun: true  → insert + apply + validate + DELETE. Nothing is published.
 *   - otherwise     → insert + apply + validate + commit. On any failure the
 *                     edit is deleted and the error re-thrown.
 * `fn(editId)` performs the mutation(s) and returns the tool's result.
 */
export async function withEdit(client, opts, fn) {
  const { packageName, editId, dryRun } = opts;
  if (editId) {
    const result = await fn(editId);
    return {
      editId,
      committed: false,
      result,
      note: "Applied inside your open edit. Nothing is live until you call commit_edit (or discard with delete_edit).",
    };
  }

  const edit = await client.post(editsPath(packageName));
  const id = edit.id;
  const path = editPath(packageName, id);

  if (dryRun) {
    let result;
    let validation;
    try {
      result = await fn(id);
      try {
        await client.post(`${path}:validate`);
        validation = { ok: true };
      } catch (e) {
        validation = { ok: false, error: e.message };
      }
    } catch (e) {
      const leak = await discard(client, packageName, id);
      if (leak) e.message += ` (also failed to delete temporary edit ${id}: ${leak.message})`;
      throw e;
    }
    const leak = await discard(client, packageName, id);
    return {
      dryRun: true,
      validation,
      result,
      note: "No changes were written — the temporary edit was deleted. Re-run without dryRun to apply.",
      ...(leak
        ? { _warnings: [`Could not delete temporary edit ${id}: ${leak.message}. It expires on its own, or call delete_edit.`] }
        : {}),
    };
  }

  try {
    const result = await fn(id);
    await client.post(`${path}:validate`);
    const committed = await client.post(`${path}:commit`, undefined, commitQuery(opts));
    return { committed: true, editId: committed?.id || id, result };
  } catch (e) {
    const leak = await discard(client, packageName, id);
    e.message += leak
      ? ` (the edit was NOT committed; deleting edit ${id} also failed: ${leak.message} — call delete_edit)`
      : " (the edit was discarded — nothing was changed)";
    throw e;
  }
}

/**
 * Run a read that needs an edit context. Uses the caller's editId when given
 * (so you can read back uncommitted changes); otherwise opens a temporary edit
 * and always deletes it afterwards.
 */
export async function readInEdit(client, { packageName, editId }, fn) {
  if (editId) return fn(editId);
  const edit = await client.post(editsPath(packageName));
  try {
    return await fn(edit.id);
  } finally {
    await discard(client, packageName, edit.id);
  }
}
