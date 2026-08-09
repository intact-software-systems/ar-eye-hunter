// deno-lint-ignore-file no-explicit-any

export interface SafeOutputTransformEvaluationInput {
  readonly resolverRoot: Record<string, any>;
  readonly result?: any;
  readonly operatorPath?: string;
  readonly createUuid: () => string;
  readonly readTimestamp: () => number;
}

export interface SafeOutputTransformDetails {
  readonly operator: string;
  readonly path: any;
  readonly [key: string]: any;
}

export class SafeOutputTransformError extends Error {
  readonly details: SafeOutputTransformDetails;

  constructor(message: string, details: SafeOutputTransformDetails) {
    super(message);
    this.name = 'SafeOutputTransformError';
    this.details = details;
  }
}

export function resolveSafeOutputTransformPath(
  path: any,
  input: SafeOutputTransformEvaluationInput,
): any {
  if (typeof path !== 'string' || path.trim().length <= 0) {
    return rejectSafeOutputTransform('Transform path must be a non-empty string.', {
      operator: 'path',
      path,
    });
  }

  const resultRoots = [input.result, input.result?.actual, input.result?.actual?.body];
  for (const root of [...resultRoots, toTransformResolverRoot(input)]) {
    const resolved = tryResolvePath(path, root);
    if (resolved.found) {
      return resolved.value;
    }
  }

  return rejectSafeOutputTransform(`Cannot resolve transform path {${path}}`, {
    operator: 'path',
    path,
  });
}

export function resolveSafeOutputTransformTemplate(
  value: string,
  input: SafeOutputTransformEvaluationInput,
): any {
  const root = toTransformResolverRoot(input);
  const exactMatch = value.match(/^\{([A-Za-z_$][\w$-]*(?:\.[\w$-]+)*)\}$/u);
  if (exactMatch) {
    return resolvePath(exactMatch[1], root);
  }

  return value.replaceAll(/\{([A-Za-z_$][\w$-]*(?:\.[\w$-]+)*)\}/gu, (_match, path) =>
    stringifySafeOutputTransformValue(resolvePath(path, root)),
  );
}

export function stringifySafeOutputTransformValue(value: any): string {
  if (value === undefined || value === null) {
    return String(value);
  }
  return typeof value === 'string' ? value : JSON.stringify(value);
}

export function rejectSafeOutputTransform(
  message: string,
  details: SafeOutputTransformDetails,
): never {
  throw new SafeOutputTransformError(message, details);
}

export function isSafeOutputTransformRecord(value: any): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function toTransformResolverRoot(input: SafeOutputTransformEvaluationInput): any {
  return {
    ...input.resolverRoot,
    result: input.result,
    actual: input.result?.actual,
    body: input.result?.actual?.body,
  };
}

function resolvePath(path: string, root: any): any {
  const resolved = path
    .split('.')
    .reduce(
      (value, segment) => (value === undefined || value === null ? undefined : value[segment]),
      root,
    );
  if (resolved === undefined) {
    throw new Error(`Cannot resolve placeholder {${path}}`);
  }
  return resolved;
}

function tryResolvePath(path: string, root: any): { found: boolean; value?: any } {
  const segments = path
    .replaceAll(/\[(\d+)]/g, '.$1')
    .split('.')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
  let value = root;

  for (const segment of segments) {
    if (value === undefined || value === null) {
      return { found: false };
    }
    value = value[segment];
  }

  return value === undefined ? { found: false } : { found: true, value };
}
