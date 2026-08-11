import type { StateErrorResponse } from '@shared/api/state-types.ts';

export type ApiHttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

export class ApiHttpError extends Error {
  public readonly policyError?: StateErrorResponse & Readonly<{ code: string }>;

  public readonly method: ApiHttpMethod;
  public readonly path: string;
  public readonly status: number;
  public readonly bodyText: string;
  public readonly headers?: Headers;

  public constructor(
    method: ApiHttpMethod,
    path: string,
    status: number,
    bodyText: string,
    headers?: Headers,
  ) {
    super(`API ${method} ${path} failed: ${status} ${bodyText}`);
    this.method = method;
    this.path = path;
    this.status = status;
    this.bodyText = bodyText;
    this.headers = headers;
    this.name = 'ApiHttpError';
    this.policyError = parseApiPolicyError(bodyText);
  }
}

export function readApiPolicyError<T>(
  error: T,
): (StateErrorResponse & Readonly<{ code: string }>) | undefined {
  return error instanceof ApiHttpError ? error.policyError : undefined;
}

function parseApiPolicyError(
  bodyText: string,
): (StateErrorResponse & Readonly<{ code: string }>) | undefined {
  try {
    const value = JSON.parse(bodyText);
    if (!isRecord(value) || typeof value.error !== 'string' || typeof value.code !== 'string') {
      return undefined;
    }
    return {
      error: value.error,
      code: value.code,
      message: typeof value.message === 'string' ? value.message : undefined,
      details: isRecord(value.details) ? value.details : undefined,
    };
  } catch {
    return undefined;
  }
}

function isRecord<T>(value: T): value is T & JsonRecord {
  return typeof value === 'object' && value !== null;
}

type JsonValue = string | number | boolean | null | JsonValue[] | JsonRecord;

interface JsonRecord {
  readonly [key: string]: JsonValue;
}
