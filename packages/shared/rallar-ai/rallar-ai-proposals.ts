import {
    type RallarAiJsonResult,
    type RallarAiResultLifecycleState,
} from './rallar-ai-types.ts';
import { assertRallarAiResultLifecycleTransition } from './rallar-ai-result-lifecycle.ts';

export type RallarAiAcceptedResultDecision = Readonly<{
    applied: boolean;
    dedupeId: string;
    reason?: 'duplicate' | 'not-accepted';
}>;

export type RallarAiAcceptedResultTracker<TValue = unknown> = Readonly<{
    hasAccepted(result: RallarAiJsonResult<TValue>): boolean;
    acceptOnce(
        result: RallarAiJsonResult<TValue>,
        apply?: (result: RallarAiJsonResult<TValue>) => void | Promise<void>,
    ): Promise<RallarAiAcceptedResultDecision>;
    snapshot(): readonly string[];
}>;

export function getRallarAiResultDedupeId(
    result: Pick<RallarAiJsonResult, 'dedupeKey' | 'generationId'>,
): string {
    return result.dedupeKey ?? result.generationId;
}

export function transitionRallarAiResultLifecycle<TValue>(
    result: RallarAiJsonResult<TValue>,
    lifecycle: RallarAiResultLifecycleState,
): RallarAiJsonResult<TValue> {
    assertRallarAiResultLifecycleTransition(
        result.lifecycle ?? 'draft',
        lifecycle,
    );
    return {
        ...result,
        lifecycle,
    };
}

export function createRallarAiAcceptedResultTracker<TValue = unknown>(
    acceptedDedupeIds: Iterable<string> = [],
): RallarAiAcceptedResultTracker<TValue> {
    const accepted = new Set(acceptedDedupeIds);

    return {
        hasAccepted: (result) => accepted.has(getRallarAiResultDedupeId(result)),
        acceptOnce: async (result, apply) => {
            const dedupeId = getRallarAiResultDedupeId(result);
            if (result.lifecycle !== 'accepted') {
                return {
                    applied: false,
                    dedupeId,
                    reason: 'not-accepted',
                };
            }
            if (accepted.has(dedupeId)) {
                return {
                    applied: false,
                    dedupeId,
                    reason: 'duplicate',
                };
            }

            accepted.add(dedupeId);
            await apply?.(result);
            return {
                applied: true,
                dedupeId,
            };
        },
        snapshot: () => Array.from(accepted).sort(),
    };
}
