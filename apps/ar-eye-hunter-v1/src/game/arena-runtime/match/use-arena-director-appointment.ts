import { useCallback } from 'react';
import { rallar } from '@shared-web/browser/rallar.ts';

import type { DirectorAttemptSource } from '../arena-connection-contracts.ts';
import type {
    ArenaConnectionLifecycle,
    ArenaConnectionLifecycleInput,
} from '../lifecycle/use-arena-connection-lifecycle.ts';
import { toDirectorAttemptState, toErrorMessage } from '../arena-connection-helpers.ts';

export function useArenaDirectorAppointment(
    input: ArenaConnectionLifecycleInput,
): Pick<ArenaConnectionLifecycle, 'attemptDirectorAppointment'> {
    const {
        arenaMatchRef,
        isCurrentNetworkGeneration,
        networkGenerationRef,
        roomIdRef,
        setDirectorAttempt,
        setDirectorStatus,
        setGameDiagnostics,
    } = input;

    const attemptDirectorAppointment = useCallback(async (
        source: DirectorAttemptSource,
    ) => {
        const currentRoomId = roomIdRef.current;
        const generation = networkGenerationRef.current;
        const startedAtEpochMs = Date.now();
        setDirectorAttempt({
            source,
            status: 'pending',
            startedAtEpochMs,
        });

        if (!currentRoomId) {
            setDirectorAttempt({
                source,
                status: 'failed',
                reason: 'Cannot appoint a director without an arena room.',
                startedAtEpochMs,
                finishedAtEpochMs: Date.now(),
                durationMs: Date.now() - startedAtEpochMs,
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
                    reason: 'Rallar Game match is not ready yet.',
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
            } else {
                setDirectorStatus(rallar.director.status(currentRoomId));
            }
            setGameDiagnostics(match.diagnostics());
            setDirectorAttempt(toDirectorAttemptState({
                source,
                startedAtEpochMs,
                resultStatus: result.status,
                reason: result.reason,
            }));
        } catch (err) {
            if (!isCurrentNetworkGeneration(generation)) {
                return;
            }
            setDirectorStatus(rallar.director.status(currentRoomId));
            setDirectorAttempt(toDirectorAttemptState({
                source,
                startedAtEpochMs,
                resultStatus: 'failed',
                reason: toErrorMessage(
                    err instanceof Error ? err : new Error(String(err)),
                ),
            }));
        }
    }, [isCurrentNetworkGeneration]);

    return { attemptDirectorAppointment };
}
