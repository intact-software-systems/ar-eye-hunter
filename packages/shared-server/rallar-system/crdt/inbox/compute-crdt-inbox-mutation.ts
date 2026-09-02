import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';

import {
    computeAppInboxCompletion,
    validateAppInboxCompletionFacts,
    type AppInboxCompletionComputed,
    type AppInboxCompletionFacts
} from '../../app-inbox/handler/app-inbox-completion-computation.ts';
import { validateAppInboxComputedProjection } from '../../app-inbox/handler/app-inbox-computed-validation.ts';
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
    const issues: CrdtMutationValidationIssue[] = [];
    try {
        const expected = computeCrdtInboxMutation(read);
        issues.push(
            ...validateAppInboxComputedProjection(expected, computed, 'computed').map((issue) => ({
                code: 'computed-value-differs',
                message: issue.message
            }))
        );
        if (issues.length > 0) {
            return issues;
        }
        issues.push(...validateCrdtMutation(
            { command: read.command, read: read.read, computed: computed.mutation },
            expected.mutation
        ));
        issues.push(
            ...validateAppInboxCompletionFacts({
                ...read.completionFacts,
                status: EntityStatus.COMPLETED
            }).map((issue) => ({ code: 'completion-invalid', message: issue.message }))
        );
    }
    catch (caught) {
        issues.push({
            code: 'computed-value-invalid',
            message: caught instanceof Error ? caught.message : String(caught)
        });
    }
    return issues;
}

