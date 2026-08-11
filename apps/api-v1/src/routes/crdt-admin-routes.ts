import { type Context, Hono } from 'jsr:@hono/hono@4.11.9';
import type {
  RallarCrdtAdminLogRepository,
  RallarCrdtAuditSink,
  RallarCrdtCatchUpRequestEnvelope,
  RallarCrdtCatchUpResponseEnvelope,
  RallarCrdtDocumentRef,
  RallarCrdtListDocumentsInput,
} from '@shared/crdt/mod.ts';
import { RALLAR_CRDT_PROTOCOL_VERSION } from '@shared/crdt/mod.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import {
  requireApiAuthSession,
  toAuthErrorResponse,
  toAuthSession,
} from '../services/request-auth-service.ts';

export type RallarCrdtAdminMutationOperation =
  | 'rebuild-projection'
  | 'compact'
  | 'lifecycle'
  | 'erase';

export type RallarCrdtAdminMutations = Readonly<{
  processAdminMutationUntilCompletion(
    operation: RallarCrdtAdminMutationOperation,
    input: Readonly<{ adminSession: AuthSession; request: unknown }>,
  ): Promise<unknown>;
}>;

export type RallarCrdtAdminRoutesOptions = Readonly<{
  repository: RallarCrdtAdminLogRepository;
  mutations?: RallarCrdtAdminMutations;
  audit?: RallarCrdtAuditSink;
  now?: () => number;
  requireAuth?: boolean;
  adminClientIds?: readonly string[];
  authorizeAdmin?: (
    input: Readonly<{
      session: AuthSession;
      context: Context;
    }>,
  ) => boolean | Promise<boolean>;
  requireApiAdminSession?: (context: Context) => Promise<AuthSession>;
  requireApiUserSession?: (context: Context) => Promise<AuthSession>;
  authorizeCatchUp?: (
    input: Readonly<{ document: RallarCrdtDocumentRef; session: AuthSession }>,
  ) => Promise<Readonly<{ allowed: boolean }>>;
}>;

export function init(app: Hono, options: RallarCrdtAdminRoutesOptions): void {
  const requireAuth = options.requireAuth ?? true;

  if (requireAuth) {
    app.use('/api/crdt/admin/*', async (c, next) => {
      try {
        await requireCrdtAdminSession(c, options);
        await next();
      } catch (error) {
        return toAuthErrorResponse(c, error);
      }
    });
  }

  app.post('/api/crdt/catch-up', async (c) => {
    let session: AuthSession | undefined;
    if (requireAuth) {
      try {
        session = options.requireApiUserSession
          ? await options.requireApiUserSession(c)
          : toAuthSession(await requireApiAuthSession(c.req));
      } catch (error) {
        return toAuthErrorResponse(c, error);
      }
    }
    return await withAdminError(c, async () => {
      const body = await readJson<Partial<RallarCrdtCatchUpRequestEnvelope>>(
        c,
      );
      const document = readDocument(body);
      if (session && options.authorizeCatchUp) {
        const decision = await options.authorizeCatchUp({ document, session });
        if (!decision.allowed) {
          throw forbidden('CRDT catch-up authorization required.');
        }
      }
      return await readCrdtCatchUpResponse(options, body, document);
    });
  });

  app.post('/api/crdt/admin/documents/list', (c) =>
    withAdminError(
      c,
      async () =>
        await options.repository.listDocuments(
          await readJson<RallarCrdtListDocumentsInput>(c),
        ),
    ));

  app.post('/api/crdt/admin/documents/integrity', (c) =>
    withAdminError(
      c,
      async () =>
        await options.repository.verifyIntegrity(
          readDocument(await readJson(c)),
        ),
    ));

  app.post('/api/crdt/admin/documents/debug-export', (c) =>
    withAdminError(c, async () => {
      const body = await readJson<{
        document?: RallarCrdtDocumentRef;
        reason?: string;
        redactPayloads?: boolean;
      }>(c);
      return await options.repository.exportDebugBundle(
        readDocument(body),
        {
          reason: body.reason ?? 'api-v1-admin-export',
          redaction: body.redactPayloads === false ? { payloadsRedacted: false } : {
            payloadsRedacted: true,
            reason: 'api-v1-admin-redaction',
          },
        },
      );
    }));

  app.post('/api/crdt/admin/documents/backup-export', (c) =>
    withAdminError(
      c,
      async () =>
        await options.repository.exportBackupBundle(
          readDocument(await readJson(c)),
        ),
    ));

  app.post(
    '/api/crdt/admin/documents/rebuild-projection',
    (c) =>
      withAdminError(c, async () => {
        return await mutate(c, options, 'rebuild-projection', await readJson(c));
      }),
  );

  app.post('/api/crdt/admin/documents/compact', (c) =>
    withAdminError(c, async () => {
      return await mutate(c, options, 'compact', await readJson(c));
    }));

  app.post('/api/crdt/admin/documents/lifecycle', (c) =>
    withAdminError(
      c,
      async () => await mutate(c, options, 'lifecycle', await readJson(c)),
    ));

  app.post('/api/crdt/admin/documents/erase', (c) =>
    withAdminError(c, async () => {
      return await mutate(c, options, 'erase', await readJson(c));
    }));
}

