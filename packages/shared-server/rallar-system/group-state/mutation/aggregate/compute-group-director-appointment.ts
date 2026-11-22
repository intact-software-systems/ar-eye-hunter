import { readRoomDirectorSuccession } from '@shared/api/room-directors/room-director-succession-record.ts';
import { changeRoomDirectorSuccession } from '@shared/api/room-directors/change-room-director-succession.ts';
import { createRallarGroupDirectorAppointment, mergeRallarGroupDirectorMetadata, readRallarGroupDirectorFromSnapshot, resolveRallarGroupDirectorAppointmentEligibility } from '@shared/api/group-director.ts';
import type { Group } from '@shared/api/group-types.ts';
import { canMutateActiveGroup } from '../../policy/group-lifecycle-policy.ts';
import type { GroupMutationCommand, GroupMutationComputed, GroupMutationFacts, GroupMutationRead } from '../group-mutation-contracts.ts';
import { auditStamp, rejected, rejectedByGroupPolicy, requireGroup } from '../group-mutation-result.ts';
import { groupWrite } from './compute-group-aggregate-mutation.ts';
import { toPolicySnapshot } from './group-aggregate-mutation-policy.ts';

export function computeGroupDirectorAppointment(
    command: Extract<GroupMutationCommand, { operation: 'appointDirector'; }>,
    read: GroupMutationRead,
    facts: GroupMutationFacts
): GroupMutationComputed {
    const stored = requireGroup(read, command.aggregateRef);
    const active = canMutateActiveGroup({ group: stored.value, nowEpochMs: facts.attemptAtEpochMs });
    if (!active.allowed) {
        return rejectedByGroupPolicy({ command, read, facts, denial: active });
    }
    const principalId = command.input.actorPrincipalId;
    const sessionId = command.input.actorSessionId;
    if (!principalId || !sessionId) {
        return rejected({
            command,
            read,
            facts,
            rejectionCode: 'group-mutation-rejected',
            message: 'Forbidden: Cannot appoint a director without a local session.'
        });
    }
    const snapshot = toPolicySnapshot(read, command.aggregateRef, facts.attemptAtEpochMs);
    if (command.input.succession) {
        const result = changeRoomDirectorSuccession({
            snapshot, actor: { principalId, sessionId }, command: command.input.succession, nowEpochMs: facts.attemptAtEpochMs
        });
        if ('rejectionCode' in result) return rejected({ command, read, facts, ...result });
        const group: Group = {
            ...stored.value, metadata: result.metadata, snapshotVersion: stored.value.snapshotVersion + 1,
            metadataVersion: stored.value.metadataVersion + 1, updated: auditStamp(command, facts, principalId)
        };
        return groupWrite({ command, read, facts, group, eventType: 'group-updated' });
    }
    if (readRoomDirectorSuccession(stored.value.metadata)) {
        return rejected({ command, read, facts, rejectionCode: 'group-mutation-rejected',
            message: 'This room requires an epoch-fenced director succession command.' });
    }
    const eligibility = resolveRallarGroupDirectorAppointmentEligibility({
        snapshot,
        principalId,
        sessionId
    });
    if (!eligibility.allowed) {
        return rejected({
            command,
            read,
            facts,
            rejectionCode: 'group-mutation-rejected',
            message: `Forbidden: ${eligibility.reason ?? 'Cannot appoint the browser director.'}`
        });
    }
    const appointment = createRallarGroupDirectorAppointment({
        session: { clientId: principalId, sessionId },
        previous: readRallarGroupDirectorFromSnapshot(snapshot),
        now: facts.attemptAtEpochMs,
        heartbeatTtlMs: command.input.heartbeatTtlMs
    });
    const next: Group = {
        ...stored.value,
        metadata: mergeRallarGroupDirectorMetadata(stored.value.metadata, appointment),
        snapshotVersion: stored.value.snapshotVersion + 1,
        metadataVersion: stored.value.metadataVersion + 1,
        updated: auditStamp(command, facts, principalId)
    };
    return groupWrite({ command, read, facts, group: next, eventType: 'group-updated' });
}
