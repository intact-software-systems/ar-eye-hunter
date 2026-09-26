import {
    createRtcProviderFromClientFactory,
    type RtcClient,
    type RtcProvider
} from '../black-box-runner/rtc-provider.ts';
import { toRtcConnectionName } from '../black-box-runner/rtc/rtc-wait-expectations.ts';
import {
    toConnectCommand,
    toRunnerCommandId,
    toSendCommand,
    type RunnerCommandIdInput
} from './black-box-runner-adapter/to-runner-rtc-commands.ts';
import type {
    RallarBlackBoxTestCommandOutcome,
    RallarBlackBoxTestEvent,
    RallarBlackBoxTestJsonValue,
    RallarBlackBoxTestRecord,
    RallarBlackBoxTestResult,
    RallarBlackBoxTestRuntime
} from './rallar-black-box-test-contracts.ts';
import { decodeRecord } from './runtime/decode-runtime-result-values.ts';
import { isJsonRecordValue } from './schema/json-schema-validation.ts';

export interface RallarBlackBoxRtcClientAdapterOptions {
    readonly commandIdPrefix: string;
}

/** An RTC message a runner interaction observes: the JSON a send carried, or absent when the event carried none. */
type RallarBlackBoxRtcClientMessageListener = (message: RallarBlackBoxTestJsonValue | undefined) => void;

type RallarBlackBoxRtcClientCloseListener = (
    event: RallarBlackBoxTestJsonValue | RallarBlackBoxTestEvent
) => void;

interface RtcClientEventSubscriptionInput {
    readonly runtime: RallarBlackBoxTestRuntime;
    readonly connection: string;
    readonly matches: (event: RallarBlackBoxTestEvent) => boolean;
    readonly deliver: (event: RallarBlackBoxTestEvent) => void;
}

// The nine ALM kinds only exist inside a browser agent: this client owns an RTC connection, not a
// Rallar page runtime, so translating one of them into an rtc.send would hide the gap.
const BROWSER_ONLY_COMMAND_KINDS: ReadonlySet<string> = new Set([
    'messages.send',
    'messages.observe',
    'messages.cancel',
    'messages.received',
    'messages.receipts',
    'messages.control',
    'fault.inject',
    'storage.counters',
    'agent.reload'
]);

export function createRallarBlackBoxRtcProvider(
    runtime: RallarBlackBoxTestRuntime,
    options: RallarBlackBoxRtcClientAdapterOptions
): RtcProvider {
    return createRtcProviderFromClientFactory({
        createClient: (request) => createRallarBlackBoxRtcClient(runtime, decodeRecord(request), options)
    });
}

export function createRallarBlackBoxRtcClient(
    runtime: RallarBlackBoxTestRuntime,
    request: RallarBlackBoxTestRecord,
    options: RallarBlackBoxRtcClientAdapterOptions
): RtcClient {
    return new RallarBlackBoxRtcClientAdapter(runtime, request, options);
}

/** The runner's RTC client port reports a failed command by rejecting, so each operation throws the failure there. */
class RallarBlackBoxRtcClientAdapter implements RtcClient {
    private readonly runtime: RallarBlackBoxTestRuntime;
    private readonly request: RallarBlackBoxTestRecord;
    private readonly options: RallarBlackBoxRtcClientAdapterOptions;
    private readonly connection: string;
    private sequence = 1;
    private unsubscribeMessages: (() => void) | undefined;
    private unsubscribeClose: (() => void) | undefined;

    constructor(
        runtime: RallarBlackBoxTestRuntime,
        request: RallarBlackBoxTestRecord,
        options: RallarBlackBoxRtcClientAdapterOptions
    ) {
        this.runtime = runtime;
        this.request = request;
        this.options = options;
        this.connection = toRtcConnectionName(request);
    }

    async connect(): Promise<void> {
        const commandId = this.toNextCommandId('connect', this.request);
        const result = await this.runtime.execute(toConnectCommand(this.request, this.connection, commandId));
        if (!result.ok) {
            throw toCommandFailure(result);
        }
    }