async function mutate(
  context: Context,
  options: RallarCrdtAdminRoutesOptions,
  operation: RallarCrdtAdminMutationOperation,
  request: unknown,
): Promise<unknown> {
  if (!options.mutations) {
    throw new Error('CRDT AppInbox mutations are not configured.');
  }
  const adminSession = await requireCrdtAdminSession(context, options);
  return await options.mutations.processAdminMutationUntilCompletion(
    operation,
    { adminSession, request },
  );
}

function forbidden(message: string): Error {
  return Object.assign(new Error(`Forbidden: ${message}`), { status: 403 });
}

async function withAdminError(
  c: Context,
  execute: () => Promise<unknown>,
): Promise<Response> {
  try {
    const result = await execute();
    return c.json({ ok: true, result });
  } catch (error) {
    const status = readErrorStatus(error);
    return c.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      },
      status,
    );
  }
}

async function requireCrdtAdminSession(
  c: Context,
  options: RallarCrdtAdminRoutesOptions,
): Promise<AuthSession> {
  const session = options.requireApiAdminSession
    ? await options.requireApiAdminSession(c)
    : await requireApiAuthSession(c.req);
  const authorized = options.authorizeAdmin !== undefined
    ? await Promise.resolve(
      options.authorizeAdmin({
        session,
        context: c,
      }),
    )
    : options.adminClientIds !== undefined
    ? options.adminClientIds.includes(session.clientId)
    : true;

  if (!authorized) {
    throw Object.assign(new Error('Forbidden: CRDT admin authorization required.'), {
      status: 403,
    });
  }

  return session;
}

function readErrorStatus(error: unknown): 400 | 401 | 403 | 404 | 409 | 429 | 503 {
  if (!error || typeof error !== 'object' || !('status' in error)) return 400;
  const status = Number((error as { status: unknown }).status);
  return [400, 401, 403, 404, 409, 429, 503].includes(status)
    ? status as 400 | 401 | 403 | 404 | 409 | 429 | 503
    : 400;
}

async function readJson<T>(c: Context): Promise<T> {
  try {
    return (await c.req.json()) as T;
  } catch {
    return {} as T;
  }
}

function readDocument(input: unknown): RallarCrdtDocumentRef {
  const candidate = input &&
      typeof input === 'object' &&
      'document' in input &&
      (input as { document?: unknown }).document
    ? (input as { document?: unknown }).document
    : input;

  if (!candidate || typeof candidate !== 'object') {
    throw new Error('CRDT admin request requires a document ref.');
  }

  return candidate as RallarCrdtDocumentRef;
}

async function readCrdtCatchUpResponse(
  options: RallarCrdtAdminRoutesOptions,
  body: Partial<RallarCrdtCatchUpRequestEnvelope>,
  document: RallarCrdtDocumentRef,
): Promise<RallarCrdtCatchUpResponseEnvelope> {
  const page = await options.repository.listAfter({
    document,
    afterSequence: body.afterSequence,
    afterCursor: body.afterCursor,
    limit: body.maxUpdateCount,
  });
  const snapshot = body.includeSnapshot === false
    ? undefined
    : await options.repository.readSnapshot(document);
  return {
    protocolVersion: RALLAR_CRDT_PROTOCOL_VERSION,
    requestId: body.requestId ?? crypto.randomUUID(),
    document,
    createdAtEpochMs: options.now?.() ?? Date.now(),
    snapshot,
    page,
  };
}
