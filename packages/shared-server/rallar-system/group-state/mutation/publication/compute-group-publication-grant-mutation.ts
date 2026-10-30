import type { GroupPolicyDenied, GroupPolicyResult } from '@shared/api/group-policy-types.ts';
import type {
    GroupPublicationGrant,
    GroupPublicationTopicGrants,
    GroupPublicationTopicPermissions
} from '@shared/api/group-publication/group-publication-grants.ts';
import type { Group } from '@shared/api/group-types.ts';
import { jsonEquals } from '@shared/repository/state-utils.ts';

import type { RuntimeStateEntryValue } from '../../../../runtime-state/runtime-state-json-store.ts';
import { canGovernGroupMember } from '../../policy/group-governance-policy.ts';
import { canMutateActiveGroup } from '../../policy/group-lifecycle-policy.ts';
import {
    canChangeGroupPublicationGrant,
    canHoldGroupPublicationTopics
} from '../../policy/group-publication-grant-policy.ts';
import { toPolicySnapshot } from '../aggregate/group-aggregate-mutation-policy.ts';
import type {
    GroupMutationCommand,
    GroupMutationComputed,
    GroupMutationFacts,
    GroupMutationRead,
    GroupPublicationGrantEffect,
    GroupPublicationGrantOperation
} from '../group-mutation-contracts.ts';
import {
    auditStamp,
    computeGroupMutationWriteResult,
    noOp,
    rejectedByGroupPolicy,
    requireGroup
} from '../group-mutation-result.ts';

type GroupPublicationGrantCommand = Extract<GroupMutationCommand, { operation: GroupPublicationGrantOperation; }>;

export function computeGroupPublicationGrantMutation(
    command: GroupPublicationGrantCommand,
    read: GroupMutationRead,
    facts: GroupMutationFacts
): GroupMutationComputed {
    const denial = resolvePublicationGrantDenial(command, read, facts);
    if (denial !== null) {
        return rejectedByGroupPolicy({ command, read, facts, denial });
    }
    const current = read.targetPublicationGrant?.value.topics ?? {};
    const topics = computeGroupPublicationTopicGrants(current, command);
    const capacity = canHoldGroupPublicationTopics(topics);
    if (!capacity.allowed) {
        return rejectedByGroupPolicy({ command, read, facts, denial: capacity });
    }
    return jsonEquals(topics, current)
        ? noOp(command, read, facts)
        : computePublicationGrantWrite({ command, read, facts, topics });
}

function resolvePublicationGrantDenial(
    command: GroupPublicationGrantCommand,
    read: GroupMutationRead,
    facts: GroupMutationFacts
): GroupPolicyDenied | null {
    const results: readonly GroupPolicyResult[] = [
        canMutateActiveGroup({
            group: requireGroup(read, command.aggregateRef).value,
            nowEpochMs: facts.attemptAtEpochMs
        }),
        canGovernGroupMember({
            snapshot: toPolicySnapshot(read, command.aggregateRef, facts.attemptAtEpochMs),
            actor: {
                principalId: command.input.actorPrincipalId ?? undefined,
                sessionId: command.input.actorSessionId ?? undefined
            },
            targetPrincipalId: command.targetPrincipalId,
            action: command.operation === 'grantGroupPublication' ? 'grant-publication' : 'revoke-publication'
        }),
        canChangeGroupPublicationGrant({
            target: read.targetMember ?? undefined,
            grantsPublish: command.operation === 'grantGroupPublication' && command.input.publish
        })
    ];
    return results.find((result): result is GroupPolicyDenied => !result.allowed) ?? null;
}

/** D492: grant adds the named permissions, revoke removes them, and a topic left with neither leaves the row. */
function computeGroupPublicationTopicGrants(
    current: GroupPublicationTopicGrants,
    command: GroupPublicationGrantCommand
): GroupPublicationTopicGrants {
    const { topicId, publish, subscribe } = command.input;
    const previous = current[topicId] ?? { publish: false, subscribe: false };
    const next: GroupPublicationTopicPermissions = command.operation === 'grantGroupPublication'
        ? { publish: previous.publish || publish, subscribe: previous.subscribe || subscribe }
        : { publish: previous.publish && !publish, subscribe: previous.subscribe && !subscribe };
    const others = Object.entries(current).filter(([candidate]) => candidate !== topicId);
    const entries = next.publish || next.subscribe ? [...others, [topicId, next] as const] : others;
    return Object.fromEntries(entries.toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)));
}

interface PublicationGrantWriteInput {
    readonly command: GroupPublicationGrantCommand;
    readonly read: GroupMutationRead;
    readonly facts: GroupMutationFacts;
    readonly topics: GroupPublicationTopicGrants;
}

function computePublicationGrantWrite(
    { command, read, facts, topics }: PublicationGrantWriteInput
): GroupMutationComputed {
    const stored = requireGroup(read, command.aggregateRef);
    const audit = auditStamp(command, facts, command.input.actorPrincipalId ?? undefined);
    const group: Group = { ...stored.value, snapshotVersion: stored.value.snapshotVersion + 1, updated: audit };
    const next: GroupPublicationGrant = {
        ...command.aggregateRef,
        principalId: command.targetPrincipalId,
        topics,
        updated: audit
    };
    return computeGroupMutationWriteResult({
        command,
        read,
        facts,
        guard: { kind: 'group', operation: 'update', value: group, expectedRevision: stored.entry.revision },
        members: [],
        initialPresenceSummary: null,
        eventType: 'publication-grant-changed',
        lifecyclePolicy: null,
        // D493: the summary worker writes the browser delta; grants are no planning input, so the topology work it
        // mints is a no-op.
        presenceSummaryWork: 'enqueue',
        publicationGrantEffects: [toPublicationGrantEffect(read.targetPublicationGrant, next)]
    });
}

function toPublicationGrantEffect(
    current: RuntimeStateEntryValue<GroupPublicationGrant> | null,
    next: GroupPublicationGrant
): GroupPublicationGrantEffect {
    if (current === null) {
        return { operation: 'insert', value: next };
    }
    return Object.keys(next.topics).length === 0
        ? { operation: 'delete', value: current.value, expectedRevision: current.entry.revision }
        : { operation: 'update', value: next, expectedRevision: current.entry.revision };
}
