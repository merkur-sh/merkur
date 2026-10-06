import { Elysia, NotFound, status, ValidationError } from 'elysia';

import { UnauthorizedRequestError } from '../middleware/authenticated-user';

const STATUS_BAD_REQUEST = 400;
const STATUS_UNAUTHORIZED = 401;
const STATUS_NOT_FOUND = 404;
const STATUS_INTERNAL_ERROR = 500;
const GENERIC_VALIDATION_DETAIL = 'invalid request';

/**
 * Every error response the API produces.
 *
 * Apply before route plugins so every route inherits the global error handler.
 * The composed-app tests cover validation, authentication and routing errors.
 *
 * Security headers are not set here: `securityHeadersPlugin` installs them as
 * default response headers, which Elysia seeds into the request context before
 * routing, so they are already present on everything returned below.
 */
export const apiErrorPlugin = new Elysia({ name: 'api-errors' }).error('global', ({ error }) => {
  if (error instanceof UnauthorizedRequestError) {
    return status(STATUS_UNAUTHORIZED, { error: 'unauthorized' });
  }

  if (error instanceof ValidationError) {
    return status(STATUS_BAD_REQUEST, {
      error: 'invalid_request',
      details: validationMessage(error) ?? GENERIC_VALIDATION_DETAIL,
    });
  }

  if (error instanceof NotFound) {
    return status(STATUS_NOT_FOUND, { error: 'not_found' });
  }

  // Nothing derived from the error reaches the client: an unmapped failure is
  // by definition one no route classified, so its message may carry internal
  // detail. `runRouteEffect` has already logged it with full context.
  return status(STATUS_INTERNAL_ERROR, { error: 'internal_error' });
});

/** Only schema-authored validationDetail messages may cross the HTTP boundary.
 * Framework error messages and payloads can contain submitted credential material.
 */
function validationMessage(error: ValidationError): string | null {
  const detail = error.customError;
  if (typeof detail !== 'object' || detail === null || !('message' in detail)) {
    return null;
  }
  return typeof detail.message === 'string' && detail.message.length > 0 ? detail.message : null;
}
