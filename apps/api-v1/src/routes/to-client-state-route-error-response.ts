interface ClientStateRouteErrorResponseWriter {
  json(value: ClientStateRouteErrorBody, status?: number): Response;
}

interface ClientStateRouteErrorBody {
  readonly error: string;
  readonly code?: string;
}

interface SerializedRouteError {
  readonly error?: string;
  readonly message?: string;
  readonly code?: string;
  readonly status?: number;
}

interface JsonObject {
  readonly [key: string]: JsonValue;
}

type JsonPrimitive = boolean | null | number | string;
type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];

export function toClientStateRouteErrorResponse(
  response: ClientStateRouteErrorResponseWriter,
  error: Error,
): Response {
  const message = error.message;
  const serialized = readSerializedRouteError(message);
  const explicitStatus = readErrorStatus(error) ?? serialized?.status;
  const responseMessage = serialized?.error ?? serialized?.message ?? message;
  const status = explicitStatus ?? inferErrorStatus(message);

  return response.json({
    error: responseMessage,
    ...(serialized?.code ? { code: serialized.code } : {}),
  }, status);
}

function inferErrorStatus(message: string): number {
  if (message.includes('not found')) return 404;
  if (message.startsWith('Unauthorized:')) return 401;
  if (message.startsWith('Forbidden:')) return 403;
  return message.includes('already exists') ? 409 : 400;
}

function readErrorStatus(error: Error): number | undefined {
  if (
    !('status' in error) || !Number.isSafeInteger(error.status) ||
    (error.status as number) < 400 || (error.status as number) > 599
  ) {
    return undefined;
  }
  return error.status as number;
}

function readSerializedRouteError(message: string): SerializedRouteError | undefined {
  try {
    const value: JsonValue = JSON.parse(message);
    if (!isJsonObject(value)) {
      return undefined;
    }
    const status = Number.isSafeInteger(value.status) &&
        (value.status as number) >= 400 && (value.status as number) <= 599
      ? value.status as number
      : undefined;
    return {
      ...(typeof value.error === 'string' ? { error: value.error } : {}),
      ...(typeof value.message === 'string' ? { message: value.message } : {}),
      ...(typeof value.code === 'string' ? { code: value.code } : {}),
      ...(status === undefined ? {} : { status }),
    };
  } catch {
    return undefined;
  }
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
