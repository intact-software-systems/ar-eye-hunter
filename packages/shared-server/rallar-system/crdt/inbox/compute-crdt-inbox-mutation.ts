import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';

import {
    computeAppInboxCompletion,
    validateAppInboxCompletion,
    type AppInboxCompletionComputed,
    type AppInboxCompletionFacts
} from '../../app-inbox/handler/app-inbox-completion-computation.ts';
import { computeCrdtMutation, type ComputeCrdtMutationInput } from '../mutation/compute-crdt-mutation.ts';
import type {
    CrdtMutationComputed,
    CrdtMutationResult,
    CrdtMutationValidationIssue
} from '../mutation/crdt-mutation-contracts.ts';
import { validateCrdtMutation } from '../mutation/validate-crdt-mutation.ts';

export interface CrdtInboxMutationRead extends ComputeCrdtMutationInput {
    readonly completionFacts: AppInboxCompletionFacts;
}

export interface CrdtInboxMutationComputed {
    readonly mutation: CrdtMutationComputed;
    readonly completion: AppInboxCompletionComputed<CrdtMutationResult>;
}

export function computeCrdtInboxMutation(read: CrdtInboxMutationRead): CrdtInboxMutationComputed {
    const mutation = computeCrdtMutation(read);
    const completion = computeAppInboxCompletion({
        ...read.completionFacts,
        durableResult: mutation.result,
        status: EntityStatus.COMPLETED
    });
    return { mutation, completion };
}

export function validateCrdtInboxMutation(
    read: CrdtInboxMutationRead,
    computed: CrdtInboxMutationComputed
): readonly CrdtMutationValidationIssue[] {
    const issues = [...validateCrdtMutation({
        command: read.command,
        read: read.read,
        serviceId: read.serviceId,
        computed: computed.mutation
    })];
    issues.push(
        ...validateAppInboxCompletion({
            ...read.completionFacts,
            durableResult: computed.mutation.result,
            status: EntityStatus.COMPLETED
        }, computed.completion).map((issue) => ({
            code: 'completion-invalid',
            message: issue.message
        }))
    );
    return issues;
}
