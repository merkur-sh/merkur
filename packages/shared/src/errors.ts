export function normalizeUnknownError(error: unknown, fallbackMessage?: string): Error {
  if (error instanceof Error) {
    return error;
  }

  if (fallbackMessage !== undefined && fallbackMessage.length > 0) {
    return new Error(`${fallbackMessage}: ${String(error)}`);
  }

  return new Error(String(error));
}
