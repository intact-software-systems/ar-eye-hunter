import { type Context, Hono } from 'jsr:@hono/hono@4.11.9';
import type {
  RallarCrdtAdminLogRepository,
  RallarCrdtAuditSink,
  RallarCrdtCatchUpRequestEnvelope,
  RallarCrdtCatchUpResponseEnvelope,
  RallarCrdtDocumentRef,
  RallarCrdtErasureRequest,
  RallarCrdtLifecycleInput,
  RallarCrdtListDocumentsInput,
  RallarCrdtSnapshotEnvelope,
} from '@shared/crdt/mod.ts';
import {
  createRallarCrdtCompactedSnapshot,
  createRallarCrdtErasureAuditEvent,
  RALLAR_CRDT_PROTOCOL_VERSION,
} from '@shared/crdt/mod.ts';
import type { PrincipalId } from '@shared/api/group-types.ts';
import type { IssuedAuthSession } from '@shared-server/rallar-system/repositories/AuthSessionRepository.ts';
import { requireApiAuthSession, toAuthErrorResponse } from '../services/request-auth-service.ts';

export type RallarCrdtAdminRoutesOptions = Readonly<{
  repository: RallarCrdtAdminLogRepository;
  audit?: RallarCrdtAuditSink;
  now?: () => number;
  requireAuth?: boolean;
  adminClientIds?: readonly string[];
  authorizeAdmin?: (
    input: Readonly<{
      session: IssuedAuthSession;
      context: Context;
    }>,
  ) => boolean | Promise<boolean>;
}>;

export function init(app: Hono, options: RallarCrdtAdminRoutesOptions): void {
  const requireAuth = options.requireAuth ?? true;

  if (requireAuth) {
    app.use('/api/crdt/catch-up', async (c, next) => {
      try {
        await requireApiAuthSession(c.req);
        await next();
      } catch (error) {
        return toAuthErrorResponse(c, error);
      }
    });
    app.use('/api/crdt/admin/*', async (c, next) => {
      try {
        await requireCrdtAdminSession(c, options);
        await next();
      } catch (error) {
        return toAuthErrorResponse(c, error);
      }
    });
  }

  app.post('/api/crdt/catch-up', (c) =>
    withAdminError(c, async () => {
      const body = await readJson<Partial<RallarCrdtCatchUpRequestEnvelope>>(
        c,
      );
      const document = readDocument(body);
      const page = await options.repository.listAfter({
        document,
        afterSequence: body.afterSequence,
        afterCursor: body.afterCursor,
        limit: body.maxUpdateCount,
      });
      const snapshot = body.includeSnapshot === false
        ? undefined
        : await options.repository.readSnapshot(document);
      const response: RallarCrdtCatchUpResponseEnvelope = {
        protocolVersion: RALLAR_CRDT_PROTOCOL_VERSION,
        requestId: body.requestId ?? crypto.randomUUID(),
        document,
        createdAtEpochMs: options.now?.() ?? Date.now(),
        snapshot,
        page,
      };
      return response;
    }));

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
        const body = await readJson<{
          document?: RallarCrdtDocumentRef;
          projectionId?: string;
        }>(c);
        return await options.repository.rebuildProjection(
          readDocument(body),
          body.projectionId,
        );
      }),
  );

  app.post('/api/crdt/admin/documents/compact', (c) =>
    withAdminError(c, async () => {
      const body = await readJson<{
        document?: RallarCrdtDocumentRef;
        reason?: string;
        snapshot?: RallarCrdtSnapshotEnvelope;
      }>(c);
      const document = readDocument(body);
      const backup = await options.repository.exportBackupBundle(document);
      if (!backup) {
        throw new Error('CRDT document does not exist.');
      }

      const reason = body.reason ?? 'api-v1-admin-compaction';
      const snapshot = body.snapshot ??
        createRallarCrdtCompactedSnapshot({
          document,
          records: backup.records,
          reason,
          now: options.now,
        });
      await options.repository.writeSnapshot({
        snapshot,
        appendSequence: backup.metadata.lastAppendSequence,
        reason,
      });

      return {
        document,
        documentKey: backup.documentKey,
        appendSequence: backup.metadata.lastAppendSequence,
        snapshot,
      };
    }));

  app.post('/api/crdt/admin/documents/lifecycle', (c) =>
    withAdminError(
      c,
      async () =>
        await options.repository.updateDocumentLifecycle(
          await readJson<RallarCrdtLifecycleInput>(c),
        ),
    ));

  app.post('/api/crdt/admin/documents/erase', (c) =>
    withAdminError(c, async () => {
      const body = await readJson<{
        document?: RallarCrdtDocumentRef;
        requestedBy?: PrincipalId;
        reason?: string;
        mode?: RallarCrdtErasureRequest['mode'];
      }>(c);
      const document = readDocument(body);
      const mode = body.mode === 'redact-payloads' ? 'redact-payloads' : 'destroy-document';
      const reason = body.reason ?? 'api-v1-admin-erasure-workflow';
      const request: RallarCrdtErasureRequest = {
        document,
        requestedAtEpochMs: options.now?.() ?? Date.now(),
        requestedBy: body.requestedBy ??
          ((c.req.header('x-client-id') ?? 'api-v1-admin') as PrincipalId),
        reason,
        mode,
      };
      const auditEvent = createRallarCrdtErasureAuditEvent(request);
      await options.audit?.record(auditEvent);

      if (mode === 'redact-payloads') {
        const redactedBundle = await options.repository.exportDebugBundle(document, {
          reason,
          redaction: {
            payloadsRedacted: true,
            reason,
          },
        });
        return {
          request,
          auditEvent,
          redactedBundle,
        };
      }

      const metadata = await options.repository.updateDocumentLifecycle({
        document,
        lifecycle: 'destroyed',
        changedAtEpochMs: request.requestedAtEpochMs,
      });

      return {
        request,
        auditEvent,
        metadata,
      };
    }));
}

async function withAdminError(
  c: Context,
  execute: () => Promise<unknown>,
): Promise<Response> {
  try {
    const result = await execute();
    return c.json({ ok: true, result });
  } catch (error) {
    return c.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      },
      400,
    );
  }
}

async function requireCrdtAdminSession(
  c: Context,
  options: RallarCrdtAdminRoutesOptions,
): Promise<IssuedAuthSession> {
  const session = await requireApiAuthSession(c.req);
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
    throw new Error('Forbidden: CRDT admin authorization required.');
  }

  return session;
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
