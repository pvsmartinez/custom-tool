/**
 * Generates a short random ID suitable for in-memory records
 * (AI edit marks, etc.).  Returns an 8-character alphanumeric string.
 */
export function generateId(): string {
  return Math.random().toString(36).slice(2, 10);
}
