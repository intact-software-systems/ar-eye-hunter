import { ROOM_GUEST_LIFETIME_MS, toRoomGuestInvitation } from '@shared/api/room-guests/invitation.ts';
import { ROOM_LOBBY_METADATA_KEY } from '@shared/api/room-lobbies/room-lobby-policy.ts';
import { ROOM_LOBBY_REGISTRATION_METADATA_KEY } from '@shared/api/room-lobbies/room-lobby-registration.ts';
import { GROUP_DIRECTORY_LISTING_METADATA_KEY } from '@shared/api/group-directory/group-directory-listing.ts';
import { createDefaultGroupLifecyclePolicy } from '@shared/api/group-lifecycle/group-lifecycle-policy-presets.ts';
import type { GroupLifecyclePolicy } from '@shared/api/group-lifecycle/group-lifecycle-policy.ts';
import { toGroupMemberPolicy } from '@shared/api/group-lifecycle/to-normalized-group-lifecycle-policy.ts';
import { validateGroupLifecyclePolicy } from '@shared/api/group-lifecycle/validate-group-lifecycle-policy.ts';
import { readGroupRetentionState } from '@shared/api/group-retention.ts';
import { readGroupSessionSchedule } from '@shared/api/group-sessions/group-session-schedule.ts';
import type {
    AuditStamp,
    Group,
    GroupMember,
    GroupPresenceSummary
} from '@shared/api/group-types.ts';

import { computeFormationTimerEntries } from '../../formation-timer-outbox-entry.ts';
import { toExpiredAwareInsertCandidate } from '../../presence/group-expired-state-authority.ts';
import {
    nextInitialGroupSnapshotVersion,
    toInitialGroupPresenceSummaryCandidate
} from '../../presence/group-initial-presence-summary.ts';
import type {
    GroupMutationCommand,
    GroupMutationComputed,
    GroupMutationFacts,
    GroupMutationRead,
    GroupPublicationGrantEffect
} from '../group-mutation-contracts.ts';
import {
    auditStamp,
    computeGroupMutationWriteResult,
    rejected
} from '../group-mutation-result.ts';

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
    const lifecyclePolicy = resolveCreateGroupLifecyclePolicy(command);
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
        metadata: {
            ...structuredClone(command.input.metadata),
            ...(command.input.directoryListing === undefined
                ? {}
                : { [GROUP_DIRECTORY_LISTING_METADATA_KEY]: command.input.directoryListing })
        },
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
        ...(command.input.temporaryCreator && { temporaryPlayerRoom: true, guestInvitation: toRoomGuestInvitation(command.input.temporaryCreator.invitationVerifier, audit.atEpochMs) }),
        expiresAtEpochMs: command.input.temporaryCreator ? audit.atEpochMs + command.input.temporaryCreator.lifetimeMs : command.input.expiresAtEpochMs,
        emptySinceEpochMs: null,
        purgeAfterEpochMs: command.input.purgeAfterEpochMs,
        lifecycleState: lifecyclePolicy.formation === 'phased' ? 'forming' : 'active',
        formationEpoch: 0,
        formationAttemptCount: 0,
        lastFormationOutcome: null,
        establishmentStartedAtEpochMs: null,
        formationElectorate: [command.input.createdByPrincipalId],
        acceptedLayoutIdentity: null,
        transportState: 'flowing',
        memberPolicy: toGroupMemberPolicy(lifecyclePolicy),
        // No layout carries traffic or is being dialed yet, so there is no
        // coverage to report and nothing for the status writer to confirm.
        activationStatus: null
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
        ...(command.input.temporaryCreator && { guestLease: {
            temporaryManager: true, admittedAtEpochMs: audit.atEpochMs, expiresAtEpochMs: audit.atEpochMs + ROOM_GUEST_LIFETIME_MS
        } }),
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

/**
 * D494: the creator's declared grant, written in the create batch. A row surviving an expired incarnation is
 * rewritten, or deleted for an empty declaration, so the creator never inherits the old incarnation's rights.
 */
