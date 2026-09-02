import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';

import { validateAppInboxComputedProjection } from '../../app-inbox/handler/app-inbox-computed-validation.ts';

import {
    computeAppInboxCompletion,
    validateAppInboxCompletionFacts,
    type AppInboxCompletionComputed,
    type AppInboxCompletionFacts
} from '../../app-inbox/handler/app-inbox-completion-computation.ts';
import { computeRtcRttMutation } from '../mutation/compute-rtc-rtt-mutation.ts';
import type {
    RtcRttMutationCommand,
    RtcRttMutationComputed,
    RtcRttMutationFacts,
    RtcRttMutationRead
} from '../mutation/rtc-rtt-mutation-contracts.ts';
import { validateRtcRttMutation } from '../mutation/validate-rtc-rtt-mutation.ts';
import { toRtcRttAppInboxResult, type RtcRttAppInboxResult } from './rtc-rtt-app-inbox-result.ts';

export interface RtcRttAppInboxRead {
    readonly requestId: string;
    readonly command: RtcRttMutationCommand;
    readonly mutationRead: RtcRttMutationRead;
    readonly facts: RtcRttMutationFacts;
    readonly completionFacts: AppInboxCompletionFacts;
}

export interface RtcRttAppInboxComputed {
    readonly mutation: RtcRttMutationComputed;
    readonly completion: AppInboxCompletionComputed<RtcRttAppInboxResult>;
}

export interface RtcRttAppInboxValidationIssue {
    readonly path: string;
    readonly message: string;
    readonly cause: Error;
}

export function computeRtcRttAppInboxMutation(read: RtcRttAppInboxRead): RtcRttAppInboxComputed {
    const mutation = computeRtcRttMutation({
        command: read.command,
        read: read.mutationRead,
        facts: read.facts
    });
    return {
        mutation,
        completion: computeAppInboxCompletion({
            ...read.completionFacts,
            durableResult: toRtcRttAppInboxResult(mutation, read.requestId),
            status: EntityStatus.COMPLETED
        })
    };
}

export function validateRtcRttAppInboxMutation(
    read: RtcRttAppInboxRead,
    computed: RtcRttAppInboxComputed
): readonly RtcRttAppInboxValidationIssue[] {
    try {
        const projectionIssues = validateAppInboxComputedProjection(
            computeRtcRttAppInboxMutation(read),
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

    const issues: RtcRttAppInboxValidationIssue[] = [];
    try {
        validateRtcRttMutation({
            command: read.command,
            read: read.mutationRead,
            facts: read.facts,
            computed: computed.mutation
        });
    }
    catch (caught) {
        const cause = caught instanceof Error ? caught : new Error(String(caught));
        issues.push({ path: 'mutation', message: cause.message, cause });
    }
    issues.push(...validateAppInboxCompletionFacts({
        ...read.completionFacts,
        status: EntityStatus.COMPLETED
    }));
    return issues;
}

