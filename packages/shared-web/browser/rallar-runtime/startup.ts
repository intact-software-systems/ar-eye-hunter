import type { RallarAuthFacade } from '@shared-web/browser/rallar-auth-facade.ts';
import type {
    RallarConnectionOperations,
    RallarScopedOperationOptions,
    RallarSetupInput,
    RallarStartOptions,
    RallarStartResult
} from '@shared-web/browser/rallar-connection-facade.ts';
import type { RallarOperationOptions } from '@shared-web/browser/rallar-operation-options.ts';
import type { RallarPeopleState } from '@shared-web/browser/rallar-people-contracts.ts';
import type { RallarPeopleController } from '@shared-web/browser/rallar-runtime/people.ts';
import type { BrowserRallarRooms } from '@shared-web/browser/rooms/browser-rallar-rooms.ts';
import type { RallarRoomState } from '@shared-web/browser/rooms/rallar-room-contracts.ts';

export type CreateRallarStartupControllerOptions = Readonly<{
    connection: RallarConnectionOperations;
    auth: RallarAuthFacade;
    rooms: BrowserRallarRooms;
    people: RallarPeopleController['operations'];
    waitForAuthEnd(): Promise<void>;
    resolveOperationOptions<T extends RallarOperationOptions>(
        options: T
    ): T & RallarOperationOptions;
}>;

export type RallarStartupController = Readonly<{
    start(options?: RallarStartOptions): Promise<RallarStartResult>;
    setup(input: RallarSetupInput): Promise<RallarStartResult>;
}>;

export function createRallarStartupController(
    options: CreateRallarStartupControllerOptions
): RallarStartupController {
    const start = async (
        startOptions: RallarStartOptions = {}
    ): Promise<RallarStartResult> => {
        await options.waitForAuthEnd();
        const operationOptions = options.resolveOperationOptions(startOptions);
        const session = startOptions.restoreSession === false
            ? undefined
            : options.auth.restore();
        if (!session || startOptions.connect === false) {
            return { session, connected: false };
        }

        const middleware = await options.connection.connect(operationOptions);
        const refreshRooms = startOptions.refreshRooms ?? true;
        const refreshPeople = startOptions.refreshPeople ?? false;
        let roomState: RallarRoomState | undefined;
        let peopleState: RallarPeopleState | undefined;
        if (refreshRooms || refreshPeople) {
            const refreshOptions = toRefreshOptions(
                startOptions,
                operationOptions
            );
            if (refreshRooms) {
                roomState = await options.rooms.refresh(refreshOptions);
                if (refreshPeople) {
                    peopleState = options.people.state();
                }
            }
            else {
                peopleState = await options.people.refresh(refreshOptions);
            }
        }
        return {
            session,
            connected: true,
            middleware,
            roomState,
            peopleState
        };
    };

    return {
        start,
        setup: async (input: RallarSetupInput): Promise<RallarStartResult> => {
            const { apiBaseUrl, start: startDefaults, ...defaults } = input;
            options.connection.configure({ apiBaseUrl });
            options.connection.setDefaults(defaults);
            return await start({
                restoreSession: true,
                connect: true,
                refreshRooms: true,
                refreshPeople: false,
                ...startDefaults
            });
        }
    };
}

function toRefreshOptions(
    options: RallarStartOptions,
    operationOptions: RallarOperationOptions
): RallarScopedOperationOptions {
    return {
        ...(options.scope ? { scope: options.scope } : {}),
        ...(operationOptions.signal ? { signal: operationOptions.signal } : {}),
        ...(operationOptions.timeoutMs !== undefined
            ? { timeoutMs: operationOptions.timeoutMs }
            : {}),
        ...(operationOptions.maxAttempts !== undefined
            ? { maxAttempts: operationOptions.maxAttempts }
            : {}),
        ...(operationOptions.shouldRetry !== undefined
            ? { shouldRetry: operationOptions.shouldRetry }
            : {}),
        ...(operationOptions.dataChannelLanes !== undefined
            ? { dataChannelLanes: operationOptions.dataChannelLanes }
            : {}),
        ...(operationOptions.maxPeerConnections !== undefined
            ? { maxPeerConnections: operationOptions.maxPeerConnections }
            : {}),
        ...(operationOptions.rttReportingDegreeLimit !== undefined
            ? {
                rttReportingDegreeLimit: operationOptions.rttReportingDegreeLimit
            }
            : {})
    };
}
