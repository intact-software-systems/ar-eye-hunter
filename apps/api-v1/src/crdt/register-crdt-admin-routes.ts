import type { Context, Hono } from 'jsr:@hono/hono@4.11.9';

import type { AuthSession } from '@shared/api/api-config.ts';
import {
  RALLAR_CRDT_PROTOCOL_VERSION,
  type RallarCrdtAdminReadRepository,
  type RallarCrdtCatchUpResponseEnvelope,
  type RallarCrdtDocumentLifecycleState,
  type RallarCrdtDocumentRef,
  type RallarCrdtDocumentScope,
  type RallarCrdtListDocumentsInput,
} from '@shared/crdt/mod.ts';
import type {
  IssuedAuthSession,
} from '@shared-server/rallar-system/auth/persistence/auth-session-repository.ts';
import {
  decodeExactDocumentRef,
} from '@shared-server/rallar-system/crdt/mutation/crdt-mutation-value-codec.ts';

import { toAuthErrorResponse, toAuthSession } from '../services/request-auth-service.ts';
import type {
  CrdtAdminMutationOperation,
  CrdtAdminMutations,
} from './create-crdt-admin-mutations.ts';

export interface RallarCrdtAdminAuthorizationInput {
  readonly session: AuthSession;
  readonly context: Context;
}

export interface RallarCrdtCatchUpAuthorizationInput {
  readonly document: RallarCrdtDocumentRef;
  readonly session: AuthSession;
}

export interface RallarCrdtCatchUpAuthorizationDecision {
  readonly allowed: boolean;
}

export interface CrdtAdminRouteDependencies {
  readonly repository: RallarCrdtAdminReadRepository;
  readonly crdtAdminMutations: CrdtAdminMutations;
  readonly now?: () => number;
  readonly requireAuth?: boolean;
  readonly adminClientIds?: readonly string[];
  readonly authorizeAdmin?: (
    input: RallarCrdtAdminAuthorizationInput,
  ) => boolean | Promise<boolean>;
  readonly requireApiAdminSession: (context: Context) => Promise<IssuedAuthSession>;
  readonly requireApiUserSession: (context: Context) => Promise<IssuedAuthSession>;
  readonly authorizeCatchUp?: (
    input: RallarCrdtCatchUpAuthorizationInput,
  ) => Promise<RallarCrdtCatchUpAuthorizationDecision>;
}

interface ProcessCrdtAdminMutationInput {
  readonly context: Context;
  readonly dependencies: CrdtAdminRouteDependencies;
  readonly operation: CrdtAdminMutationOperation;
  readonly request: JsonObject;
}

type JsonScalar = boolean | null | number | string;
type JsonValue = JsonScalar | JsonObject | JsonValue[];

interface JsonObject {
  readonly [key: string]: JsonValue;
}

interface CrdtAdminDebugExportRequest {
  readonly document: RallarCrdtDocumentRef;
  readonly reason?: string;
  readonly redactPayloads?: boolean;
}

