import { GROUP_RETENTION_METADATA_KEY, readGroupRetentionState } from '@shared/api/group-retention.ts';
import type { AuditStamp, Group } from '@shared/api/group-types.ts';

import { computeMutationCommandDigest, encodeJsonWireValue } from '../../protocol/json-wire-identity.ts';
import { computeGroupPresenceSummaryContent } from '../presence/compute-group-presence-summary.ts';
import { computeGroupRetentionWrite, toGroupRetentionReceipt } from './compute-group-retention-write.ts';
import type { GroupRetentionService } from './group-retention-service.ts';

export function computeGroupRetention(read: GroupRetentionService.Read): GroupRetentionService.Computed {
    if (read.idempotency !== null) {
        return { outcome: 'replay', receipt: read.idempotency.receipt };
    }
    const stored = read.authority.group;
    if (stored === undefined) {
        return { outcome: 'absent', receipt: null };
    }
    const group = stored.value;
    const policy = readGroupRetentionState(group.metadata);
    if (group.status !== 'active' || policy === null) {
        return noChange(read, group);
    }
    const live = computeGroupPresenceSummaryContent({
        ...read.authority,
        group: stored,
        current: read.authority.current ?? null
    }, read.attemptAtEpochMs).activeSessionCount > 0;
    if (live) {
        return group.emptySinceEpochMs === null
            ? noChange(read, group)
            : computeGroupRetentionWrite(read, updateObservation(read, group, { atEpochMs: null, fingerprint: null }));
    }
    const fingerprint = computePresenceFingerprint(read);
    if (group.emptySinceEpochMs === null || policy.emptyPresenceFingerprint !== fingerprint) {
        return computeGroupRetentionWrite(
            read,
            updateObservation(read, group, {
                atEpochMs: Math.max(read.attemptAtEpochMs, group.emptySinceEpochMs ?? 0),
                fingerprint
            })
        );
    }
    if (read.attemptAtEpochMs - group.emptySinceEpochMs < policy.reconnectGraceMs) {
        return noChange(read, group);
    }
    const audit = retentionAudit(read);
    return computeGroupRetentionWrite(read, {
        ...group,
        status: 'archived',
        archived: audit,
        deleted: null,
        snapshotVersion: group.snapshotVersion + 1,
        metadataVersion: group.metadataVersion + 1,
        updated: audit
    });
}

function noChange(read: GroupRetentionService.Read, group: Group): GroupRetentionService.Computed {
    return { outcome: 'no-op', receipt: toGroupRetentionReceipt(read, { group, outcome: 'no-op', outboxIds: [] }) };
}

function computePresenceFingerprint(read: GroupRetentionService.Read): string {
    const authority = read.authority;
    const observations = [authority.members, authority.admissions, authority.presenceSessions].map((rows) =>
        rows.map(({ entry }) => ({ key: entry.key, revision: entry.revision }))
            .toSorted((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0)
    );
    return computeMutationCommandDigest(encodeJsonWireValue(observations));
}

function updateObservation(
    read: GroupRetentionService.Read,
    group: Group,
    observation: Readonly<{ atEpochMs: number | null; fingerprint: string | null; }>
): Group {
    const policy = readGroupRetentionState(group.metadata);
    if (policy === null) {
        throw new TypeError('Retention observation requires temporary policy');
    }
    return {
        ...group,
        emptySinceEpochMs: observation.atEpochMs,
        metadata: {
            ...group.metadata,
            [GROUP_RETENTION_METADATA_KEY]: { ...policy, emptyPresenceFingerprint: observation.fingerprint }
        },
        snapshotVersion: group.snapshotVersion + 1,
        metadataVersion: group.metadataVersion + 1,
        updated: retentionAudit(read)
    };
}

function retentionAudit(read: GroupRetentionService.Read): AuditStamp {
    return {
        atEpochMs: read.attemptAtEpochMs,
        actor: { kind: 'service', serviceId: read.ingress.serviceId },
        reason: 'temporary-room-retention',
        traceId: null,
        requestId: read.ingress.command.requestId
    };
}
