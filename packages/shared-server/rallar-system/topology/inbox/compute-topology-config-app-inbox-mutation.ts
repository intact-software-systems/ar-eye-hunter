import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';

import { validateAppInboxComputedProjection } from '../../app-inbox/handler/app-inbox-computed-validation.ts';

import {
    computeAppInboxCompletion,
    validateAppInboxCompletionFacts,
    type AppInboxCompletionComputed,
    type AppInboxCompletionFacts
} from '../../app-inbox/handler/app-inbox-completion-computation.ts';
import {
    computeTopologyConfigMutationAttempt,
    validateTopologyConfigMutationAttempt,
    type GroupTopologyConfigMutationAttempt,
    type GroupTopologyConfigMutationAttemptRead,
    type TopologyConfigMutationAttemptValidationIssue
} from '../config/group-topology-config-mutation-service.ts';
import type {
    GroupTopologyConfigMutationCommand,
    GroupTopologyConfigMutationComputed
} from '../config/mutation/group-topology-config-mutation-contracts.ts';
import {
    toTopologyConfigMutationResult,
    type GroupTopologyConfigMutationExecution
} from '../config/mutation/to-topology-config-mutation-result.ts';

export interface TopologyConfigAppInboxRead {
    readonly command: GroupTopologyConfigMutationCommand;
    readonly mutationRead: GroupTopologyConfigMutationAttemptRead;
    readonly attempt: GroupTopologyConfigMutationAttempt;
    readonly completionFacts: AppInboxCompletionFacts;
}

export type TopologyConfigAppInboxComputed =
    | {
        readonly mutation: Extract<GroupTopologyConfigMutationComputed, { outcome: 'idempotency-conflict'; }>;
        readonly completion: null;
    }
    | {
        readonly mutation: Exclude<GroupTopologyConfigMutationComputed, { outcome: 'idempotency-conflict'; }>;
        readonly completion: AppInboxCompletionComputed<GroupTopologyConfigMutationExecution>;
    };

export function computeTopologyConfigAppInboxMutation(
    read: TopologyConfigAppInboxRead
): TopologyConfigAppInboxComputed {
    const mutation = computeTopologyConfigMutationAttempt(read.command, read.mutationRead, read.attempt);
    if (mutation.outcome === 'idempotency-conflict') {
        return { mutation, completion: null };
    }
    return {
        mutation,
        completion: computeAppInboxCompletion({
            ...read.completionFacts,
            durableResult: toTopologyConfigMutationResult(mutation),
            status: EntityStatus.COMPLETED
        })
    };
}

export function validateTopologyConfigAppInboxMutation(
    read: TopologyConfigAppInboxRead,
    computed: TopologyConfigAppInboxComputed
): readonly TopologyConfigMutationAttemptValidationIssue[] {
    try {
        const projectionIssues = validateAppInboxComputedProjection(
            computeTopologyConfigAppInboxMutation(read),
            computed,
            'computed'
        );
        if (projectionIssues.length > 0) {
            return projectionIssues;
        }
    }
    catch (caught) {
        const cause = caught instanceof Error ? caught : new Error(String(caught));
        return [{ path: 'read', message: cause.message, cause }];
    }

    const issues = [...validateTopologyConfigMutationAttempt({
        command: read.command,
        read: read.mutationRead,
        attempt: read.attempt
    }, computed.mutation)];
    if (computed.completion !== null) {
        issues.push(...validateAppInboxCompletionFacts({
            ...read.completionFacts,
            status: EntityStatus.COMPLETED
        }));
    }
    return issues;
}