interface CrdtCatchUpRouteRequest {
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

export function registerCrdtAdminRoutes(
  app: Hono,
  dependencies: CrdtAdminRouteDependencies,
): void {
  const requireAuth = dependencies.requireAuth ?? true;
  registerCrdtAdminAuthorization(app, dependencies, requireAuth);
  registerCrdtCatchUpRoute(app, dependencies, requireAuth);
  registerCrdtAdminReadRoutes(app, dependencies);
  registerCrdtAdminMutationRoutes(app, dependencies);
}

function registerCrdtAdminAuthorization(
  app: Hono,
  dependencies: CrdtAdminRouteDependencies,
  requireAuth: boolean,
): void {
  if (!requireAuth) {
    return;
  }
  app.use('/api/crdt/admin/*', async (context, next) => {
    try {
      await requireCrdtAdminSession(context, dependencies);
      await next();
    } catch (error) {
      return toAuthErrorResponse(context, error);
    }
  });
}

function registerCrdtCatchUpRoute(
  app: Hono,
  dependencies: CrdtAdminRouteDependencies,
  requireAuth: boolean,
): void {
  app.post('/api/crdt/catch-up', async (context) => {
    const session = requireAuth ? await readCrdtCatchUpSession(context, dependencies) : undefined;
    if (session instanceof Response) {
      return session;
    }
    return await withAdminError(context, async () => {
      const request = decodeCrdtCatchUpRequest(await readJson(context));
      await requireCrdtCatchUpAuthorization(request.document, session, dependencies);
      return await readCrdtCatchUpResponse(dependencies, request);
    });
  });
}

function registerCrdtAdminReadRoutes(
  app: Hono,
  dependencies: CrdtAdminRouteDependencies,
): void {
  app.post(
    '/api/crdt/admin/documents/list',
    (context) =>
      withAdminError(context, async () =>
        await dependencies.repository.listDocuments(
          decodeCrdtListDocumentsInput(await readJson(context)),
        )),
  );
  app.post(
    '/api/crdt/admin/documents/integrity',
    (context) =>
      withAdminError(context, async () =>
        await dependencies.repository.verifyIntegrity(
          decodeCrdtDocumentRequest(await readJson(context)),
        )),
  );
  app.post(
    '/api/crdt/admin/documents/debug-export',
    (context) =>
      withAdminError(context, async () => await exportCrdtDebugBundle(context, dependencies)),
  );
  app.post(
    '/api/crdt/admin/documents/backup-export',
    (context) =>
      withAdminError(context, async () =>
        await dependencies.repository.exportBackupBundle(
          decodeCrdtDocumentRequest(await readJson(context)),
        )),
  );
}

function registerCrdtAdminMutationRoutes(
  app: Hono,
  dependencies: CrdtAdminRouteDependencies,
): void {
  app.post(
    '/api/crdt/admin/documents/rebuild-projection',
    (context) =>
      withAdminError(context, async () => {
        return await processCrdtAdminMutation({
          context,
          dependencies,
          operation: 'rebuild-projection',
          request: await readJson(context),
        });
      }),
  );
  app.post('/api/crdt/admin/documents/compact', (context) =>
    withAdminError(context, async () => {
      return await processCrdtAdminMutation({
        context,
        dependencies,
        operation: 'compact',
        request: await readJson(context),
      });
    }));
  app.post('/api/crdt/admin/documents/lifecycle', (context) =>
    withAdminError(context, async () => {
      return await processCrdtAdminMutation({
        context,
        dependencies,
        operation: 'lifecycle',
        request: await readJson(context),
      });
    }));
  app.post('/api/crdt/admin/documents/erase', (context) =>
    withAdminError(context, async () => {
      return await processCrdtAdminMutation({
        context,
        dependencies,
        operation: 'erase',
        request: await readJson(context),
      });
    }));
}

async function exportCrdtDebugBundle(
  context: Context,
  dependencies: CrdtAdminRouteDependencies,
) {
  const request = decodeCrdtDebugExportRequest(await readJson(context));
  return await dependencies.repository.exportDebugBundle(request.document, {
    reason: request.reason ?? 'api-v1-admin-export',
    redaction: request.redactPayloads === false ? { payloadsRedacted: false } : {
      payloadsRedacted: true,
      reason: 'api-v1-admin-redaction',
    },
  });
}

async function processCrdtAdminMutation(
  input: ProcessCrdtAdminMutationInput,
) {
  const adminSession = await requireCrdtAdminSession(input.context, input.dependencies);
  return await input.dependencies.crdtAdminMutations.writeCrdtAdminMutation({
    operation: input.operation,
    adminSession,
    request: input.request,
  });
}

async function readCrdtCatchUpSession(
  context: Context,
  dependencies: CrdtAdminRouteDependencies,
): Promise<AuthSession | Response> {
  try {
    return toAuthSession(await dependencies.requireApiUserSession(context));
  } catch (error) {
    return toAuthErrorResponse(context, error);
  }
}

async function requireCrdtCatchUpAuthorization(
  document: RallarCrdtDocumentRef,
  session: AuthSession | undefined,
  dependencies: CrdtAdminRouteDependencies,
): Promise<void> {
  if (!session || !dependencies.authorizeCatchUp) {
    return;
  }
  const decision = await dependencies.authorizeCatchUp({ document, session });
  if (!decision.allowed) {
    throw forbidden('CRDT catch-up authorization required.');
  }
}

function forbidden(message: string): Error {
  return Object.assign(new Error(`Forbidden: ${message}`), { status: 403 });
}

async function withAdminError<TResult>(
  context: Context,
  execute: () => Promise<TResult>,
): Promise<Response> {
  try {
    const result = await execute();
    return context.json({ ok: true, result });
  } catch (error) {
    return context.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      },
      readErrorStatus(error),
    );
  }
}

async function requireCrdtAdminSession(
  context: Context,
  dependencies: CrdtAdminRouteDependencies,
): Promise<AuthSession> {
  const session = await dependencies.requireApiAdminSession(context);
  const authorized = await isCrdtAdminSessionAuthorized(session, context, dependencies);
  if (!authorized) {
    throw forbidden('CRDT admin authorization required.');
  }
  return session;
}

async function isCrdtAdminSessionAuthorized(
  session: AuthSession,
  context: Context,
  dependencies: CrdtAdminRouteDependencies,
): Promise<boolean> {
  if (dependencies.authorizeAdmin) {
    return await dependencies.authorizeAdmin({ session, context });
  }
  if (dependencies.adminClientIds) {
    return dependencies.adminClientIds.includes(session.clientId);
  }
  return true;
}

function readErrorStatus(error: unknown): 400 | 401 | 403 | 404 | 409 | 429 | 503 {
  if (!error || typeof error !== 'object' || !('status' in error)) {
    return 400;
  }
  const status = Number(Reflect.get(error, 'status'));
  switch (status) {
    case 401:
    case 403:
    case 404:
    case 409:
    case 429:
    case 503:
      return status;
    default:
      return 400;
  }
}

async function readJson(context: Context): Promise<JsonObject> {
  try {
    return requireRecord(
      decodeJsonValue(await context.req.json()),
      'JSON request body',
    );
  } catch {
    return {};
  }
}

