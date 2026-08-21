import type { RallarAiResultLifecycleState } from './rallar-ai-types.ts';
import { RallarAiError } from './rallar-ai-types.ts';

const ALLOWED_TRANSITIONS: Record<RallarAiResultLifecycleState, readonly RallarAiResultLifecycleState[]> = {
    draft: ['proposed', 'accepted', 'rejected', 'expired', 'superseded'],
    proposed: ['accepted', 'rejected', 'expired', 'superseded'],
    accepted: ['superseded'],
    rejected: [],
    expired: [],
    superseded: []
};

export function canTransitionRallarAiResultLifecycle(
    from: RallarAiResultLifecycleState,
    to: RallarAiResultLifecycleState
): boolean {
    return from === to || ALLOWED_TRANSITIONS[from].includes(to);
}

export function assertRallarAiResultLifecycleTransition(
    from: RallarAiResultLifecycleState,
    to: RallarAiResultLifecycleState
): void {
    if (!canTransitionRallarAiResultLifecycle(from, to)) {
        throw new RallarAiError(
            'invalid-lifecycle-transition',
            `Invalid RallarAI lifecycle transition: ${from} -> ${to}.`
        );
    }
}
