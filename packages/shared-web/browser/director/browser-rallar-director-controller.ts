import type { ApiMiddleware } from '@shared-web/browser/app-context.ts';
import { appointStateGroupDirector } from '@shared-web/browser/director/appoint-room-director.ts';
import type { BrowserRallarMessageSender } from '@shared-web/browser/messages/browser-rallar-message-sender.ts';
import type { RallarScopedOperationOptions } from '@shared-web/browser/rallar-connection-facade.ts';
import type {
    RallarDirectorAppointOptions,
    RallarDirectorFacade,
    RallarDirectorRelayConfig,
    RallarDirectorRelayHandle,
    RallarDirectorStatus
} from '@shared-web/browser/rallar-director-facade.ts';
import type { RallarMessageSendResult } from '@shared-web/browser/rallar-message-contracts.ts';
import type { RallarMessagesOperations } from '@shared-web/browser/messages/rallar-message-operations.ts';
import { toRallarWorkflowPolicies, type RallarOperationOptions } from '@shared-web/browser/rallar-operation-options.ts';
import type {
    RallarRealtimeFacade,
    RallarTargetedChannel,
    RallarTargetedChannelDefinition
} from '@shared-web/browser/rallar-realtime-facade.ts';
import type { RallarStateSnapshotAcceptanceInput } from '@shared-web/browser/rallar-runtime/state-store.ts';
import type { RallarUnsubscribe } from '@shared-web/browser/rallar-shared-contracts.ts';
import type { BrowserRallarRooms } from '@shared-web/browser/rooms/browser-rallar-rooms.ts';
import type { RallarRoomStateStorePort } from '@shared-web/browser/rooms/room-state-store.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import { toStateScope } from '@shared/api/api-type-utils.ts';
import {
    isRallarGroupDirectorForSession,
    mergeRallarGroupDirectorMetadata,
    readRallarGroupDirectorFromSnapshot
} from '@shared/api/group-director.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { BrowserDirectorRelayRuntime } from './browser-director-relay-runtime.ts';
import { BrowserDirectorRelayTransport } from './browser-director-relay-transport.ts';
import { BrowserDirectorStatusRuntime } from './browser-director-status-runtime.ts';

export interface BrowserRallarDirectorControllerInput {
    readonly roomStateStore: RallarRoomStateStorePort;
    readonly rooms: BrowserRallarRooms;
    readonly messages: RallarMessagesOperations;
    readonly realtime: RallarRealtimeFacade;
    readSession(): AuthSession | undefined;
    requireSession(): AuthSession;
    connect(options?: RallarOperationOptions): Promise<ApiMiddleware>;
    resolveOperationOptions<T extends RallarOperationOptions>(
        options: T
    ): T & RallarOperationOptions;
    resolveDefaultRoom(): string | GroupRef | undefined;
    runAuthAwareOperation<T>(operation: () => Promise<T>): Promise<T>;
    acceptSnapshots(input: RallarStateSnapshotAcceptanceInput): Promise<void>;
    createTargetedChannel<T>(
        definition: RallarTargetedChannelDefinition
    ): RallarTargetedChannel<T>;
    sendWsUnicast<T>(
        input: BrowserRallarMessageSender.WsUnicastInput<T>
    ): Promise<RallarMessageSendResult>;
}

export interface RallarDirectorController {
    readonly operations: RallarDirectorFacade;
    onStateChanged(): void;
    stopRelays(): void;
}

export class BrowserRallarDirectorController implements RallarDirectorController {
    public readonly operations: RallarDirectorFacade;

    private readonly input: BrowserRallarDirectorControllerInput;
    private readonly statusRuntime: BrowserDirectorStatusRuntime;
    private readonly relayRuntime: BrowserDirectorRelayRuntime;