function decodeCrdtDocumentRequest(input: JsonObject): RallarCrdtDocumentRef {
  const request = requireRecord(input, 'CRDT admin request');
  return decodeExactDocumentRef(
    'document' in request ? request.document : request,
    'CRDT admin request document',
  );
}

function decodeCrdtDebugExportRequest(input: JsonObject): CrdtAdminDebugExportRequest {
  const request = requireRecord(input, 'CRDT debug export request');
  requireExactKeys(
    request,
    ['document', 'reason', 'redactPayloads'],
    'CRDT debug export request',
  );
  return {
    document: decodeExactDocumentRef(request.document, 'CRDT debug export document'),
    reason: readOptionalString(request.reason, 'CRDT debug export reason'),
    redactPayloads: readOptionalBoolean(
      request.redactPayloads,
      'CRDT debug export redactPayloads',
    ),
  };
}

function decodeCrdtListDocumentsInput(input: JsonObject): RallarCrdtListDocumentsInput {
  const request = requireRecord(input, 'CRDT document list request');
  requireExactKeys(
    request,
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
    applicationId: readOptionalString(request.applicationId, 'CRDT applicationId'),
    workspaceId: readOptionalString(request.workspaceId, 'CRDT workspaceId'),
    scope: readOptionalDocumentScope(request.scope),
    documentType: readOptionalString(request.documentType, 'CRDT documentType'),
    lifecycle: readOptionalDocumentLifecycle(request.lifecycle),
    limit: readOptionalNonNegativeInteger(request.limit, 'CRDT list limit'),
    cursor: readOptionalString(request.cursor, 'CRDT list cursor'),
  };
}

function decodeCrdtCatchUpRequest(input: JsonObject): CrdtCatchUpRouteRequest {
  const request = requireRecord(input, 'CRDT catch-up request');
  requireExactKeys(
    request,
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
    request.protocolVersion,
    'CRDT protocolVersion',
  );
  if (protocolVersion !== undefined && protocolVersion !== RALLAR_CRDT_PROTOCOL_VERSION) {
    throw new TypeError('CRDT catch-up protocolVersion is unsupported');
  }
  return {
    protocolVersion,
    requestId: readOptionalString(request.requestId, 'CRDT catch-up requestId'),
    document: decodeExactDocumentRef(request.document, 'CRDT catch-up document'),
    replicaId: readOptionalString(request.replicaId, 'CRDT catch-up replicaId'),
    createdAtEpochMs: readOptionalNonNegativeInteger(
      request.createdAtEpochMs,
      'CRDT catch-up createdAtEpochMs',
    ),
    afterSequence: readOptionalNonNegativeInteger(
      request.afterSequence,
      'CRDT catch-up afterSequence',
    ),
    afterCursor: readOptionalString(request.afterCursor, 'CRDT catch-up afterCursor'),
    maxUpdateCount: readOptionalNonNegativeInteger(
      request.maxUpdateCount,
      'CRDT catch-up maxUpdateCount',
    ),
    includeSnapshot: readOptionalBoolean(
      request.includeSnapshot,
      'CRDT catch-up includeSnapshot',
    ),
  };
}

async function readCrdtCatchUpResponse(
  dependencies: CrdtAdminRouteDependencies,
  request: CrdtCatchUpRouteRequest,
): Promise<RallarCrdtCatchUpResponseEnvelope> {
  const page = await dependencies.repository.listAfter({
    document: request.document,
    afterSequence: request.afterSequence,
    afterCursor: request.afterCursor,
    limit: request.maxUpdateCount,
  });
  const snapshot = request.includeSnapshot === false
    ? undefined
    : await dependencies.repository.readSnapshot(request.document);
  return {
    protocolVersion: RALLAR_CRDT_PROTOCOL_VERSION,
    requestId: request.requestId ?? crypto.randomUUID(),
    document: request.document,
    createdAtEpochMs: dependencies.now?.() ?? Date.now(),
    snapshot,
    page,
  };
}

function decodeJsonValue(value: unknown): JsonValue {
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'number' ||
    typeof value === 'string'
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(decodeJsonValue);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, decodeJsonValue(entry)]),
    );
  }
  throw new TypeError('JSON request body contains a non-JSON value');
}

function requireRecord(value: JsonValue, label: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

function requireExactKeys(
  value: JsonObject,
  allowedKeys: readonly string[],
  label: string,
): void {
  const unexpectedKey = Object.keys(value).find((key) => !allowedKeys.includes(key));
  if (unexpectedKey) {
    throw new TypeError(`${label} contains unexpected field ${unexpectedKey}`);
  }
}

function readOptionalString(value: JsonValue | undefined, label: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

function readOptionalBoolean(value: JsonValue | undefined, label: string): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'boolean') {
    throw new TypeError(`${label} must be a boolean`);
  }
  return value;
}

function readOptionalNonNegativeInteger(
  value: JsonValue | undefined,
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
  value: JsonValue | undefined,
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
  value: JsonValue | undefined,
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