    async send(
        message: RallarBlackBoxTestJsonValue,
        interaction?: RallarBlackBoxTestRecord
    ): Promise<RallarBlackBoxTestCommandOutcome | undefined> {
        const sendRequest = toInteractionRequest(interaction, this.request);
        const browserOnly = toBrowserOnlyCommandOutcome(sendRequest);
        if (browserOnly) {
            return browserOnly;
        }

        const commandId = this.toNextCommandId('send', sendRequest);
        const result = await this.runtime.execute(
            toSendCommand({ request: sendRequest, connection: this.connection, commandId, message, interaction })
        );
        if (!result.ok) {
            throw toCommandFailure(result);
        }
        return undefined;
    }

    async close(interaction?: RallarBlackBoxTestRecord): Promise<void> {
        const closeRequest = toInteractionRequest(interaction, this.request);
        const result = await this.runtime.execute({
            kind: 'close',
            commandId: this.toNextCommandId('close', closeRequest),
            metadata: {
                ...(closeRequest.parity ? { parity: closeRequest.parity } : {}),
                connection: this.connection,
                blackBoxRunner: closeRequest
            }
        });
        if (!result.ok) {
            throw toCommandFailure(result);
        }
        this.unsubscribeMessages?.();
        this.unsubscribeClose?.();
    }

    onMessage(listener: RallarBlackBoxRtcClientMessageListener): void {
        this.unsubscribeMessages?.();
        this.unsubscribeMessages = subscribeToRtcClientEvents({
            runtime: this.runtime,
            connection: this.connection,
            matches: (event) => event.kind === 'message',
            deliver: (event) => listener(toRtcMessage(event))
        });
    }

    onClose(listener: RallarBlackBoxRtcClientCloseListener): void {
        this.unsubscribeClose?.();
        this.unsubscribeClose = subscribeToRtcClientEvents({
            runtime: this.runtime,
            connection: this.connection,
            matches: (event) => event.kind === 'event' && event.topic.includes('close'),
            deliver: (event) => listener(decodeRtcMessagePayload(event.payload) ?? event)
        });
    }

    private toNextCommandId(action: RunnerCommandIdInput['action'], commandRequest: RallarBlackBoxTestRecord): string {
        return toRunnerCommandId({
            prefix: this.options.commandIdPrefix,
            connection: this.connection,
            action,
            sequence: this.sequence++,
            request: commandRequest
        });
    }
}

function toBrowserOnlyCommandOutcome(request: RallarBlackBoxTestRecord): RallarBlackBoxTestCommandOutcome | undefined {
    const named = typeof request.kind === 'string' ? request.kind : request.action;
    return typeof named === 'string' && BROWSER_ONLY_COMMAND_KINDS.has(named)
        ? { status: 'failed', error: { code: 'browser-only-command', message: `${named} requires a browser agent` } }
        : undefined;
}

function toInteractionRequest(
    interaction: RallarBlackBoxTestRecord | undefined,
    request: RallarBlackBoxTestRecord
): RallarBlackBoxTestRecord {
    return interaction?.request === undefined || interaction.request === null
        ? request
        : decodeRecord(interaction.request);
}

function toCommandFailure(result: RallarBlackBoxTestResult): Error {
    return new Error(result.error?.message ?? `Rallar black-box command failed: ${result.commandId}`);
}

function toRtcMessage(event: RallarBlackBoxTestEvent): RallarBlackBoxTestJsonValue | undefined {
    const payload = decodeRecord(event.payload);
    return decodeRtcMessagePayload(Object.hasOwn(payload, 'data') ? payload.data : event.payload);
}

/** Events already recorded when the listener subscribes are not delivered to it. */
function subscribeToRtcClientEvents(input: RtcClientEventSubscriptionInput): () => void {
    const seenEventIds = new Set(input.runtime.state().events.map((event) => event.eventId));
    return input.runtime.subscribe((state) => {
        state.events.forEach((event) => {
            if (
                seenEventIds.has(event.eventId) ||
                !input.matches(event) ||
                (event.connection && event.connection !== input.connection)
            ) {
                return;
            }

            seenEventIds.add(event.eventId);
            input.deliver(event);
        });
    });
}

function decodeRtcMessagePayload(value: unknown): RallarBlackBoxTestJsonValue | undefined {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null) {
        return value;
    }
    return Array.isArray(value) || isJsonRecordValue(value) ? value : undefined;
}
