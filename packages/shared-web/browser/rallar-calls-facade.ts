import type {
    RallarCallHandle,
    RallarCallInviteInput,
    RallarCallInviteListener,
    RallarCallInviteResult,
    RallarCallSignalListener,
    RallarCallStartInput,
    RallarUnsubscribe,
} from '@shared-web/browser/rallar.ts';

export type RallarCallsFacade = Readonly<{
    start(input: RallarCallStartInput): Promise<RallarCallHandle>;
    invite(input: RallarCallInviteInput): Promise<RallarCallInviteResult>;
    onInvite(listener: RallarCallInviteListener): RallarUnsubscribe;
    onSignal(listener: RallarCallSignalListener): RallarUnsubscribe;
}>;

export type CreateRallarCallsFacadeOptions = RallarCallsFacade;

export function createRallarCallsFacade(
    operations: CreateRallarCallsFacadeOptions,
): RallarCallsFacade {
    return {
        start: async (input): Promise<RallarCallHandle> =>
            await operations.start(input),
        invite: async (input): Promise<RallarCallInviteResult> =>
            await operations.invite(input),
        onInvite: (listener): RallarUnsubscribe =>
            operations.onInvite(listener),
        onSignal: (listener): RallarUnsubscribe =>
            operations.onSignal(listener),
    };
}