    public constructor(input: BrowserRallarDirectorControllerInput) {
        this.input = input;
        this.statusRuntime = new BrowserDirectorStatusRuntime(input);
        const relayTransport = new BrowserDirectorRelayTransport(input);
        this.relayRuntime = new BrowserDirectorRelayRuntime({
            status: this.statusRuntime,
            transport: relayTransport,
            messages: input.messages,
            realtime: input.realtime,
            readSession: input.readSession
        });
        this.operations = {
            appoint: async (room, options) => await this.appoint(room, options),
            resign: async (room, options) => await this.resign(room, options),
            status: (room, options) => this.statusRuntime.read(room, options),
            onStatus: (listener) => this.statusRuntime.onStatus(listener),
            createRelay: (config) => this.createRelay(config)
        };
    }

    public onStateChanged(): void {
        this.statusRuntime.emit();
    }

    public stopRelays(): void {
        this.relayRuntime.stopAll();
    }

    private async appoint(
        room?: string | GroupRef,
        options: RallarDirectorAppointOptions = {}
    ): Promise<RallarDirectorStatus> {
        return await this.input.runAuthAwareOperation(async () => {
            const operationOptions = this.input.resolveOperationOptions(options);
            const context = await this.input.connect(operationOptions);
            const target = room ?? this.input.resolveDefaultRoom() ??
                this.input.roomStateStore.resolveCurrentRoomRef();
            const snapshot = this.statusRuntime.findSnapshot(target);
            const roomRef = this.statusRuntime.resolveRoomRef(target, snapshot);
            const roomId = this.input.roomStateStore.toRoomId(roomRef ?? target);
            if (!roomRef || !roomId) {
                throw new Error('Cannot appoint director: no room selected.');
            }
            const session = this.input.requireSession();
            const scope = options.scope ?? toStateScope(roomRef);
            const updated = await appointStateGroupDirector({
                groupId: roomId,
                request: { heartbeatTtlMs: options.heartbeatTtlMs },
                principalId: session.clientId,
                sessionId: session.sessionId,
                scope,
                policies: toRallarWorkflowPolicies(operationOptions)
            });
            await this.input.acceptSnapshots({
                context,
                clients: [],
                groups: [updated],
                scope
            });
            const appointment = readRallarGroupDirectorFromSnapshot(updated);
            if (appointment) {
                this.statusRuntime.recordHeartbeat(roomRef, appointment);
            }
            this.statusRuntime.emit();
            return this.statusRuntime.read(updated.group);
        });
    }

    private async resign(
        room?: string | GroupRef,
        options: RallarScopedOperationOptions = {}
    ): Promise<RallarDirectorStatus> {
        const target = room ?? this.input.resolveDefaultRoom() ??
            this.input.roomStateStore.resolveCurrentRoomRef();
        const snapshot = this.statusRuntime.findSnapshot(target);
        const roomRef = this.statusRuntime.resolveRoomRef(target, snapshot);
        const roomId = this.input.roomStateStore.toRoomId(roomRef ?? target);
        if (!roomRef || !roomId) {
            throw new Error('Cannot resign director: no room selected.');
        }
        const appointment = readRallarGroupDirectorFromSnapshot(snapshot);
        if (!isRallarGroupDirectorForSession(appointment, this.input.requireSession())) {
            return this.statusRuntime.read(roomRef);
        }
        const metadata = mergeRallarGroupDirectorMetadata(
            snapshot?.group.metadata,
            undefined
        );
        const updated = await this.input.rooms.updateMetadata(
            roomRef,
            metadata,
            options
        );
        this.statusRuntime.removeHeartbeat(roomRef);
        this.statusRuntime.emit();
        return this.statusRuntime.read(updated.group);
    }

    private createRelay<TIntent, TOutput, TSnapshot = TOutput>(
        config: RallarDirectorRelayConfig<TIntent, TOutput, TSnapshot>
    ): RallarDirectorRelayHandle<TIntent, TOutput, TSnapshot> {
        return this.relayRuntime.create(config);
    }
}
