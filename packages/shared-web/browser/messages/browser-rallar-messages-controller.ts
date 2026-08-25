import type { RallarCrdtMessageTransport } from '@shared-web/browser/crdt/browser-crdt-transport.ts';
import { createRallarCrdtMessageTransport } from '@shared-web/browser/crdt/create-rallar-crdt-message-transport.ts';
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
import type { ApiMiddleware } from '@shared-web/browser/rallar-connection-facade.ts';
import type { BrowserWebSocketInbox } from '@shared-web/browser/websocket/browser-websocket-inbox.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { RALLAR_DEFAULT_MAX_MESSAGE_PAYLOAD_BYTES } from '@shared/api/rallar-validation.ts';

export namespace BrowserRallarMessagesController {
    export interface Input {
        readonly wsInbox: BrowserWebSocketInbox;
        connect(): Promise<ApiMiddleware>;
        readMiddleware(): ApiMiddleware | undefined;
        requireSession(): AuthSession;
        resolveDefaultRoom(): string | GroupRef | undefined;
        resolveCurrentRoomRef(): GroupRef | undefined;
        toRoomId(room: string | GroupRef | undefined): string | undefined;
        resolveRoomRef(room: string | GroupRef | undefined): GroupRef | undefined;
        resolveRoomMinSnapshotVersion(
            room: string | GroupRef | undefined,
            explicitMinSnapshotVersion?: number
        ): number | undefined;
        resolveRoomPeerIds(room: string | GroupRef): readonly string[];
        readMessageMaxPayloadBytes?(): number;
    }
}

export class BrowserRallarMessagesController {
    public readonly sender: BrowserRallarMessageSender;
    public readonly subscriptions: BrowserRallarMessageSubscriptions;
    public readonly operations: RallarMessagesOperations;
    public readonly crdtTransport: RallarCrdtMessageTransport;

    public constructor(input: BrowserRallarMessagesController.Input) {
        const inputValidator = new BrowserMessageInputValidator({
            readMaxPayloadBytes: () =>
                input.readMessageMaxPayloadBytes?.() ??
                    RALLAR_DEFAULT_MAX_MESSAGE_PAYLOAD_BYTES
        });
        this.subscriptions = new BrowserRallarMessageSubscriptions({
            wsInbox: input.wsInbox,
            readMiddleware: input.readMiddleware
        });
        this.sender = new BrowserRallarMessageSender({
            inputValidator,
            connect: input.connect,
            requireSession: input.requireSession,
            resolveDefaultRoom: input.resolveDefaultRoom,
            resolveCurrentRoomRef: input.resolveCurrentRoomRef,
            toRoomId: input.toRoomId,
            resolveRoomRef: input.resolveRoomRef,
            resolveRoomMinSnapshotVersion: input.resolveRoomMinSnapshotVersion,
            resolveRoomPeerIds: input.resolveRoomPeerIds
        });

        const rtc: RallarMessagesOperations['rtc'] = {
            send: async <T>(sendInput: RallarRtcSendInput<T>) => await this.sender.sendRtc(sendInput),
            onMessage: <T>(
                selector: RallarMessageSelectorInput,
                handler: RallarMessageHandler<T>
            ) => this.subscriptions.subscribe('rtc', selector, handler)
        };
        const ws: RallarMessagesOperations['ws'] = {
            send: async <T>(sendInput: RallarWsSendInput<T>) => await this.sender.sendWs(sendInput),
            onMessage: <T>(
                selector: RallarMessageSelectorInput,
                handler: RallarMessageHandler<T>
            ) => this.subscriptions.subscribe('ws', selector, handler)
        };
        const channels = new BrowserTypedMessageChannels({
            inputValidator,
            rtc,
            ws
        });
        this.operations = {
            rtc,
            ws,
            channel: <T>(
                definition: RallarTypedMessageChannelDefinition
            ): RallarTypedMessageChannel<T> => channels.channel<T>(definition),
            room: <T>(
                definition: RallarRoomMessageChannelDefinition
            ): RallarTypedMessageChannel<T> => channels.room<T>(definition)
        };
        this.crdtTransport = createRallarCrdtMessageTransport(this.operations);
    }
}
