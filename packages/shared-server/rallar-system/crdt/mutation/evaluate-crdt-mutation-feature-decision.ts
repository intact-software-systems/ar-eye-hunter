import {
    evaluateRallarCrdtFeaturePolicy,
    type RallarCrdtDocumentTypePolicy,
    type RallarCrdtFeatureDecision
} from '@shared/crdt/mod.ts';

import type { CrdtMutationCommand } from './crdt-mutation-contracts.ts';

export interface EvaluateCrdtMutationFeatureDecisionInput {
    readonly command: CrdtMutationCommand;
    readonly policies: readonly RallarCrdtDocumentTypePolicy[];
}

export function evaluateCrdtMutationFeatureDecision(
    input: EvaluateCrdtMutationFeatureDecisionInput
): RallarCrdtFeatureDecision {
    return evaluateRallarCrdtFeaturePolicy({
        document: input.command.document,
        operation: input.command.operation === 'append'
            ? 'durable-append'
            : input.command.operation === 'rebuild-projection'
            ? 'projection-rebuild'
            : 'admin-export',
        policies: input.policies
    });
}
