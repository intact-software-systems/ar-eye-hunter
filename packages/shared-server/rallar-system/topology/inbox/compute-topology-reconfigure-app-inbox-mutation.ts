import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';

import { validateAppInboxComputedProjection } from '../../app-inbox/handler/app-inbox-computed-validation.ts';

import {
    computeAppInboxCompletion,
    validateAppInboxCompletionFacts,
    type AppInboxCompletionComputed,
    type AppInboxCompletionFacts
} from '../../app-inbox/handler/app-inbox-completion-computation.ts';
import type {
    GroupTopologyReconfigureCommand,
    GroupTopologyReconfigureComputed,
    GroupTopologyReconfigureRead
} from '../reconfigure/group-topology-reconfigure-contracts.ts';
import {
    computeGroupTopologyReconfigureMutation,
    validateGroupTopologyReconfigureMutation,
    type GroupTopologyReconfigureValidationIssue
} from '../reconfigure/group-topology-reconfigure-mutation.ts';
import type { TopologyReconfigureInboxResult } from './topology-app-inbox-handler.ts';

export interface TopologyReconfigureAppInboxRead {
    readonly command: GroupTopologyReconfigureCommand;
    readonly mutationRead: GroupTopologyReconfigureRead;
    readonly completionFacts: AppInboxCompletionFacts;
}

export interface TopologyReconfigureAppInboxComputed {
    readonly mutation: GroupTopologyReconfigureComputed;
    readonly completion: AppInboxCompletionComputed<TopologyReconfigureInboxResult>;
}

export function computeTopologyReconfigureAppInboxMutation(
    read: TopologyReconfigureAppInboxRead
): TopologyReconfigureAppInboxComputed {
    const mutation = computeGroupTopologyReconfigureMutation(read.command, read.mutationRead);
    return {
        mutation,
        completion: computeAppInboxCompletion({
            ...read.completionFacts,
            durableResult: toTopologyReconfigureInboxResult(read.command, mutation),
            status: EntityStatus.COMPLETED
        })
    };
}

export function validateTopologyReconfigureAppInboxMutation(
    read: TopologyReconfigureAppInboxRead,
    computed: TopologyReconfigureAppInboxComputed
): readonly GroupTopologyReconfigureValidationIssue[] {
    try {
        const projectionIssues = validateAppInboxComputedProjection(
            computeTopologyReconfigureAppInboxMutation(read),
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

    return [
        ...validateGroupTopologyReconfigureMutation(read.command, read.mutationRead, computed.mutation),
        ...validateAppInboxCompletionFacts({
            ...read.completionFacts,
            status: EntityStatus.COMPLETED
        })
    ];
}

function toTopologyReconfigureInboxResult(
    command: GroupTopologyReconfigureCommand,
    mutation: GroupTopologyReconfigureComputed
): TopologyReconfigureInboxResult {
    return {
        status: 'queued',
        groupRef: command.groupRef,
        requestId: command.commandId,
        outboxId: mutation.resourceId
    };
}

