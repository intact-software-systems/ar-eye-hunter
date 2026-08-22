import { readAuthenticatedPlanClosureChanges } from './plan-closure-receipt.mjs';
import { readAuthenticatedPlanGovernanceChanges } from './plan-governance-receipt.mjs';

export function readAuthenticatedPlanTransitionChanges(transitionInput) {
    const governance = readAuthenticatedPlanGovernanceChanges(transitionInput);
    const closure = readAuthenticatedPlanClosureChanges({
        ...transitionInput,
        changes: governance.changes
    });
    return {
        authenticatedPlans: [...governance.authenticatedPlans, ...closure.authenticatedPlans],
        authenticatedDispositions: governance.authenticatedDispositions ?? [],
        changes: closure.changes,
        issues: [...governance.issues, ...closure.issues]
    };
}
