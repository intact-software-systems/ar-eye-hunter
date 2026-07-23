import {
  createRallarCrdtDebugBundle,
  createRallarCrdtErasureAuditEvent,
  hashRallarCrdtUpdateEnvelope,
  type RallarCrdtDocumentMetadata,
  verifyRallarCrdtDebugBundle,
} from '@shared/crdt/mod.ts';
import type {
  CrdtAppendCommand,
  CrdtCanonicalSnapshotEnvelope,
  CrdtMutationCommand,
  CrdtMutationRead,
  CrdtMutationResult,
} from './crdt-mutation-contracts.ts';

export function toCrdtMutationResult(
  command: CrdtMutationCommand,
  status: CrdtMutationResult['status'],
  document: RallarCrdtDocumentMetadata | null,
  appendSequence: number | null,
  code: string | null,
  details: Record<string, unknown>,
): CrdtMutationResult {
  return {
    version: 1,
    operation: command.operation,
    status,
    commandId: command.commandId,
    documentKey: command.documentKey,
    documentRevision: document?.documentRevision ?? null,
    appendSequence,
    code,
    ...details,
  } as CrdtMutationResult;
}

export function toAcceptedAdminResultDetails(
  command: Exclude<CrdtMutationCommand, CrdtAppendCommand>,
  read: CrdtMutationRead,
  document: RallarCrdtDocumentMetadata,
  snapshot: CrdtCanonicalSnapshotEnvelope | null,
): Record<string, unknown> {
  if (command.operation === 'compact') {
    if (!snapshot) throw new TypeError('Accepted CRDT compaction requires a snapshot');
    return { snapshot, metadata: document };
  }
  if (command.operation === 'lifecycle') return { metadata: document };
  const bundle = createRallarCrdtDebugBundle({
    exportedAtEpochMs: command.capturedAtEpochMs,
    reason: command.operation === 'erase' ? command.reason : `rebuild:${command.projectionId}`,
    document: command.document,
    metadata: document,
    ...(read.snapshot ? { snapshot: read.snapshot } : {}),
    records: read.records,
    ...(command.operation === 'erase' && command.mode === 'redact-payloads'
      ? { redaction: { payloadsRedacted: true, reason: command.reason } }
      : {}),
  });
  if (command.operation === 'rebuild-projection') {
    return { integrity: verifyRallarCrdtDebugBundle(bundle), metadata: document };
  }
  const request = {
    document: command.document,
    requestedAtEpochMs: command.capturedAtEpochMs,
    requestedBy: command.actor.principalId,
    reason: command.reason,
    mode: command.mode,
  } as const;
  return {
    request,
    auditEvent: createRallarCrdtErasureAuditEvent(request),
    metadata: document,
    redactedBundle: command.mode === 'redact-payloads' ? bundle : null,
  };
}

export function toRejectedAdminResultDetails(
  command: Exclude<CrdtMutationCommand, CrdtAppendCommand>,
): Record<string, unknown> {
  if (command.operation === 'compact') return { snapshot: null, metadata: null };
  if (command.operation === 'lifecycle') return { metadata: null };
  if (command.operation === 'rebuild-projection') return { integrity: null, metadata: null };
  return { request: null, auditEvent: null, metadata: null, redactedBundle: null };
}

export function toFallbackReplayAppend(
  command: CrdtAppendCommand,
  document: RallarCrdtDocumentMetadata | null,
) {
  return {
    appendSequence: document?.lastAppendSequence ?? 0,
    acceptedAtEpochMs: command.capturedAtEpochMs,
    actorId: command.actor.actorId,
    principalId: command.actor.principalId,
    sessionId: command.actor.sessionId,
    serverId: command.actor.serverId,
    authorizationScope: command.authorizationScope,
    acceptedUpdateHash: hashRallarCrdtUpdateEnvelope(command.update),
  } as const;
}
