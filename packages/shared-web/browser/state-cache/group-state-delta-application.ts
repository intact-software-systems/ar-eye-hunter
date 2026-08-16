import { validateAuthoritativeGroupSnapshot } from '@shared/api/authoritative-state-validation.ts';
import {
  compareGroupCausalRevision,
  toGroupSnapshotStateRevision,
} from '@shared/api/group-client-views.ts';
import {
  type GroupStateDeltaEnvelope,
  validateGroupStateDeltaEnvelope,
} from '@shared/api/group-state-delta.ts';
import type {
  GroupMember,
  GroupPresenceSession,
  GroupSnapshot,
} from '@shared/api/group-types.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import * as groupStateSnapshotsRepository
  from '@shared/repository/group-state-snapshots-repository.ts';
import { StateSnapshotRevisionConflictError } from '@shared/repository/state-snapshot-revision.ts';
import { Either } from '@shared/resilience/Either.ts';

import { emitBrowserStateReadDiagnostic } from '../state-read/diagnostics.ts';
import { readStateGroupSnapshot } from '../state-read/point-read.ts';
import { acceptGroupStateSnapshotsOrRecompute } from './state-cache-snapshot-adoption.ts';

export type GroupStateDeltaApplication =
  | 'applied'
  | 'no-op'
  | 'gap-pull'
  | 'revision-conflict';

export type GroupStateDeltaMaterializationGap =
  | 'missing-session-record'
  | 'inconsistent-materialization';

export type RereadGroupSnapshots = (
  scope: StateScope,
) => Promise<readonly GroupSnapshot[]>;

/**
 * Decodes a `group-state.event` WS payload into its delta envelope. Any other
 * shape yields undefined and the cache layer ignores the row. Servers no longer
 * emit the bare GroupEvent payload, but a row written by an older server can
 * still be in flight across a rolling deploy.
 */
export function toGroupStateDeltaEnvelope(
  serialized: string,
  scope: StateScope,
): GroupStateDeltaEnvelope | undefined {
  try {
    const value: unknown = JSON.parse(serialized);
    validateGroupStateDeltaEnvelope(value, scope);
    return value;
  } catch {
    return undefined;
  }
}

export async function acceptGroupStateDeltaEnvelope(
  envelope: GroupStateDeltaEnvelope,
  scope: StateScope,
  rereadGroupSnapshots?: RereadGroupSnapshots,
): Promise<GroupStateDeltaApplication> {
  const startedAtMs = performance.now();
  const cached = groupStateSnapshotsRepository.findGroupStateSnapshotByRef(envelope.group);
  const disposition = resolveGroupStateDeltaDisposition(cached, envelope);
  if (disposition === 'no-op') {
    return emitGroupStateDeltaDiagnostic('no-op', startedAtMs);
  }
  if (disposition === 'apply' && cached !== undefined) {
    const materialized = toGroupSnapshotFromDeltaEnvelope(cached, envelope);
    if (materialized.right !== undefined) {
      const adoption = await adoptMaterializedGroupSnapshot(
        materialized.right,
        scope,
        rereadGroupSnapshots,
      );
      if (adoption === 'adopted') {
        return emitGroupStateDeltaDiagnostic('applied', startedAtMs);
      }
      await readGroupSnapshotAtDeltaFloor(envelope, scope, rereadGroupSnapshots);
      return emitGroupStateDeltaDiagnostic('revision-conflict', startedAtMs);
    }
  }
  await readGroupSnapshotAtDeltaFloor(envelope, scope, rereadGroupSnapshots);
  return emitGroupStateDeltaDiagnostic('gap-pull', startedAtMs);
}

/**
 * Materializes the resulting snapshot a delta describes on top of the cached
 * predecessor snapshot. Members are the cached roster merged with the affected
 * slice and re-sorted into the server's canonical member order; active
 * sessions follow the envelope's identity-set order, taking each record from
 * the affected slice first and the cached snapshot otherwise. A session id
 * without a record in either source is a causal gap, not an error.
 */
export function toGroupSnapshotFromDeltaEnvelope(
  cached: GroupSnapshot,
  envelope: GroupStateDeltaEnvelope,
): Either<GroupStateDeltaMaterializationGap, GroupSnapshot> {
  const activeSessions = toDeltaActiveSessions(cached, envelope);
  if (activeSessions === undefined) {
    return Either.ofLeft('missing-session-record');
  }
  const resulting = envelope.resultingCausalRevision;
  const snapshot: GroupSnapshot = {
    stateRevision: toGroupSnapshotStateRevision(
      resulting.groupRevision,
      resulting.presenceRevision,
    ),
    causalRevision: resulting,
    group: envelope.group,
    members: toDeltaMembers(cached.members, envelope.members),
    activeSessions,
    memberCount: envelope.memberCount,
    onlineMemberCount: envelope.onlineMemberCount,
  };
  return isAuthoritativeGroupSnapshot(snapshot, envelope.group)
    ? Either.ofRight(snapshot)
    : Either.ofLeft('inconsistent-materialization');
}

/**
 * D2 application order: the no-op rule is evaluated before the apply rule, so
 * a summary no-op envelope (predecessor === resulting) resolves as a no-op at
 * the cached tuple instead of reaching the apply path.
 */
