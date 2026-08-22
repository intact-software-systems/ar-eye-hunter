import type { AuditStamp, Group, GroupMember, GroupPresenceSummary } from '@shared/api/group-types.ts';

import type { GroupMutationCommand, GroupMutationFacts, GroupMutationRead } from '../group-mutation-contracts.ts';

interface CreateInitialGroupInput {
    readonly command: Extract<GroupMutationCommand, { operation: 'createGroup'; }>;
    readonly audit: AuditStamp;
    readonly snapshotVersion: number;
}

export function createInitialGroup({
    command,
    audit,
    snapshotVersion
}: CreateInitialGroupInput): Group {
    return {
        ...command.aggregateRef,
        slug: command.input.slug,
        displayName: command.input.displayName,
        description: command.input.description,
        kind: command.input.kind,
        status: 'active',
        joinMode: command.input.joinMode,
        maxMembers: command.input.maxMembers,
        maxSessionsPerMember: command.input.maxSessionsPerMember,
        metadata: Object.fromEntries(Object.entries(command.input.metadata)),
        activeMemberCount: 1,
        ownerPrincipalId: command.input.createdByPrincipalId,
        snapshotVersion,
        metadataVersion: 1,
        rosterVersion: 1,
        presenceVersion: 0,
        created: audit,
        updated: audit,
        archived: null,
        deleted: null,
        expiresAtEpochMs: command.input.expiresAtEpochMs,
        emptySinceEpochMs: null,
        purgeAfterEpochMs: command.input.purgeAfterEpochMs,
        lifecycleState: command.input.lifecyclePolicy?.formation === 'phased' ? 'forming' : 'active',
        formationEpoch: 0,
        formationAttemptCount: 0,
        lastFormationOutcome: null,
        establishmentStartedAtEpochMs: null,
        formationElectorate: [command.input.createdByPrincipalId]
    };
}

export function createInitialOwner(
    command: Extract<GroupMutationCommand, { operation: 'createGroup'; }>,
    audit: AuditStamp
): GroupMember {
    return {
        ...command.aggregateRef,
        principalId: command.input.createdByPrincipalId,
        role: 'owner',
        status: 'active',
        joined: audit,
        updated: audit,
        left: null,
        removed: null,
        banned: null,
        invitedByPrincipalId: null,
        invitationExpiresAtEpochMs: null
    };
}

interface CreateInitialPresenceSummaryInput {
    readonly command: Extract<GroupMutationCommand, { operation: 'createGroup'; }>;
    readonly read: GroupMutationRead;
    readonly facts: GroupMutationFacts;
    readonly snapshotVersion: number;
}

export function createInitialPresenceSummary({
    command,
    read,
    facts,
    snapshotVersion
}: CreateInitialPresenceSummaryInput): GroupPresenceSummary {
    return {
        ...command.aggregateRef,
        causalRevision: {
            groupRevision: snapshotVersion,
            presenceRevision: read.presenceSummary?.value.causalRevision.presenceRevision ?? 0
        },
        activePrincipalIds: [],
        activeSessionIds: [],
        activeSessions: [],
        activePrincipalCount: 0,
        activeSessionCount: 0,
        computedAtEpochMs: facts.nowEpochMs
    };
}
