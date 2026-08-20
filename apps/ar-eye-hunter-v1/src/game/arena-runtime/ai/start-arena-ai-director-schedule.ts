import { createRallarBrowserAi } from '@shared-web/browser/rallar-ai.ts';
import { rallar } from '@shared-web/browser/rallar.ts';
import type { Dispatch, RefObject, SetStateAction } from 'react';
import type { RallarDirectorStatus } from '@shared-web/browser/rallar.ts';

import { createAiDirectorMockProvider } from '../../aiDirector.ts';
import { createArenaBrowserAiProvider } from '../../browserAiProvider.ts';
import { resolveArenaBrowserAiConfig } from '../../browserAiConfig.ts';
import { arenaRevisionKey, hydrateArenaSnapshot } from '../../simulation.ts';
import { generateArenaAiDirectorOutput } from './generate-arena-ai-director-output.ts';
import type { ArenaRallarGameMatchHandle } from '../../rallar-game-match-adapter.ts';
import type { ArenaEvent, ArenaSnapshot } from '../../types.ts';
import type {
    ArenaAiStatus,
    ArenaConnectionState,
} from '../arena-connection-contracts.ts';

const BROWSER_RALLAR_AI_CONFIG = resolveArenaBrowserAiConfig();

export interface ArenaAiDirectorScheduleInput {
    readonly arenaMatchRef: RefObject<ArenaRallarGameMatchHandle | undefined>;
    readonly arenaSnapshotRef: RefObject<ArenaSnapshot | undefined>;
    readonly connectionState: ArenaConnectionState;
    readonly directorStatus: RallarDirectorStatus;
    readonly isCurrentNetworkGeneration: (generation: number) => boolean;
    readonly networkGenerationRef: RefObject<number>;
    readonly roomId: string | undefined;
    readonly runBestEffortNetworkTask: <T>(
        task: () => Promise<T> | undefined,
        generation?: number,
    ) => void;
    readonly setActiveEvent: Dispatch<SetStateAction<ArenaEvent | undefined>>;
    readonly setAiError: Dispatch<SetStateAction<string | undefined>>;
    readonly setAiStatus: Dispatch<SetStateAction<ArenaAiStatus>>;
    readonly setRemoteEvents: Dispatch<SetStateAction<readonly ArenaEvent[]>>;
}

export function startArenaAiDirectorSchedule(
    input: ArenaAiDirectorScheduleInput,
): (() => void) | undefined {
    if (
        input.connectionState !== 'connected' ||
        !input.roomId ||
        !input.directorStatus.isDirector ||
        !input.directorStatus.isFresh
    ) {
        input.setAiStatus((current) =>
            current === 'generating' || current === 'loading model' ? 'idle' : current
        );
        return undefined;
    }
    let cancelled = false;
    const generation = input.networkGenerationRef.current;
    let usedMockFallback = false;
    const providerSelection = createArenaBrowserAiProvider({
        config: BROWSER_RALLAR_AI_CONFIG,
        createMockProvider: createAiDirectorMockProvider,
        onFallback: (reason) => {
            usedMockFallback = true;
            if (!cancelled && input.isCurrentNetworkGeneration(generation)) {
                input.setAiStatus('mock fallback');
                input.setAiError(`WebLLM fallback: ${reason}`);
            }
        },
        onWebLlmProgress: () => {
            if (!cancelled && input.isCurrentNetworkGeneration(generation)) {
                input.setAiStatus('loading model');
            }
        },
    });
    if (providerSelection.status !== 'ready') {
        input.setAiStatus('unavailable');
        input.setAiError(providerSelection.reason);
        return undefined;
    }
    const ai = createRallarBrowserAi({
        rallar,
        provider: providerSelection.provider,
        policy: { mode: 'browser-only', staleResultMode: 'reject', timeoutMs: 3_000 },
        readCurrentStateRevision: () => {
            const snapshot = input.arenaSnapshotRef.current;
            return snapshot ? arenaRevisionKey(hydrateArenaSnapshot(snapshot)) : undefined;
        },
    });
    const roomId = input.roomId;
    const generate = () =>
        generateArenaAiDirectorOutput({
            ...input,
            ai,
            generation,
            isCancelled: () => cancelled,
            providerMode: providerSelection.mode,
            providerFallback: providerSelection.fallback,
            roomId,
            usedMockFallback: () => usedMockFallback,
        });
    const initial = window.setTimeout(() => void generate(), 4_500);
    const interval = window.setInterval(() => void generate(), 10_500);
    return () => {
        cancelled = true;
        window.clearTimeout(initial);
        window.clearInterval(interval);
    };
}
