import type { ApiMiddleware } from '@shared-web/browser/rallar-connection-facade.ts';

/** Why a connection ended: the session's own disconnect, or its server clock's lifetime, with the reason that ended it. */
export type RallarConnectionEnd =
    | Readonly<{ kind: 'disconnect'; }>
    | Readonly<{ kind: 'server-clock-ended'; reason: string; }>;

/** One ordered participant in the browser session connect/disconnect lifecycle. */
export interface RallarLifecycleParticipant {
    readonly id: string;
    readonly order: number;
    attach?(ctx: ApiMiddleware): void;
    connected?(): void;
    detach?(ctx?: ApiMiddleware): void;
    disconnected?(end: RallarConnectionEnd): void;
}

export interface RallarLifecycleCoordinator {
    register(participant: RallarLifecycleParticipant): void;
    attach(ctx: ApiMiddleware): void;
    connected(): void;
    detach(ctx?: ApiMiddleware): void;
    disconnected(end: RallarConnectionEnd): void;
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
            runLifecycleParticipantPhase(ordered(), (participant) => participant.detach?.(ctx));
        },
        disconnected: (end): void => {
            runLifecycleParticipantPhase(ordered(), (participant) => participant.disconnected?.(end));
        }
    };
}

function runLifecycleParticipantPhase(
    participants: readonly RallarLifecycleParticipant[],
    phase: (participant: RallarLifecycleParticipant) => void
): void {
    let firstError: Error | undefined;
    for (const participant of participants) {
        try {
            phase(participant);
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