function resolveGroupStateDeltaDisposition(
  cached: GroupSnapshot | undefined,
  envelope: GroupStateDeltaEnvelope,
): 'no-op' | 'apply' | 'causal-gap' {
  if (cached === undefined) {
    return 'causal-gap';
  }
  const againstResulting = compareGroupCausalRevision(
    cached.causalRevision,
    envelope.resultingCausalRevision,
  );
  if (againstResulting === 'equal' || againstResulting === 'dominates') {
    return 'no-op';
  }
  const againstPredecessor = compareGroupCausalRevision(
    cached.causalRevision,
    envelope.predecessorCausalRevision,
  );
  return againstPredecessor === 'equal' ? 'apply' : 'causal-gap';
}

/**
 * Dual-emit divergence oracle: a materialized snapshot that disagrees with an
 * equal-tuple server snapshot throws StateSnapshotRevisionConflictError from
 * the shared revision decide. The conflict is a countable outcome that
 * self-heals through the floored pull — it never escapes into the inbox
 * runtime.
 */
async function adoptMaterializedGroupSnapshot(
  snapshot: GroupSnapshot,
  scope: StateScope,
  rereadGroupSnapshots?: RereadGroupSnapshots,
): Promise<'adopted' | 'revision-conflict'> {
  try {
    await acceptGroupStateSnapshotsOrRecompute([snapshot], scope, rereadGroupSnapshots);
    return 'adopted';
  } catch (error) {
    if (error instanceof StateSnapshotRevisionConflictError) {
      return 'revision-conflict';
    }
    throw error;
  }
}

async function readGroupSnapshotAtDeltaFloor(
  envelope: GroupStateDeltaEnvelope,
  scope: StateScope,
  rereadGroupSnapshots?: RereadGroupSnapshots,
): Promise<void> {
  try {
    const pulled = await readStateGroupSnapshot(envelope.group.groupId, scope, {
      minCausalRevision: envelope.resultingCausalRevision,
    });
    await acceptGroupStateSnapshotsOrRecompute([pulled.snapshot], scope, rereadGroupSnapshots);
  } catch {
    await rereadGroupSnapshotsAfterFailedPull(scope, rereadGroupSnapshots);
  }
}

async function rereadGroupSnapshotsAfterFailedPull(
  scope: StateScope,
  rereadGroupSnapshots?: RereadGroupSnapshots,
): Promise<void> {
  if (rereadGroupSnapshots === undefined) {
    return;
  }
  try {
    const reread = await rereadGroupSnapshots(scope);
    await acceptGroupStateSnapshotsOrRecompute(reread, scope, rereadGroupSnapshots);
  } catch {
    // Convergence falls back to the heartbeat snapshot refresh.
  }
}

function toDeltaMembers(
  cached: readonly GroupMember[],
  affected: readonly GroupMember[],
): readonly GroupMember[] {
  const merged = new Map(cached.map((member) => [member.principalId, member]));
  for (const member of affected) {
    merged.set(member.principalId, member);
  }
  return [...merged.values()].sort(compareCanonicalGroupMemberOrder);
}

/**
 * Snapshot assembly lists members in storage-key order: the runtime-state
 * store returns `member=<encodeURIComponent(principalId)>` child keys in byte
 * (collate "C") order, and encodeURIComponent emits only ASCII, so UTF-16
 * code-unit comparison of the encoded principal id reproduces the server's
 * member ordering byte-for-byte. The dual-emit equal-tuple decide throws on
 * any other ordering, so this comparator must stay aligned with the server's
 * `groupStateMemberStorageKey` encoding.
 */
function compareCanonicalGroupMemberOrder(left: GroupMember, right: GroupMember): number {
  const leftKey = encodeURIComponent(left.principalId);
  const rightKey = encodeURIComponent(right.principalId);
  if (leftKey < rightKey) {
    return -1;
  }
  return leftKey > rightKey ? 1 : 0;
}

function toDeltaActiveSessions(
  cached: GroupSnapshot,
  envelope: GroupStateDeltaEnvelope,
): readonly GroupPresenceSession[] | undefined {
  const affectedBySessionId = new Map(
    envelope.sessions.map((session) => [session.sessionId, session]),
  );
  const cachedBySessionId = new Map(
    cached.activeSessions.map((session) => [session.sessionId, session]),
  );
  const sessions: GroupPresenceSession[] = [];
  for (const sessionId of envelope.activeSessionIds) {
    const session = affectedBySessionId.get(sessionId) ?? cachedBySessionId.get(sessionId);
    if (session === undefined) {
      return undefined;
    }
    sessions.push(session);
  }
  return sessions;
}

function isAuthoritativeGroupSnapshot(snapshot: GroupSnapshot, scope: StateScope): boolean {
  try {
    validateAuthoritativeGroupSnapshot(snapshot, scope);
    return true;
  } catch {
    return false;
  }
}

function emitGroupStateDeltaDiagnostic(
  application: GroupStateDeltaApplication,
  startedAtMs: number,
): GroupStateDeltaApplication {
  emitBrowserStateReadDiagnostic({
    name: 'rallar.browser.state-read',
    feature: 'group',
    operation: 'delta-apply',
    result: application,
    durationMs: performance.now() - startedAtMs,
  });
  return application;
}
