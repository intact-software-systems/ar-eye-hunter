import type { ApiMiddleware } from '@shared-web/browser/app-context.ts';

export interface RallarLifecycleParticipant {
    readonly id: string;
    readonly order: number;
    attach?(ctx: ApiMiddleware): void;
    connected?(): void;
    detach?(ctx?: ApiMiddleware): void;
    disconnected?(): void;
}

export interface RallarLifecycleCoordinator {
    register(participant: RallarLifecycleParticipant): void;
    attach(ctx: ApiMiddleware): void;
    connected(): void;
    detach(ctx?: ApiMiddleware): void;
    disconnected(): void;
}

export function createRallarLifecycleCoordinator(): RallarLifecycleCoordinator {
    const participants = new Map<string, RallarLifecycleParticipant>();

    const ordered = (): readonly RallarLifecycleParticipant[] =>
        [...participants.values()].sort((left, right) => left.order - right.order);

    return {
        register: (participant): void => {
            if (participants.has(participant.id)) {
                throw new Error(
                    `Duplicate Rallar lifecycle participant: ${participant.id}`
                );
            }
            participants.set(participant.id, participant);
        },
        attach: (ctx): void => {
            for (const participant of ordered()) {
                participant.attach?.(ctx);
            }
        },
        connected: (): void => {
            for (const participant of ordered()) {
                participant.connected?.();
            }
        },
        detach: (ctx): void => {
            runLifecycleParticipantPhase(ordered(), 'detach', ctx);
        },
        disconnected: (): void => {
            runLifecycleParticipantPhase(ordered(), 'disconnected');
        }
    };
}

function runLifecycleParticipantPhase(
    participants: readonly RallarLifecycleParticipant[],
    phase: 'detach' | 'disconnected',
    ctx?: ApiMiddleware
): void {
    let firstError: Error | undefined;
    for (const participant of participants) {
        try {
            if (phase === 'detach') {
                participant.detach?.(ctx);
            }
            else {
                participant.disconnected?.();
            }
        }
        catch (error) {
            firstError ??= error instanceof Error
                ? error
                : new Error('Rallar lifecycle participant failed.');
        }
    }
    if (firstError !== undefined) {
        throw firstError;
    }
}
