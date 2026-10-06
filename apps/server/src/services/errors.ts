import { normalizeUnknownError } from '@merkur/shared';
import { Data } from 'effect';

export class InfrastructureError extends Data.TaggedError('InfrastructureError')<{
  readonly cause: unknown;
  readonly message: string;
  readonly operation: string;
  readonly service: string;
}> {}

export function infrastructureError(service: string, operation: string) {
  return (cause: unknown) => {
    const normalized = normalizeUnknownError(cause);
    return new InfrastructureError({
      cause,
      message: normalized.message,
      operation,
      service,
    });
  };
}
