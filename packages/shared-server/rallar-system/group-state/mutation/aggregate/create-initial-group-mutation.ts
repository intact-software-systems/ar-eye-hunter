import { GROUP_DIRECTORY_LISTING_METADATA_KEY } from '@shared/api/group-directory/group-directory-listing.ts';
import { createDefaultGroupLifecyclePolicy } from '@shared/api/group-lifecycle/group-lifecycle-policy-presets.ts';
import type { GroupLifecyclePolicy } from '@shared/api/group-lifecycle/group-lifecycle-policy.ts';
import { toGroupMemberPolicy } from '@shared/api/group-lifecycle/to-normalized-group-lifecycle-policy.ts';
import { validateGroupLifecyclePolicy } from '@shared/api/group-lifecycle/validate-group-lifecycle-policy.ts';
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
    GroupMutationRead
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
        expiresAtEpochMs: command.input.expiresAtEpochMs,
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

/** The policy a group is created under: the request's, or the default preset when the request carries none. */
export function resolveCreateGroupLifecyclePolicy(
    command: Extract<GroupMutationCommand, { operation: 'createGroup'; }>
): GroupLifecyclePolicy {
    return command.input.lifecyclePolicy ?? createDefaultGroupLifecyclePolicy();
}

export function computeCreate(
    command: Extract<GroupMutationCommand, { operation: 'createGroup'; }>,
    read: GroupMutationRead,
    facts: GroupMutationFacts
): GroupMutationComputed {
    const denial = toCreateDenial(command, read);
    if (denial !== null) {
        return rejected({ command, read, facts, ...denial });
    }
    const audit = auditStamp(command, facts, command.input.createdByPrincipalId);
    const snapshotVersion = nextInitialGroupSnapshotVersion(
        read.expiredGroupEntry,
        read.presenceSummary
    );
    const group = createInitialGroup({ command, audit, snapshotVersion });
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
        publicationGrantEffects: [],
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
    read: GroupMutationRead
): GroupCreateDenial | null {
    if (command.input.actorPrincipalId !== command.input.createdByPrincipalId) {
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
