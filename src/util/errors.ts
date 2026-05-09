/** Type guard for Node.js filesystem errors (have a `code` field). */
export function isErrnoException(e: unknown): e is NodeJS.ErrnoException {
  return (
    e instanceof Error &&
    typeof (e as NodeJS.ErrnoException).code === 'string'
  );
}

/** Best-effort string extraction for unknown caught values. */
export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}
