/**
 * An error that is part of normal operation ("another daemon is running",
 * "policy.json is malformed"). Printed as a message, without a stack trace.
 */
export class ExpectedError extends Error {
  override name = "ExpectedError";
}
