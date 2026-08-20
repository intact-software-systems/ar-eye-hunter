import {
  RALLAR_CRDT_PROTOCOL_VERSION,
  type RallarCrdtDocumentLifecycleState,
  type RallarCrdtDocumentRef,
  type RallarCrdtDocumentScope,
  type RallarCrdtListDocumentsInput,
} from '@shared/crdt/mod.ts';
import {
  decodeExactDocumentRef,
} from '@shared-server/rallar-system/crdt/mutation/crdt-mutation-value-codec.ts';
import type {
  JsonWireObject,
  JsonWireValue,
} from '@shared-server/rallar-system/services/mutation-command-identity.ts';

export interface CrdtAdminDebugExportRequest {
  readonly document: RallarCrdtDocumentRef;
  readonly reason?: string;
  readonly redactPayloads?: boolean;
}

export interface CrdtCatchUpRouteRequest {
  readonly protocolVersion?: number;
  readonly requestId?: string;
  readonly document: RallarCrdtDocumentRef;
  readonly replicaId?: string;
  readonly createdAtEpochMs?: number;
  readonly afterSequence?: number;
  readonly afterCursor?: string;
  readonly maxUpdateCount?: number;
  readonly includeSnapshot?: boolean;
}

export function decodeCrdtAdminJsonObject(value: JsonWireValue, label: string): JsonWireObject {
  return requireRecord(value, label);
}

export function decodeCrdtDocumentRequest(input: JsonWireObject): RallarCrdtDocumentRef {
  return decodeExactDocumentRef(
    'document' in input ? input.document : input,
    'CRDT admin request document',
  );
}

export function decodeCrdtDebugExportRequest(
  input: JsonWireObject,
): CrdtAdminDebugExportRequest {
  requireExactKeys(
    input,
    ['document', 'reason', 'redactPayloads'],
    'CRDT debug export request',
  );
  return {
    document: decodeExactDocumentRef(input.document, 'CRDT debug export document'),
    reason: readOptionalString(input.reason, 'CRDT debug export reason'),
    redactPayloads: readOptionalBoolean(
      input.redactPayloads,
      'CRDT debug export redactPayloads',
    ),
  };
}

export function decodeCrdtListDocumentsInput(
  input: JsonWireObject,
): RallarCrdtListDocumentsInput {
  requireExactKeys(
    input,
    [
      'applicationId',
      'workspaceId',
      'scope',
      'documentType',
      'lifecycle',
      'limit',
      'cursor',
    ],
    'CRDT document list request',
  );
  return {
    applicationId: readOptionalString(input.applicationId, 'CRDT applicationId'),
    workspaceId: readOptionalString(input.workspaceId, 'CRDT workspaceId'),
    scope: readOptionalDocumentScope(input.scope),
    documentType: readOptionalString(input.documentType, 'CRDT documentType'),
    lifecycle: readOptionalDocumentLifecycle(input.lifecycle),
    limit: readOptionalNonNegativeInteger(input.limit, 'CRDT list limit'),
    cursor: readOptionalString(input.cursor, 'CRDT list cursor'),
  };
}

export function decodeCrdtCatchUpRequest(input: JsonWireObject): CrdtCatchUpRouteRequest {
  requireExactKeys(
    input,
    [
      'protocolVersion',
      'requestId',
      'document',
      'replicaId',
      'createdAtEpochMs',
      'afterSequence',
      'afterCursor',
      'maxUpdateCount',
      'includeSnapshot',
    ],
    'CRDT catch-up request',
  );
  const protocolVersion = readOptionalNonNegativeInteger(
    input.protocolVersion,
    'CRDT protocolVersion',
  );
  if (protocolVersion !== undefined && protocolVersion !== RALLAR_CRDT_PROTOCOL_VERSION) {
    throw new TypeError('CRDT catch-up protocolVersion is unsupported');
  }
  return {
    protocolVersion,
    requestId: readOptionalString(input.requestId, 'CRDT catch-up requestId'),
    document: decodeExactDocumentRef(input.document, 'CRDT catch-up document'),
    replicaId: readOptionalString(input.replicaId, 'CRDT catch-up replicaId'),
    createdAtEpochMs: readOptionalNonNegativeInteger(
      input.createdAtEpochMs,
      'CRDT catch-up createdAtEpochMs',
    ),
    afterSequence: readOptionalNonNegativeInteger(
      input.afterSequence,
      'CRDT catch-up afterSequence',
    ),
    afterCursor: readOptionalString(input.afterCursor, 'CRDT catch-up afterCursor'),
    maxUpdateCount: readOptionalNonNegativeInteger(
      input.maxUpdateCount,
      'CRDT catch-up maxUpdateCount',
    ),
    includeSnapshot: readOptionalBoolean(input.includeSnapshot, 'CRDT catch-up includeSnapshot'),
  };
}

function requireRecord(value: JsonWireValue, label: string): JsonWireObject {
  if (!isJsonWireObject(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

function isJsonWireObject(value: JsonWireValue): value is JsonWireObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireExactKeys(
  value: JsonWireObject,
  allowedKeys: readonly string[],
  label: string,
): void {
  const unexpectedKey = Object.keys(value).find((key) => !allowedKeys.includes(key));
  if (unexpectedKey) {
    throw new TypeError(`${label} contains unexpected field ${unexpectedKey}`);
  }
}

function readOptionalString(
  value: JsonWireValue | undefined,
  label: string,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

function readOptionalBoolean(
  value: JsonWireValue | undefined,
  label: string,
): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'boolean') {
    throw new TypeError(`${label} must be a boolean`);
  }
  return value;
}

function readOptionalNonNegativeInteger(
  value: JsonWireValue | undefined,
  label: string,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isInteger(value) || Number(value) < 0) {
    throw new TypeError(`${label} must be a non-negative integer`);
  }
  return Number(value);
}

function readOptionalDocumentScope(
  value: JsonWireValue | undefined,
): RallarCrdtDocumentScope | undefined {
  switch (value) {
    case undefined:
      return undefined;
    case 'app':
    case 'room':
    case 'principal':
    case 'custom':
      return value;
    default:
      throw new TypeError('CRDT document scope is invalid');
  }
}

function readOptionalDocumentLifecycle(
  value: JsonWireValue | undefined,
): RallarCrdtDocumentLifecycleState | undefined {
  switch (value) {
    case undefined:
      return undefined;
    case 'active':
    case 'archived':
    case 'destroyed':
      return value;
    default:
      throw new TypeError('CRDT document lifecycle is invalid');
  }
}
