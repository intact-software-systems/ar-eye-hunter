import type { GroupRef } from '@shared/api/group-types.ts';
import type {
    RallarDirectorAppointOptions,
    RallarDirectorRelayConfig,
    RallarDirectorRelayHandle,
    RallarDirectorResignOptions,
    RallarDirectorStatus,
    RallarDirectorStatusListener,
    RallarDirectorStatusOptions,
    RallarUnsubscribe,
} from '@shared-web/browser/rallar.ts';

export type RallarDirectorFacade = Readonly<{
    appoint(
        room?: string | GroupRef,
        options?: RallarDirectorAppointOptions,
    ): Promise<RallarDirectorStatus>;
    resign(
        room?: string | GroupRef,
        options?: RallarDirectorResignOptions,
    ): Promise<RallarDirectorStatus>;
    status(
        room?: string | GroupRef,
        options?: RallarDirectorStatusOptions,
    ): RallarDirectorStatus;
    onStatus(listener: RallarDirectorStatusListener): RallarUnsubscribe;
    createRelay<TIntent, TOutput, TSnapshot = TOutput>(
        config: RallarDirectorRelayConfig<TIntent, TOutput, TSnapshot>,
    ): RallarDirectorRelayHandle<TIntent, TOutput, TSnapshot>;
}>;

export type CreateRallarDirectorFacadeOptions = RallarDirectorFacade;

export function createRallarDirectorFacade(
    operations: CreateRallarDirectorFacadeOptions,
): RallarDirectorFacade {
    return {
        appoint: async (
            room,
            options = {},
        ): Promise<RallarDirectorStatus> =>
            await operations.appoint(room, options),
        resign: async (
            room,
            options = {},
        ): Promise<RallarDirectorStatus> =>
            await operations.resign(room, options),
        status: (
            room,
            options = {},
        ): RallarDirectorStatus => operations.status(room, options),
        onStatus: (listener): RallarUnsubscribe =>
            operations.onStatus(listener),
        createRelay: <TIntent, TOutput, TSnapshot = TOutput>(
            config: RallarDirectorRelayConfig<TIntent, TOutput, TSnapshot>,
        ): RallarDirectorRelayHandle<TIntent, TOutput, TSnapshot> =>
            operations.createRelay<TIntent, TOutput, TSnapshot>(config),
    };
}
