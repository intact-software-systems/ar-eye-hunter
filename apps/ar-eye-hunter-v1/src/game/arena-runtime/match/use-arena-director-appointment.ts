import { useCallback, useEffect, useState, type Dispatch, type RefObject, type SetStateAction } from 'react';

import type { RallarMessageHandle } from '@shared-web/browser/messages/rallar-message-contracts.ts';
import { rallar, type RallarDirectorStatus, type RallarUnsubscribe } from '@shared-web/browser/rallar.ts';
import type { RallarGameHostAppointResult } from '@shared-web/game/director/rallar-game-director-appointment-contracts.ts';
import type { RallarGameDiagnostics } from '@shared-web/game/mod.ts';
import type { ALDeliveryLifecycle } from '@shared/alm/delivery/al-delivery-lifecycle.ts';

import type { ArenaRallarGameMatchHandle } from '../../rallar-game-match-adapter.ts';
import type { DirectorAttemptSource, DirectorAttemptState } from '../arena-connection-contracts.ts';
import { toCapabilityDelivery, toDirectorAttemptState } from './to-director-attempt-state.ts';

interface ArenaDirectorAppointmentInput {
    readonly arenaMatchRef: RefObject<ArenaRallarGameMatchHandle | undefined>;
    readonly isCurrentNetworkGeneration: (generation: number) => boolean;
    readonly currentNetworkSignal: () => AbortSignal;
    readonly nowMs: () => number;
    readonly networkGenerationRef: RefObject<number>;
    readonly roomIdRef: RefObject<string | undefined>;
    readonly setDirectorAttempt: Dispatch<SetStateAction<DirectorAttemptState>>;
    readonly setDirectorStatus: Dispatch<SetStateAction<RallarDirectorStatus>>;
    readonly setGameDiagnostics: Dispatch<SetStateAction<RallarGameDiagnostics | undefined>>;
}

interface ArenaDirectorAppointmentActions {
    attemptDirectorAppointment(source: DirectorAttemptSource): Promise<void>;
}

interface DirectorAppointmentAttempt {
    readonly source: DirectorAttemptSource;
    readonly generation: number;
    readonly roomId: string | undefined;
    readonly match: ArenaRallarGameMatchHandle | undefined;
    readonly startedAtEpochMs: number;
    readonly signal: AbortSignal;
}

export function useArenaDirectorAppointment(input: ArenaDirectorAppointmentInput): ArenaDirectorAppointmentActions {
    const [appointment] = useState(() => new ArenaDirectorAppointment(input));
    useEffect(() => () => appointment.stop(), [appointment]);
    const attemptDirectorAppointment = useCallback(
        (source: DirectorAttemptSource) => appointment.appoint(source),
        [appointment]
    );
    return { attemptDirectorAppointment };
}

class ArenaDirectorAppointment {
    private readonly input: ArenaDirectorAppointmentInput;
    private current: DirectorAppointmentAttempt | undefined;
    private unsubscribeDelivery: RallarUnsubscribe | undefined;
    private readonly stopOnAbort = () => this.stop();

    constructor(input: ArenaDirectorAppointmentInput) {
        this.input = input;
    }

    async appoint(source: DirectorAttemptSource): Promise<void> {
        const attempt = this.start(source);
        if (!attempt.roomId || !attempt.match) {
            this.finish(attempt, {
                status: 'failed',
                reason: !attempt.roomId
                    ? 'Cannot appoint a director without an arena room.'
                    : 'Rallar Game match is not ready yet.'
            });
            return;
        }
        try {
            const report = await attempt.match.reportCapability();
            if (!this.isCurrent(attempt)) {
                return;
            }
            this.observeDelivery(attempt, report.ws);
            if (!this.isCurrent(attempt)) {
                return;
            }
            const result = await attempt.match.appointIfElected();
            if (!this.isCurrent(attempt)) {
                return;
            }
            const directorStatus = result.directorStatus ?? rallar.director.status(attempt.roomId);
            const diagnostics = attempt.match.diagnostics();
            this.input.setDirectorStatus((previous) => this.isCurrent(attempt) ? directorStatus : previous);
            this.input.setGameDiagnostics((previous) => this.isCurrent(attempt) ? diagnostics : previous);
            this.finish(attempt, result);
        }
        catch (error) {
            if (!this.isCurrent(attempt)) {
                return;
            }
            this.finish(attempt, { status: 'failed', reason: error instanceof Error ? error.message : String(error) });
        }
    }

    stop(): void {
        this.current?.signal.removeEventListener('abort', this.stopOnAbort);
        this.current = undefined;
        this.unsubscribeDelivery?.();
        this.unsubscribeDelivery = undefined;
    }

    private start(source: DirectorAttemptSource): DirectorAppointmentAttempt {
        this.stop();
        const attempt: DirectorAppointmentAttempt = {
            source,
            generation: this.input.networkGenerationRef.current,
            roomId: this.input.roomIdRef.current,
            match: this.input.arenaMatchRef.current,
            startedAtEpochMs: this.input.nowMs(),
            signal: this.input.currentNetworkSignal()
        };
        this.current = attempt;
        attempt.signal.addEventListener('abort', this.stopOnAbort, { once: true });
        this.input.setDirectorAttempt((previous) =>
            this.isCurrent(attempt)
                ? {
                    source,
                    status: 'pending',
                    startedAtEpochMs: attempt.startedAtEpochMs,
                    capabilityDelivery: undefined
                }
                : previous
        );
        return attempt;
    }

    private isCurrent(attempt: DirectorAppointmentAttempt): boolean {
        return this.current === attempt && !attempt.signal.aborted &&
            this.input.isCurrentNetworkGeneration(attempt.generation) &&
            this.input.arenaMatchRef.current === attempt.match && this.input.roomIdRef.current === attempt.roomId;
    }

    private observeDelivery(attempt: DirectorAppointmentAttempt, handle: RallarMessageHandle | undefined): void {
        if (!handle) {
            return;
        }
        this.updateDelivery(attempt, handle.lifecycle());
        this.unsubscribeDelivery = handle.onEvent((lifecycle) => this.updateDelivery(attempt, lifecycle));
    }

    private updateDelivery(attempt: DirectorAppointmentAttempt, lifecycle: ALDeliveryLifecycle): void {
        if (!this.isCurrent(attempt)) {
            return;
        }
        const capabilityDelivery = toCapabilityDelivery(lifecycle);
        this.input.setDirectorAttempt((previous) =>
            this.isCurrent(attempt) && previous.status !== 'idle' ? { ...previous, capabilityDelivery } : previous
        );
    }

    private finish(
        attempt: DirectorAppointmentAttempt,
        result: Pick<RallarGameHostAppointResult, 'status' | 'reason'>
    ): void {
        if (!this.isCurrent(attempt)) {
            return;
        }
        const finishedAtEpochMs = this.input.nowMs();
        this.input.setDirectorAttempt((previous) =>
            this.isCurrent(attempt)
                ? toDirectorAttemptState({
                    source: attempt.source,
                    startedAtEpochMs: attempt.startedAtEpochMs,
                    finishedAtEpochMs,
                    resultStatus: result.status,
                    reason: result.reason,
                    capabilityDelivery: previous.capabilityDelivery
                })
                : previous
        );
    }
}
