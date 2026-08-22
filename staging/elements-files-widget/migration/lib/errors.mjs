export class MigrationError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'MigrationError';
    this.code = code;
    this.details = details;
  }
}

export function invariant(condition, code, message, details = undefined) {
  if (!condition) throw new MigrationError(code, message, details);
}

export function asIssue(error) {
  return {
    code: error && error.code ? error.code : 'unexpected_error',
    message: error instanceof Error ? error.message : String(error),
    ...(error && error.details !== undefined ? { details: error.details } : {})
  };
}
