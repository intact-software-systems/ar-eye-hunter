import type { RallarBlackBoxTestCommand } from '../../../rallar-black-box-test-contracts.ts';

import { createAlmScalePayload } from './create-alm-scale-payload.ts';
import type { AlmScaleRecipeInput } from './create-alm-scale-recipes.ts';

export function createAlmScaleShotArrivals(input: AlmScaleRecipeInput): RallarBlackBoxTestCommand {
    const prefix = 'alm-scale-director';
    const windowId = `${prefix}-traffic:g1:workload:c1:${prefix}-window`;
    const loopId = `${windowId}:g1:commands:c19:${prefix}-shot-arrivals`;
    const receiptId = `${windowId}:g1:commands:c3:${prefix}-start-receipt`;
    return {
        kind: 'loop',
        commandId: `${prefix}-shot-arrivals`,
        count: 6,
        commands: Array.from({ length: input.participantCount - 1 }, (_, playerIndex) => {
            const sessionId = `{resultCache.${receiptId}.value.expectedRecipientPeerIds.${playerIndex}}`;
            const waitId = `${prefix}-player-${playerIndex + 1}-arrival`;
            const resultId = `${loopId}:i{loop.iteration}:c${playerIndex * 3 + 1}:${waitId}`;
            return [
                {
                    kind: 'wait' as const,
                    commandId: waitId,
                    timeoutMs: 1_000,
                    match: {
                        kind: 'message' as const,
                        connection: prefix,
                        payloadPath: 'data.payload',
                        // The owned wire prefix binds envelope sender/sequence and shot session before the page-specific username.
                        contains: JSON.stringify(createAlmScalePayload(input, 'shot')).split(',"username":')[0]
                            .replaceAll('{auth.sessionId}', sessionId)
                            .replaceAll('"{loop.iteration}"', '{loop.iteration}') + ','
                    }
                },
                {
                    kind: 'assert' as const,
                    commandId: `${waitId}-type`,
                    source: `resultCache.${resultId}.value.event.payload.data.typeId`,
                    operator: 'equals' as const,
                    expected: 'room.ar-eye-hunter.director.intent.v1'
                },
                {
                    kind: 'assert' as const,
                    commandId: `${waitId}-sequence`,
                    source: `resultCache.${resultId}.value.event.payload.data.payload.payload.payload.shot.seq`,
                    operator: 'equals' as const,
                    expected: '{loop.iteration}'
                }
            ];
        }).flat()
    };
}

export function createAlmScaleLifecycleArrival(
    input: AlmScaleRecipeInput,
    kind: 'started' | 'ended'
): readonly RallarBlackBoxTestCommand[] {
    const prefix = 'alm-scale-player';
    const directorSessionId = `{resultCache.${prefix}-ready-status.value.directorStatus.appointment.sessionId}`;
    const waitId = `${prefix}-${kind}-arrival`;
    const resultId = `${prefix}-traffic:g1:workload:c1:${prefix}-window:g1:commands:c${
        kind === 'started' ? 2 : 7
    }:${waitId}`;
    return [{
        kind: 'wait',
        commandId: waitId,
        timeoutMs: 1_000,
        match: {
            kind: 'message',
            connection: prefix,
            payloadPath: 'data.payload',
            contains: JSON.stringify(createAlmScalePayload(input, kind)).replaceAll(
                '{auth.sessionId}',
                directorSessionId
            )
        }
    }, {
        kind: 'assert',
        commandId: `${waitId}-type`,
        source: `resultCache.${resultId}.value.event.payload.data.typeId`,
        operator: 'equals',
        expected: 'room.ar-eye-hunter.director.event.v1'
    }];
}
