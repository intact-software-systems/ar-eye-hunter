import type { RallarCrdtMessageTransport } from '@shared-web/browser/crdt/browser-crdt-transport.ts';
import { createRallarCrdtMessageTransport } from '@shared-web/browser/crdt/create-rallar-crdt-message-transport.ts';
import type { BrowserChannelRecoveryOwners } from '@shared-web/browser/messages/browser-channel-recovery-owners.ts';
import { BrowserMessageInputValidator } from '@shared-web/browser/messages/browser-message-input-validator.ts';
import { BrowserRallarMessageSender } from '@shared-web/browser/messages/browser-rallar-message-sender.ts';
import { BrowserRallarMessageSubscriptions } from '@shared-web/browser/messages/browser-rallar-message-subscriptions.ts';
import { BrowserTypedMessageChannels } from '@shared-web/browser/messages/browser-typed-message-channels.ts';
import type {
    RallarMessageHandler,
    RallarRoomMessageChannelDefinition,
    RallarRtcSendInput,
    RallarTypedMessageChannel,
    RallarTypedMessageChannelDefinition,
    RallarWsSendInput
} from '@shared-web/browser/messages/rallar-message-contracts.ts';
import type { RallarMessagesOperations } from '@shared-web/browser/messages/rallar-message-operations.ts';
import type { RallarMessageSelectorInput } from '@shared-web/browser/messages/rallar-message-selectors.ts';
import { BrowserMessageReplyInbox } from '@shared-web/browser/messages/reply/browser-message-reply-inbox.ts';
import type { RallarMessageReplySender } from '@shared-web/browser/messages/to-rallar-message.ts';
import type { ApiMiddleware } from '@shared-web/browser/rallar-connection-facade.ts';
import type { RallarOperationOptions } from '@shared-web/browser/rallar-operation-options.ts';
import type { RoomSendFence } from '@shared-web/browser/rooms/room-state-store.ts';
import type { BrowserWebSocketInbox } from '@shared-web/browser/websocket/browser-websocket-inbox.ts';
import type { ALInboundRuntimeDiagnosticsSink } from '@shared/alm/inbound/al-inbound-runtime-diagnostics.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import type { GroupRef } from '@shared/api/group-types.ts';

import type { BrowserRallarDeliveryRegistry } from './browser-rallar-delivery-registry.ts';
import { BrowserRallarMessageDispatch } from './browser-rallar-message-dispatch.ts';
import type { BrowserSessionDeliveries } from './browser-session-deliveries.ts';
import type { BrowserPublicationStages } from './publication/browser-publication-stages.ts';

export namespace BrowserRallarMessagesController {
    export interface Input {
        readonly creation: BrowserRallarMessageSender.Creation;
        readonly deliveries: BrowserRallarDeliveryRegistry;
        readonly sessionDeliveries: BrowserSessionDeliveries;
        readonly publicationStages: BrowserPublicationStages;
        readonly nowMs: () => number;
        readonly wsInbox: BrowserWebSocketInbox;
        /** Where `channel(...)` registers a definition's recovery owner, for the resync recovery to find. */
        readonly recoveryOwners: BrowserChannelRecoveryOwners;
        connect(capture?: Pick<RallarOperationOptions, 'rtcCaptureMode' | 'rtcCaptureContext'>): Promise<ApiMiddleware>;
        readMiddleware(): ApiMiddleware | undefined;
        requireMiddleware(): ApiMiddleware;
        requireSession(): AuthSession;
        resolveDefaultRoom(): string | GroupRef | undefined;
        resolveCurrentRoomRef(): GroupRef | undefined;
        toRoomId(room: string | GroupRef | undefined): string | undefined;
        resolveRoomRef(room: string | GroupRef | undefined): GroupRef | undefined;
        resolveRoomSendFence(room: string | GroupRef | undefined, explicitMinSnapshotVersion?: number): RoomSendFence;
        readMessageMaxPayloadBytes(): number;
        readPublicationPermissions: BrowserRallarMessageDispatch.Input['readPublicationPermissions'];
        /** The session's port, read when a reply is dropped. */
        readInboundDiagnostics(): ALInboundRuntimeDiagnosticsSink;
    }
}

