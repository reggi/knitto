export class KnittoError extends Error {
  constructor(
    message: string,
    readonly code:
      | "DRIFT"
      | "CONFIG"
      | "SOURCE"
      | "TEMPLATE"
      | "APPLY"
      | "USAGE",
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "KnittoError";
  }
}

export const EXIT_CODES = {
  success: 0,
  drift: 1,
  config: 2,
  source: 3,
  template: 4,
  apply: 5,
  usage: 64,
} as const;

export function exitCodeFor(error: unknown): number {
  if (!(error instanceof KnittoError)) {
    return EXIT_CODES.apply;
  }

  return {
    DRIFT: EXIT_CODES.drift,
    CONFIG: EXIT_CODES.config,
    SOURCE: EXIT_CODES.source,
    TEMPLATE: EXIT_CODES.template,
    APPLY: EXIT_CODES.apply,
    USAGE: EXIT_CODES.usage,
  }[error.code];
}
