import { GROUP_RETENTION_METADATA_KEY, readGroupRetentionState } from '@shared/api/group-retention.ts';
import type { AuditStamp, Group } from '@shared/api/group-types.ts';
import { computeEmptyGroupLifetime, type GroupRetentionObservation } from './compute-empty-group-lifetime.ts';
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
    if (group.status === 'archived' && policy !== null) {
        return computeArchivedGroupRetention(read, group);
    }
    if (group.status !== 'active' || policy === null) {
        return noChange(read, group);
    }
    const lifetime = computeEmptyGroupLifetime(read.authority, policy, read.attemptAtEpochMs);
    if (lifetime !== 'expired') {
        return lifetime.atEpochMs === group.emptySinceEpochMs && policy.emptyPresenceFingerprint === lifetime.fingerprint
            ? noChange(read, group)
            : computeGroupRetentionWrite(read, updateObservation(read, group, lifetime));
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

function computeArchivedGroupRetention(
    read: GroupRetentionService.Read,
    group: Extract<Group, { status: 'archived'; }>
): GroupRetentionService.Computed {
    if (
        group.archived === null || !Number.isSafeInteger(group.archived.atEpochMs) || group.archived.atEpochMs < 0
    ) {
        throw new TypeError('Archived temporary room requires a valid archival timestamp');
    }
    return read.attemptAtEpochMs - group.archived.atEpochMs >= 604800000
        ? computeGroupRetentionWrite(read, {
            ...group,
            status: 'deleted',
            deleted: retentionAudit(read),
            snapshotVersion: group.snapshotVersion + 1,
            updated: retentionAudit(read)
        })
        : noChange(read, group);
}

function noChange(read: GroupRetentionService.Read, group: Group): GroupRetentionService.Computed {
    return { outcome: 'no-op', receipt: toGroupRetentionReceipt(read, { group, outcome: 'no-op', outboxIds: [] }) };
}

function updateObservation(
    read: GroupRetentionService.Read,
    group: Group,
    observation: GroupRetentionObservation
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
        traceId: read.traceId,
        requestId: read.ingress.command.requestId
    };
}
