import { createRallarBrowserAi } from '@shared-web/browser/rallar-ai.ts';
import { rallar } from '@shared-web/browser/rallar.ts';
import { transitionRallarAiResultLifecycle } from '@shared/rallar-ai/mod.ts';

import {
    type AiDirectorContext,
    createAiDirectorRequest,
    materializeAiArenaEvent,
    validateAiDirectorProposalValue,
} from '../../aiDirector.ts';
import { arenaRevisionKey, hydrateArenaSnapshot } from '../../simulation.ts';
import type { ArenaAiDirectorScheduleInput } from './start-arena-ai-director-schedule.ts';
import {
    type AiDirectorProposal,
    type AiDirectorProposalValue,
    GAME_AI_LANE_ID,
    GAME_AI_TOPIC_ID,
    GAME_PROTOCOL,
} from '../../types.ts';
import { toErrorMessage } from '../arena-connection-helpers.ts';

interface GenerateArenaAiDirectorOutputInput extends
    Pick<
        ArenaAiDirectorScheduleInput,
        | 'arenaMatchRef'
        | 'arenaSnapshotRef'
        | 'isCurrentNetworkGeneration'
        | 'runBestEffortNetworkTask'
        | 'setActiveEvent'
        | 'setAiError'
        | 'setAiStatus'
        | 'setRemoteEvents'
    > {
    readonly ai: ReturnType<typeof createRallarBrowserAi>;
    readonly generation: number;
    readonly isCancelled: () => boolean;
    readonly providerMode: 'webllm' | 'mock';
    readonly providerFallback: boolean;
    readonly roomId: string;
    readonly usedMockFallback: () => boolean;
}

export async function generateArenaAiDirectorOutput(
    input: GenerateArenaAiDirectorOutputInput,
): Promise<void> {
    const snapshot = input.arenaSnapshotRef.current;
    if (!snapshot || input.isCancelled() || !input.isCurrentNetworkGeneration(input.generation)) {
        input.setAiStatus('unavailable');
        return;
    }
    const state = hydrateArenaSnapshot(snapshot);
    input.setAiStatus(
        input.providerMode === 'webllm'
            ? 'loading model'
            : input.providerFallback
            ? 'mock fallback'
            : 'generating',
    );
    input.setAiError(undefined);
    try {
        const draft = await input.ai.generateJson<AiDirectorProposalValue, AiDirectorContext>(
            createAiDirectorRequest(state, input.roomId),
        );
        if (input.isCancelled() || !input.isCurrentNetworkGeneration(input.generation)) return;
        const validation = validateAiDirectorProposalValue(draft.value, snapshot);
        if (!validation.ok) {
            input.setAiStatus('error');
            input.setAiError(validation.reason);
            return;
        }
        const proposed = transitionRallarAiResultLifecycle({
            ...draft,
            value: validation.value,
        }, 'proposed');
        const accepted = transitionRallarAiResultLifecycle(proposed, 'accepted');
        const proposal: AiDirectorProposal = {
            generationId: accepted.generationId,
            dedupeKey: accepted.dedupeKey ?? accepted.generationId,
            baseStateRevision: accepted.baseStateRevision ?? arenaRevisionKey(state),
            value: accepted.value,
            accepted: true,
            sentAtEpochMs: Date.now(),
        };
        const event = materializeAiArenaEvent(proposal, snapshot.revision + 1, Date.now());
        await input.ai.broadcastJson({
            result: accepted,
            transport: 'realtime',
            laneId: GAME_AI_LANE_ID,
            roomId: input.roomId,
            topicId: GAME_AI_TOPIC_ID,
        });
        await rallar.data.open<AiDirectorProposal>('ar-eye-hunter-ai-replay', {
            scope: 'session',
            durability: 'write-behind',
            schemaVersion: 1,
        }).then((store) => store.set(proposal.dedupeKey, proposal));
        if (input.isCancelled() || !input.isCurrentNetworkGeneration(input.generation)) return;
        input.setRemoteEvents((previous) => [
            ...previous.filter((item) => item.id !== event.id).slice(-12),
            event,
        ]);
        input.setActiveEvent(event);
        input.setAiStatus(
            input.usedMockFallback()
                ? 'mock fallback'
                : input.providerMode === 'webllm'
                ? 'webllm'
                : 'accepted',
        );
        input.runBestEffortNetworkTask(
            () =>
                input.arenaMatchRef.current?.publishEvent({
                    protocol: GAME_PROTOCOL,
                    kind: 'arena-event',
                    event,
                }),
            input.generation,
        );
    } catch (error) {
        if (!input.isCancelled() && input.isCurrentNetworkGeneration(input.generation)) {
            input.setAiStatus('error');
            input.setAiError(toErrorMessage(
                error instanceof Error ? error : new Error(String(error)),
            ));
        }
    }
}
