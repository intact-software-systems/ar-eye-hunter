import { rallar } from '@shared-web/browser/rallar.ts';
import type { RallarDirectorStatus } from '@shared-web/browser/rallar.ts';
import type { RallarGameDiagnostics } from '@shared-web/game/mod.ts';
import { useCallback } from 'react';
import type { Dispatch, RefObject, SetStateAction } from 'react';

import type { ArenaRallarGameMatchHandle } from '../../rallar-game-match-adapter.ts';
import type { DirectorAttemptSource } from '../arena-connection-contracts.ts';
import type { DirectorAttemptState } from '../arena-connection-contracts.ts';
import { toDirectorAttemptState, toErrorMessage } from '../arena-connection-helpers.ts';

interface ArenaDirectorAppointmentInput {
    readonly arenaMatchRef: RefObject<ArenaRallarGameMatchHandle | undefined>;
    readonly isCurrentNetworkGeneration: (generation: number) => boolean;
    readonly networkGenerationRef: RefObject<number>;
    readonly roomIdRef: RefObject<string | undefined>;
    readonly setDirectorAttempt: Dispatch<SetStateAction<DirectorAttemptState>>;
    readonly setDirectorStatus: Dispatch<SetStateAction<RallarDirectorStatus>>;
    readonly setGameDiagnostics: Dispatch<SetStateAction<RallarGameDiagnostics | undefined>>;
}

export function useArenaDirectorAppointment(
    input: ArenaDirectorAppointmentInput
): Readonly<{
    attemptDirectorAppointment: (source: DirectorAttemptSource) => Promise<void>;
}> {
    const {
        arenaMatchRef,
        isCurrentNetworkGeneration,
        networkGenerationRef,
        roomIdRef,
        setDirectorAttempt,
        setDirectorStatus,
        setGameDiagnostics
    } = input;

    const attemptDirectorAppointment = useCallback(async (
        source: DirectorAttemptSource
    ) => {
        const currentRoomId = roomIdRef.current;
        const generation = networkGenerationRef.current;
        const startedAtEpochMs = Date.now();
        setDirectorAttempt({
            source,
            status: 'pending',
            startedAtEpochMs
        });

        if (!currentRoomId) {
            setDirectorAttempt({
                source,
                status: 'failed',
                reason: 'Cannot appoint a director without an arena room.',
                startedAtEpochMs,
                finishedAtEpochMs: Date.now(),
                durationMs: Date.now() - startedAtEpochMs
            });
            return;
        }

        try {
            const match = arenaMatchRef.current;
            if (!match) {
                setDirectorStatus(rallar.director.status(currentRoomId));
                setDirectorAttempt(toDirectorAttemptState({
                    source,
                    startedAtEpochMs,
                    resultStatus: 'failed',
                    reason: 'Rallar Game match is not ready yet.'
                }));
                return;
            }

            await match.reportCapability();
            const result = await match.appointIfElected();
            if (!isCurrentNetworkGeneration(generation)) {
                return;
            }
            if (result.directorStatus) {
                setDirectorStatus(result.directorStatus);
            }
            else {
                setDirectorStatus(rallar.director.status(currentRoomId));
            }
            setGameDiagnostics(match.diagnostics());
            setDirectorAttempt(toDirectorAttemptState({
                source,
                startedAtEpochMs,
                resultStatus: result.status,
                reason: result.reason
            }));
        }
        catch (err) {
            if (!isCurrentNetworkGeneration(generation)) {
                return;
            }
            setDirectorStatus(rallar.director.status(currentRoomId));
            setDirectorAttempt(toDirectorAttemptState({
                source,
                startedAtEpochMs,
                resultStatus: 'failed',
                reason: toErrorMessage(
                    err instanceof Error ? err : new Error(String(err))
                )
            }));
        }
    }, [isCurrentNetworkGeneration]);

    return { attemptDirectorAppointment };
}
