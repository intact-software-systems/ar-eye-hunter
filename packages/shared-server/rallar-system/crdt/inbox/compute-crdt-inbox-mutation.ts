import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import {
    computeAppInboxCompletion,
    validateAppInboxCompletion,
    type AppInboxCompletionComputed,
    type AppInboxCompletionFacts
} from '../../app-inbox/handler/app-inbox-completion-computation.ts';
import { validateComputedProjection } from '../../computed-data-validation.ts';
import { computeCrdtMutation, type ComputeCrdtMutationInput } from '../mutation/compute-crdt-mutation.ts';
import type {
    CrdtMutationComputed,
    CrdtMutationResult,
    CrdtMutationValidationIssue
} from '../mutation/crdt-mutation-contracts.ts';
import { validateCrdtMutation } from '../mutation/validate-crdt-mutation.ts';
import {
    computeCrdtOutboxProvenance,
    type CrdtOutboxProvenanceInsert
} from '../persistence/crdt-outbox-provenance.ts';

interface CrdtInboxMutationRead extends ComputeCrdtMutationInput {
    readonly completionFacts: AppInboxCompletionFacts;
}

interface CrdtInboxMutationComputed {
    readonly mutation: CrdtMutationComputed;
    readonly completion: AppInboxCompletionComputed<CrdtMutationResult>;
    readonly provenanceWrites: readonly CrdtOutboxProvenanceInsert[];
}

export async function computeCrdtInboxMutation(read: CrdtInboxMutationRead): Promise<CrdtInboxMutationComputed> {
    const mutation = computeCrdtMutation(read);
    const completion = computeAppInboxCompletion({
        ...read.completionFacts,
        durableResult: mutation.result,
        status: EntityStatus.COMPLETED
    });
    return { mutation, completion, provenanceWrites: await computeCrdtOutboxProvenance(mutation) };
}

export async function validateCrdtInboxMutation(
    read: CrdtInboxMutationRead,
    computed: CrdtInboxMutationComputed
): Promise<readonly CrdtMutationValidationIssue[]> {
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
    const expectedMutation = computeCrdtMutation(read);
    const expectedProvenance = await computeCrdtOutboxProvenance(expectedMutation);
    issues.push(
        ...validateComputedProjection(expectedProvenance, computed.provenanceWrites, 'computed.provenanceWrites')
            .map((issue) => ({ code: 'provenance-invalid', message: issue.message }))
    );
    return issues;
}
