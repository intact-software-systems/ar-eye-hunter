import {
  RALLAR_CRDT_PROTOCOL_VERSION,
  type RallarCrdtValidationIssue,
  type RallarCrdtValidationOptions,
  type RallarCrdtValidationResult,
  validateRallarCrdtDocumentRef,
} from '@shared/crdt/mod.ts';

export function validateRallarCrdtCatchUpRequestEnvelope(
  value: unknown,
  path: string,
  options: RallarCrdtValidationOptions,
): RallarCrdtValidationResult {
  const issues: RallarCrdtValidationIssue[] = [];
  if (!isRecord(value)) {
    return {
      valid: false,
      issues: [
        {
          path,
          code: 'invalid-catch-up-request',
          message: 'CRDT catch-up request must be an object.',
        },
      ],
    };
  }

  requireExactProtocolVersion(value.protocolVersion, path, issues);
  requireNonEmptyString(value.requestId, `${path}.requestId`, issues);
  requireNonEmptyString(value.replicaId, `${path}.replicaId`, issues);
  requireNonNegativeInteger(value.createdAtEpochMs, `${path}.createdAtEpochMs`, issues);
  if (value.afterSequence !== undefined) {
    requireNonNegativeInteger(value.afterSequence, `${path}.afterSequence`, issues);
  }
  if (value.afterCursor !== undefined) {
    requireNonEmptyString(value.afterCursor, `${path}.afterCursor`, issues);
  }
  if (value.maxUpdateCount !== undefined) {
    requireNonNegativeInteger(value.maxUpdateCount, `${path}.maxUpdateCount`, issues);
  }
  if (value.includeSnapshot !== undefined && typeof value.includeSnapshot !== 'boolean') {
    issues.push({
      path: `${path}.includeSnapshot`,
      code: 'invalid-include-snapshot',
      message: 'CRDT catch-up includeSnapshot must be boolean.',
    });
  }
  issues.push(...validateRallarCrdtDocumentRef(value.document, `${path}.document`, options).issues);

  return {
    valid: issues.length === 0,
    issues,
  };
}

export function validateRallarCrdtCatchUpResponseEnvelope(
  value: unknown,
  path: string,
  options: RallarCrdtValidationOptions,
): RallarCrdtValidationResult {
  const issues: RallarCrdtValidationIssue[] = [];
  if (!isRecord(value)) {
    return {
      valid: false,
      issues: [
        {
          path,
          code: 'invalid-catch-up-response',
          message: 'CRDT catch-up response must be an object.',
        },
      ],
    };
  }

  requireExactProtocolVersion(value.protocolVersion, path, issues);
  requireNonEmptyString(value.requestId, `${path}.requestId`, issues);
  requireNonNegativeInteger(value.createdAtEpochMs, `${path}.createdAtEpochMs`, issues);
  if (!isRecord(value.page)) {
    issues.push({
      path: `${path}.page`,
      code: 'invalid-catch-up-page',
      message: 'CRDT catch-up response page must be an object.',
    });
  }
  issues.push(...validateRallarCrdtDocumentRef(value.document, `${path}.document`, options).issues);

  return {
    valid: issues.length === 0,
    issues,
  };
}

function requireExactProtocolVersion(
  value: unknown,
  path: string,
  issues: RallarCrdtValidationIssue[],
): void {
  if (value !== RALLAR_CRDT_PROTOCOL_VERSION) {
    issues.push({
      path: `${path}.protocolVersion`,
      code: 'unknown-protocol-version',
      message: `Expected ${RALLAR_CRDT_PROTOCOL_VERSION}.`,
    });
  }
}

function requireNonEmptyString(
  value: unknown,
  path: string,
  issues: RallarCrdtValidationIssue[],
): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    issues.push({
      path,
      code: 'invalid-non-empty-string',
      message: 'Expected a non-empty string.',
    });
  }
}

function requireNonNegativeInteger(
  value: unknown,
  path: string,
  issues: RallarCrdtValidationIssue[],
): void {
  if (!Number.isInteger(value) || (value as number) < 0) {
    issues.push({
      path,
      code: 'invalid-non-negative-integer',
      message: 'Expected a non-negative integer.',
    });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
