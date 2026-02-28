/**
 * Stable error text extraction for transport and parsing failures.
 */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
