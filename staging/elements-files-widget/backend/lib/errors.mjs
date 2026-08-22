export class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function invariant(condition, status, code, message, details) {
  if (!condition) throw new AppError(status, code, message, details);
}

export function asAppError(error) {
  if (error instanceof AppError) return error;
  return new AppError(500, 'internal_error', 'Внутренняя ошибка staging-сервиса');
}
