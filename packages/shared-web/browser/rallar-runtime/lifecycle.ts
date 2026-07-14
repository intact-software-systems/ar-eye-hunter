import type {
    RallarLifecycleCoordinator,
    RallarLifecycleParticipant,
} from '@shared-web/browser/rallar-runtime/contracts.ts';

export type {
    RallarLifecycleCoordinator,
    RallarLifecycleParticipant
} from '@shared-web/browser/rallar-runtime/contracts.ts';

export function createRallarLifecycleCoordinator(): RallarLifecycleCoordinator {
    const participants = new Map<string, RallarLifecycleParticipant>();

    const ordered = (): readonly RallarLifecycleParticipant[] =>
        [...participants.values()].sort((left, right) =>
            left.order - right.order
        );

    return {
        register: (participant): void => {
            if (participants.has(participant.id)) {
                throw new Error(
                    `Duplicate Rallar lifecycle participant: ${participant.id}`,
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
            for (const participant of ordered()) {
                participant.detach?.(ctx);
            }
        },
        disconnected: (): void => {
            for (const participant of ordered()) {
                participant.disconnected?.();
            }
        },
    };
}
