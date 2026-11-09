/**
 * An error that is part of normal operation ("another daemon is running",
 * "policy.json is malformed"). Printed as a message, without a stack trace.
 */
export class ExpectedError extends Error {
  override name = "ExpectedError";
}

/**
 * A file on disk was written by a newer version of this code.
 *
 * Kept apart from `ExpectedError` because the right answer differs. A policy that does not
 * parse is a file somebody is halfway through editing: the daemon waits, and the save fixes
 * it. A schema from the future never fixes itself — either the code is upgraded or the file
 * is brought back — so the caller must say which one the operator has to do instead of
 * reporting a readable file as unreadable.
 */
export class SchemaVersionError extends ExpectedError {
  override name = "SchemaVersionError";
}