export class BrowserRallarMessagesController {
    private readonly sender: BrowserRallarMessageSender;
    public readonly subscriptions: BrowserRallarMessageSubscriptions;
    public readonly operations: RallarMessagesOperations;
    public readonly crdtTransport: RallarCrdtMessageTransport;

    public constructor(input: BrowserRallarMessagesController.Input) {
        const inputValidator = new BrowserMessageInputValidator({
            readMaxPayloadBytes: input.readMessageMaxPayloadBytes
        });
        const sender = createMessageSender(input, inputValidator);
        this.sender = sender;
        const sendReply: RallarMessageReplySender = async (request, payload, options) =>
            await sender.sendReply(request, payload, options);
        this.subscriptions = new BrowserRallarMessageSubscriptions({
            wsInbox: input.wsInbox,
            sendReply,
            readMiddleware: input.readMiddleware,
            readInboundDiagnostics: input.readInboundDiagnostics
        });
        new BrowserMessageReplyInbox({
            wsInbox: input.wsInbox,
            deliveries: input.deliveries,
            sendReply,
            readInboundDiagnostics: input.readInboundDiagnostics
        }).start();

        this.operations = this.createOperations(
            inputValidator,
            input.recoveryOwners,
            () => {
                const context = input.requireMiddleware();
                return {
                    ...context.middleware.volatileBudget.readReport(input.nowMs()),
                    ...input.deliveries.getReplyCounts(),
                    publication: input.publicationStages.readReport(context)
                };
            }
        );
        this.crdtTransport = createRallarCrdtMessageTransport(this.operations);
    }

    private createOperations(
        inputValidator: BrowserMessageInputValidator,
        recoveryOwners: BrowserChannelRecoveryOwners,
        readUsage: RallarMessagesOperations['readUsage']
    ): RallarMessagesOperations {
        const rtc: RallarMessagesOperations['rtc'] = {
            send: async <T>(sendInput: RallarRtcSendInput<T>) => await this.sender.sendRtc(sendInput, undefined),
            onMessage: <T>(
                selector: RallarMessageSelectorInput,
                handler: RallarMessageHandler<T>
            ) => this.subscriptions.subscribe('rtc', selector, handler)
        };
        const ws: RallarMessagesOperations['ws'] = {
            send: async <T>(sendInput: RallarWsSendInput<T>) => await this.sender.sendWs(sendInput, undefined),
            onMessage: <T>(
                selector: RallarMessageSelectorInput,
                handler: RallarMessageHandler<T>
            ) => this.subscriptions.subscribe('ws', selector, handler)
        };
        const channels = new BrowserTypedMessageChannels({
            inputValidator,
            sender: this.sender,
            rtc,
            ws,
            recoveryOwners
        });
        return {
            rtc,
            ws,
            channel: <T>(
                definition: RallarTypedMessageChannelDefinition
            ): RallarTypedMessageChannel<T> => channels.channel<T>(definition),
            room: <T>(
                definition: RallarRoomMessageChannelDefinition
            ): RallarTypedMessageChannel<T> => channels.room<T>(definition),
            readUsage
        };
    }
}

function createMessageSender(
    input: BrowserRallarMessagesController.Input,
    inputValidator: BrowserMessageInputValidator
): BrowserRallarMessageSender {
    return new BrowserRallarMessageSender({
        creation: input.creation,
        deliveries: input.deliveries,
        dispatch: new BrowserRallarMessageDispatch({
            deliveries: input.deliveries,
            sessionDeliveries: input.sessionDeliveries,
            publicationStages: input.publicationStages,
            nowMs: input.nowMs,
            readPublicationPermissions: input.readPublicationPermissions
        }),
        sessionDeliveries: input.sessionDeliveries,
        inputValidator,
        connect: input.connect,
        requireSession: input.requireSession,
        resolveDefaultRoom: input.resolveDefaultRoom,
        resolveCurrentRoomRef: input.resolveCurrentRoomRef,
        toRoomId: input.toRoomId,
        resolveRoomRef: input.resolveRoomRef,
        resolveRoomSendFence: input.resolveRoomSendFence
    });
}