function createInitialPublicationGrantEffects(
    command: Extract<GroupMutationCommand, { operation: 'createGroup'; }>,
    read: GroupMutationRead,
    audit: AuditStamp
): readonly GroupPublicationGrantEffect[] {
    const surviving = read.targetPublicationGrant;
    const topics = command.input.publicationGrants;
    const value = {
        ...command.aggregateRef,
        principalId: command.input.createdByPrincipalId,
        topics: structuredClone(topics),
        updated: audit
    };
    if (Object.keys(topics).length === 0) {
        return surviving === null
            ? []
            : [{ operation: 'delete', value: surviving.value, expectedRevision: surviving.entry.revision }];
    }
    return surviving === null
        ? [{ operation: 'insert', value }]
        : [{ operation: 'update', value, expectedRevision: surviving.entry.revision }];
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

/** The policy a group is created under: the request's, or the default preset when the request carries none. */
export function resolveCreateGroupLifecyclePolicy(
    command: Extract<GroupMutationCommand, { operation: 'createGroup'; }>
): GroupLifecyclePolicy {
    return command.input.lifecyclePolicy ?? createDefaultGroupLifecyclePolicy();
}

interface ComputeCreateInput {
    readonly command: Extract<GroupMutationCommand, { operation: 'createGroup' }>;
    readonly read: GroupMutationRead;
    readonly facts: GroupMutationFacts;
    readonly eventBinding?: Group['eventRoom'];
}

export function computeCreate({ command, read, facts, eventBinding }: ComputeCreateInput): GroupMutationComputed {
    const denial = toCreateDenial(command, read, facts);
    if (denial !== null) {
        return rejected({ command, read, facts, ...denial });
    }
    const audit = auditStamp(command, facts, command.input.createdByPrincipalId);
    const snapshotVersion = nextInitialGroupSnapshotVersion(
        read.expiredGroupEntry,
        read.presenceSummary
    );
    const initial = { ...createInitialGroup({ command, audit, snapshotVersion }), ...(eventBinding && { eventRoom: eventBinding }) };
    const capacity = initial.maxMembers ?? facts.capacity.defaultMaxMembers;
    const eligible = initial.kind === 'room' && capacity !== null && capacity > 0;
    const policy = command.input.roomLobby === undefined && eligible ? facts.lobbyDefault : command.input.roomLobby;
    if (policy && !eligible) {
        return rejected({ command, read, facts, rejectionCode: 'group-mutation-rejected', message: 'A lobby requires a room with finite player capacity.' });
    }
    const group = policy ? { ...initial, maxMembers: capacity, metadata: { ...initial.metadata, [ROOM_LOBBY_METADATA_KEY]: { ...policy }, [ROOM_LOBBY_REGISTRATION_METADATA_KEY]: { revision: 0, atEpochMs: null } } } : initial;
    const owner = createInitialOwner(command, audit);
    const summary = createInitialPresenceSummary({ command, read, facts, snapshotVersion });
    return computeGroupMutationWriteResult({
        command,
        read,
        facts,
        guard: {
            kind: 'group',
            ...toExpiredAwareInsertCandidate(read.expiredGroupEntry, group)
        },
        members: [owner],
        initialPresenceSummary: toInitialGroupPresenceSummaryCandidate(summary, read.presenceSummary),
        presenceAdmission: null,
        eventType: 'group-created',
        lifecyclePolicy: resolveCreateGroupLifecyclePolicy(command),
        publicationGrantEffects: createInitialPublicationGrantEffects(command, read, audit),
        subscriptionEffects: [],
        subscriptionOutcome: null,
        presenceSummaryWork: 'enqueue',
        extraOutboxEntries: computeFormationTimerEntries({
            command,
            previous: null,
            next: group,
            policy: resolveCreateGroupLifecyclePolicy(command),
            facts
        })
    });
}

interface GroupCreateDenial {
    readonly rejectionCode: 'group-mutation-rejected' | 'group-already-exists' | 'group-retired';
    readonly message: string;
}

function toCreateDenial(
    command: Extract<GroupMutationCommand, { operation: 'createGroup'; }>,
    read: GroupMutationRead,
    facts: GroupMutationFacts
): GroupCreateDenial | null {
    if (!command.input.temporaryCreator && command.input.actorPrincipalId !== command.input.createdByPrincipalId) {
        return {
            rejectionCode: 'group-mutation-rejected',
            message: 'Creator authority does not match createdByPrincipalId'
        };
    }
    if (read.retiredGroup !== null) {
        return {
            rejectionCode: 'group-retired',
            message: `Group identity is permanently retired: ${command.aggregateRef.groupId}`
        };
    }
    if (read.group) {
        return {
            rejectionCode: 'group-already-exists',
            message: `Group already exists: ${command.aggregateRef.groupId}`
        };
    }
    const schedule = readGroupSessionSchedule(command.input.metadata);
    if (
        schedule !== null && (
            schedule.startsAtEpochMs <= facts.attemptAtEpochMs || schedule.revision !== 1 ||
            schedule.cancelledAtEpochMs !== null || command.input.kind !== 'room' ||
            command.input.maxMembers === null || command.input.maxMembers > 64 ||
            readGroupRetentionState(command.input.metadata) === null
        )
    ) {
        return {
            rejectionCode: 'group-mutation-rejected',
            message: 'Scheduled creation requires a future start, initial schedule and bounded temporary room.'
        };
    }
    const policyIssues = command.input.lifecyclePolicy === undefined
        ? []
        : (validateGroupLifecyclePolicy(command.input.lifecyclePolicy).left ?? []);
    if (policyIssues.length > 0) {
        return {
            rejectionCode: 'group-mutation-rejected',
            message: `Group lifecycle policy is not coherent: ${
                policyIssues
                    .map((issue) => `${issue.field} ${issue.code}`)
                    .join('; ')
            }`
        };
    }
    return null;
}
