/**
 * A failure the caller can act on, thrown by repositories and routes instead
 * of bare Errors whose message has to be pattern-matched into a status.
 * `code` is the snake_case machine code sent to clients as `{ error: code }`;
 * `status` is the HTTP status to answer with. The message defaults to the
 * code, so nothing user-supplied or vendor-supplied leaks through it.
 */
export class DomainError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    message: string = code,
  ) {
    super(message);
    this.name = "DomainError";
  }
}

/** True for a DomainError, including one from another copy of this package (name + fields). */
export function isDomainError(value: unknown): value is DomainError {
  if (value instanceof DomainError) return true;
  if (!(value instanceof Error) || value.name !== "DomainError") return false;
  const { code, status } = value as Partial<DomainError>;
  return typeof code === "string" && typeof status === "number";
}
