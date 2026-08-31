import type { RallarMessagePayload } from '@shared-web/browser/messages/rallar-message-contracts.ts';
import type {
    RallarDirectorRelayHandle,
    RallarDirectorRelayMessage,
    RallarDirectorStatus
} from '@shared-web/browser/rallar.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { toError } from '@shared/resilience/to-error.ts';

import type { BlackBoxRallarRuntimeDiagnostics } from './black-box-rallar-diagnostics.ts';
import type {
    BlackBoxRallarConnectionConfig,
    BlackBoxRallarDirectorAppointInput,
    BlackBoxRallarDirectorCommandDiagnostics,
    BlackBoxRallarDirectorHandleInput,
    BlackBoxRallarDirectorIntentInput,
    BlackBoxRallarDirectorOutputRecord,
    BlackBoxRallarDirectorRelayStartInput,
    BlackBoxRallarDirectorRelaySummary,
    BlackBoxRallarDirectorRoomInput,
    BlackBoxRallarDirectorStatusInput,
    BlackBoxRallarDirectorSyncRequestInput,
    BlackBoxRallarEvent,
    BlackBoxRallarSendInput,
    BlackBoxRallarTransport,
    ResolvedBlackBoxRallarScope
} from './black-box-rallar-operation-contracts.ts';
import type { BlackBoxRallarScopeDiagnostics } from './black-box-rallar-operation-policy.ts';
import type {
    BlackBoxBrowserDirectorDependency,
    BlackBoxBrowserRoomsDependency
} from './browser-rallar-runtime-composition.ts';
import { decodeBlackBoxCommandRoomRef, decodeBlackBoxCommandScope } from './decode-black-box-rallar-command-input.ts';
import type { BlackBoxRallarGenerationPort } from './ports.ts';

export interface BlackBoxRallarDirectorLease {
    readonly generation: number;
}

export class BlackBoxRallarDirectorResourceController<TRelay> {
    readonly #generation: BlackBoxRallarGenerationPort;
    readonly #relays = new Map<string, TRelay>();
    constructor(generation: BlackBoxRallarGenerationPort) {
        this.#generation = generation;
    }
    lease(): BlackBoxRallarDirectorLease {
        return { generation: this.#generation.generation() };
    }
    assertCurrent(lease: BlackBoxRallarDirectorLease, message: string): void {
        if (!this.#generation.isCurrent(lease.generation)) {
            throw new Error(message);
        }
    }
    add(handle: string, relay: TRelay): void {
        if (this.#relays.has(handle)) {
            throw new Error('Director relay handle is already active: ' + handle);
        }
        this.#relays.set(handle, relay);
    }
    require(handle: string): TRelay {
        const relay = this.#relays.get(handle);
        if (relay === undefined) {
            throw new Error('Director relay handle is not active: ' + handle);
        }
        return relay;
    }
    take(handle: string): TRelay {
        const relay = this.require(handle);
        this.#relays.delete(handle);
        return relay;
    }
    delete(handle: string): boolean {
        return this.#relays.delete(handle);
    }
    entries(): readonly (readonly [string, TRelay])[] {
        return [...this.#relays.entries()];
    }
    handles(): readonly string[] {
        return [...this.#relays.keys()];
    }
}

interface DirectorAcceptedIntent {
    readonly intentId: string;
    readonly senderId: string;
    readonly epoch: number | undefined;
    readonly receivedAtEpochMs: number;
    readonly payload: unknown;
}
interface DirectorSyncRequest {
    readonly senderId: string;
    readonly epoch: number | undefined;
    readonly receivedAtEpochMs: number;
    readonly payload: RallarMessagePayload;
}
interface DirectorRelayObservations {
    readonly acceptedIntents: DirectorAcceptedIntent[];
    readonly outputs: BlackBoxRallarDirectorOutputRecord[];
    readonly snapshots: unknown[];
    readonly syncRequests: DirectorSyncRequest[];
    sequence: number;
}
interface DirectorRelayContext {
    readonly input: BlackBoxRallarDirectorRelayStartInput;
    readonly config: BlackBoxRallarConnectionConfig;
    readonly lease: BlackBoxRallarDirectorLease;
    readonly observations: DirectorRelayObservations;
}
interface DirectorRelayState {
    readonly handle: string;
    readonly input: BlackBoxRallarDirectorRelayStartInput;
    readonly relay: RallarDirectorRelayHandle<unknown, BlackBoxRallarDirectorOutputRecord, unknown>;
    readonly observations: DirectorRelayObservations;
}
interface DirectorRelaySnapshot extends DirectorRelayObservations {
    readonly handle: string;
    readonly status: RallarDirectorStatus;
    readonly generatedAtEpochMs: number;
}
interface DirectorStaticSnapshot {
    readonly handle: string;
    readonly static: true;
    readonly status: RallarDirectorStatus;
    readonly snapshot: unknown;
}

interface DirectorFacade {
    readonly director: BlackBoxBrowserDirectorDependency;
    readonly rooms: BlackBoxBrowserRoomsDependency;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readDirectorCommandRecord(value: unknown): Record<string, unknown> {
    return isRecord(value) ? value : {};
}

function optionalRecord(value: unknown): Record<string, unknown> | undefined {
    return isRecord(value) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
    const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : undefined;
    return parsed !== undefined && Number.isFinite(parsed) ? parsed : undefined;
}

function normalizeDirectorRoomInput(input: unknown): BlackBoxRallarDirectorRoomInput {
    const record = readDirectorCommandRecord(input);
    const rallarConfig = readDirectorCommandRecord(record.rallar);
    const scope = optionalRecord(record.scope) ?? optionalRecord(rallarConfig.scope);
    const roomRef = optionalRecord(record.roomRef) ?? optionalRecord(rallarConfig.roomRef);
    return {
        roomId: stringValue(record.roomId) ?? stringValue(record.groupId) ?? stringValue(rallarConfig.roomId),
        applicationId: stringValue(record.applicationId) ?? stringValue(rallarConfig.applicationId),
        workspaceId: stringValue(record.workspaceId) ?? stringValue(rallarConfig.workspaceId),
        scope: decodeBlackBoxCommandScope(scope),
        roomRef: decodeBlackBoxCommandRoomRef(roomRef),
        timeoutMs: optionalNumber(record.timeoutMs)
    };
}

function normalizeDirectorAppointInput(input: unknown): BlackBoxRallarDirectorAppointInput {
    const record = readDirectorCommandRecord(input);
    return {
        ...normalizeDirectorRoomInput(record),
        heartbeatTtlMs: optionalNumber(record.heartbeatTtlMs)
    };
}

function normalizeDirectorStatusInput(input: unknown): BlackBoxRallarDirectorStatusInput {
    const record = readDirectorCommandRecord(input);
    return {
        ...normalizeDirectorRoomInput(record),
        refresh: typeof record.refresh === 'boolean' ? record.refresh : undefined,
        now: optionalNumber(record.now)
    };
}

function normalizeDirectorRelayStartInput(input: unknown): BlackBoxRallarDirectorRelayStartInput {
    const record = readDirectorCommandRecord(input);
    const handle = stringValue(record.handle);
    const intentTypeId = stringValue(record.intentTypeId);
    const outputTypeId = stringValue(record.outputTypeId);
    if (!handle || !intentTypeId || !outputTypeId) {
        throw new Error('director.relay.start requires handle, intentTypeId, and outputTypeId.');
    }
    return {
        ...normalizeDirectorRoomInput(record),
        handle,
        laneId: stringValue(record.laneId),
        topicId: stringValue(record.topicId),
        intentTypeId,
        outputTypeId,
        heartbeatTypeId: stringValue(record.heartbeatTypeId),
        snapshotTypeId: stringValue(record.snapshotTypeId),
        syncRequestTypeId: stringValue(record.syncRequestTypeId),
        heartbeatIntervalMs: optionalNumber(record.heartbeatIntervalMs),
        snapshotIntervalMs: optionalNumber(record.snapshotIntervalMs),
        ...(Object.prototype.hasOwnProperty.call(record, 'snapshot') ? { snapshot: record.snapshot } : {})
    };
}

function normalizeDirectorHandleInput(input: unknown): BlackBoxRallarDirectorHandleInput {
    const record = readDirectorCommandRecord(input);
    const handle = stringValue(record.handle);
    if (!handle) {
        throw new Error('Director relay command requires handle.');
    }
    return { handle, timeoutMs: optionalNumber(record.timeoutMs) };
}

function normalizeDirectorIntentInput(input: unknown): BlackBoxRallarDirectorIntentInput {
    const record = readDirectorCommandRecord(input);
    return { ...normalizeDirectorHandleInput(record), intent: record.intent };
}

function normalizeDirectorSyncRequestInput(input: unknown): BlackBoxRallarDirectorSyncRequestInput {
    const record = readDirectorCommandRecord(input);
    return { ...normalizeDirectorHandleInput(record), payload: record.payload };
}

function intentIdFromPayload(payload: unknown, fallback: string): string {
    const record = readDirectorCommandRecord(payload);
    return stringValue(record.intentId) ?? stringValue(record.id) ?? stringValue(record.messageId) ?? fallback;
}

interface DirectorStatusDiagnosticsInput {
    readonly status: BlackBoxRallarDirectorCommandDiagnostics['status'];
    readonly input: BlackBoxRallarDirectorRoomInput;
    readonly directorStatus: RallarDirectorStatus;
    readonly config: BlackBoxRallarConnectionConfig;
    readonly extra?: Pick<
        BlackBoxRallarDirectorCommandDiagnostics,
        'handle' | 'relay' | 'sendResult' | 'acceptedIntentCount' | 'outputCount' | 'snapshotCount' | 'syncRequestCount'
    >;
}
interface DirectorDiagnosticInput {
    readonly topic: string;
    readonly handle: string | undefined;
    readonly data: object;
    readonly config: BlackBoxRallarConnectionConfig;
}

export namespace BlackBoxRallarDirectorController {
    export interface Input extends BlackBoxRallarGenerationPort {
        readonly facade: DirectorFacade;
        now(): number;
        requireConfig(): BlackBoxRallarConnectionConfig;
        transportOf(config: BlackBoxRallarConnectionConfig): BlackBoxRallarTransport;
        roomRefOf(
            config: BlackBoxRallarConnectionConfig,
            input?: BlackBoxRallarSendInput
        ): GroupRef | undefined;
        scopeOf(
            config: BlackBoxRallarConnectionConfig,
            input?: BlackBoxRallarSendInput
        ): ResolvedBlackBoxRallarScope | undefined;
        scopeDiagnostics(config: BlackBoxRallarConnectionConfig): BlackBoxRallarScopeDiagnostics;
        emit(event: Omit<BlackBoxRallarEvent, 'atEpochMs'>): void;
        readonly emitError: BlackBoxRallarRuntimeDiagnostics['emitError'];
    }
}
export class BlackBoxRallarDirectorController {
    readonly #options: BlackBoxRallarDirectorController.Input;
    readonly #resources: BlackBoxRallarDirectorResourceController<DirectorRelayState>;
    constructor(options: BlackBoxRallarDirectorController.Input) {
        this.#options = options;
        this.#resources = new BlackBoxRallarDirectorResourceController(options);
    }
    private assertCurrent = (lease: BlackBoxRallarDirectorLease): void => {
        this.#resources.assertCurrent(lease, 'Director operation completed after the runtime closed.');
    };
    private toTarget = (
        input: BlackBoxRallarDirectorRoomInput,
        config: BlackBoxRallarConnectionConfig
    ): string | GroupRef | undefined => this.#options.roomRefOf(config, input) ?? input.roomId ?? config.roomId;
    private statusDiagnostics = (request: DirectorStatusDiagnosticsInput): BlackBoxRallarDirectorCommandDiagnostics => {
        const { status, input, directorStatus, config, extra } = request;
        const roomRef = this.#options.roomRefOf(config, input);
        return {
            status,
            roomId: input.roomId ?? roomRef?.groupId ?? config.roomId ?? directorStatus.roomId,
            ...(roomRef ? { roomRef } : {}),
            role: directorStatus.role,
            state: directorStatus.state,
            isDirector: directorStatus.isDirector,
            isFresh: directorStatus.isFresh,
            appointment: directorStatus.appointment,
            directorStatus,
            ...extra
        };
    };
    private emitDiagnostic = (request: DirectorDiagnosticInput): void => {
        const { topic, handle, data, config } = request;
        this.#options.emit({
            kind: 'diagnostic',
            topic,
            connection: config.connection,
            actor: config.actor,
            transport: this.#options.transportOf(config),
            roomId: config.roomId,
            ...this.#options.scopeDiagnostics(config),
            data: {
                ...(handle ? { handle } : {}),
                ...data
            }
        });
    };
    private relaySnapshot = (context: DirectorRelayContext): DirectorRelaySnapshot | DirectorStaticSnapshot => {
        const status = this.#options.facade.director.status(this.toTarget(context.input, context.config));
        return context.input.snapshot !== undefined
            ? { handle: context.input.handle, static: true, status, snapshot: context.input.snapshot }
            : {
                handle: context.input.handle,
                status,
                ...context.observations,
                generatedAtEpochMs: this.#options.now()
            };
    };
    private requireRelay = (handle: string): DirectorRelayState => {
        try {
            return this.#resources.require(handle);
        }
        catch {
            throw new Error('Director relay handle is not open: ' + handle);
        }
    };
    appoint = async (input: unknown): Promise<BlackBoxRallarDirectorCommandDiagnostics> => {
        const config = this.#options.requireConfig();
        const lease = this.#resources.lease();
        this.assertCurrent(lease);
        const normalized = normalizeDirectorAppointInput(input);
        const directorStatus = await this.#options.facade.director.appoint(this.toTarget(normalized, config), {
            heartbeatTtlMs: normalized.heartbeatTtlMs,
            scope: this.#options.scopeOf(config, normalized),
            timeoutMs: normalized.timeoutMs
        });
        this.assertCurrent(lease);
        const diagnostics = this.statusDiagnostics({
            status: 'appointed',
            input: normalized,
            directorStatus: directorStatus,
            config: config
        });
        this.emitDiagnostic({
            topic: 'rallar.browser.director.appointed',
            handle: undefined,
            data: diagnostics,
            config: config
        });
        return diagnostics;
    };
    resign = async (input: unknown): Promise<BlackBoxRallarDirectorCommandDiagnostics> => {
        const config = this.#options.requireConfig();
        const lease = this.#resources.lease();
        this.assertCurrent(lease);
        const normalized = normalizeDirectorRoomInput(input);
        const directorStatus = await this.#options.facade.director.resign(this.toTarget(normalized, config), {
            scope: this.#options.scopeOf(config, normalized),
            timeoutMs: normalized.timeoutMs
        });
        this.assertCurrent(lease);
        const diagnostics = this.statusDiagnostics({
            status: 'resigned',
            input: normalized,
            directorStatus: directorStatus,
            config: config
        });
        this.emitDiagnostic({
            topic: 'rallar.browser.director.resigned',
            handle: undefined,
            data: diagnostics,
            config: config
        });
        return diagnostics;
    };
    status = async (input: unknown): Promise<BlackBoxRallarDirectorCommandDiagnostics> => {
        const config = this.#options.requireConfig();
        const lease = this.#resources.lease();
        this.assertCurrent(lease);
        const normalized = normalizeDirectorStatusInput(input);
        if (normalized.refresh) {
            await this.#options.facade.rooms.refresh({
                scope: this.#options.scopeOf(config, normalized),
                timeoutMs: normalized.timeoutMs
            });
        }
        this.assertCurrent(lease);
        const directorStatus = this.#options.facade.director.status(this.toTarget(normalized, config), {
            now: normalized.now
        });
        const diagnostics = this.statusDiagnostics({
            status: 'status',
            input: normalized,
            directorStatus: directorStatus,
            config: config
        });
        this.emitDiagnostic({
            topic: 'rallar.browser.director.status',
            handle: undefined,
            data: diagnostics,
            config: config
        });
        return diagnostics;
    };
    private createRelay(
        context: DirectorRelayContext
    ): RallarDirectorRelayHandle<unknown, BlackBoxRallarDirectorOutputRecord, unknown> {
        return this.#options.facade.director.createRelay({
            roomId: context.input.roomId ?? context.config.roomId,
            roomRef: this.#options.roomRefOf(context.config, context.input),
            laneId: context.input.laneId,
            topicId: context.input.topicId,
            intentTypeId: context.input.intentTypeId,
            outputTypeId: context.input.outputTypeId,
            heartbeatTypeId: context.input.heartbeatTypeId,
            snapshotTypeId: context.input.snapshotTypeId,
            syncRequestTypeId: context.input.syncRequestTypeId,
            heartbeatIntervalMs: context.input.heartbeatIntervalMs,
            snapshotIntervalMs: context.input.snapshotIntervalMs,
            readSnapshot: () => this.relaySnapshot(context),
            onIntent: (message, relay) => this.receiveIntent(context, message, relay),
            onOutput: (message) => this.receiveOutput(context, message),
            onSnapshot: (message) => this.receiveSnapshot(context, message),
            onSyncRequest: (message) => this.receiveSyncRequest(context, message)
        });
    }
    private receiveIntent(
        context: DirectorRelayContext,
        message: RallarDirectorRelayMessage<unknown>,
        relay: RallarDirectorRelayHandle<unknown, BlackBoxRallarDirectorOutputRecord, unknown>
    ): BlackBoxRallarDirectorOutputRecord {
        this.assertCurrent(context.lease);
        const nextSequence = context.observations.sequence + 1;
        const output: BlackBoxRallarDirectorOutputRecord = {
            kind: 'black-box-director-output',
            intentId: intentIdFromPayload(message.data, `intent-${nextSequence}`),
            sequence: nextSequence,
            senderId: message.senderId,
            directorSessionId: relay.status().appointment?.sessionId,
            directorPrincipalId: relay.status().appointment?.principalId,
            epoch: message.envelope.epoch,
            receivedAtEpochMs: message.receivedAtEpochMs,
            payload: message.data
        };
        context.observations.sequence = nextSequence;
        context.observations.acceptedIntents.push({
            intentId: output.intentId,
            senderId: message.senderId,
            epoch: message.envelope.epoch,
            receivedAtEpochMs: message.receivedAtEpochMs,
            payload: message.data
        });
        context.observations.outputs.push(output);
        this.emitDiagnostic({
            topic: 'rallar.browser.director.intent_received',
            handle: context.input.handle,
            data: {
                intent: context.observations.acceptedIntents.at(-1),
                output
            },
            config: context.config
        });
        return output;
    }
    private receiveOutput(
        context: DirectorRelayContext,
        message: RallarDirectorRelayMessage<BlackBoxRallarDirectorOutputRecord>
    ): void {
        this.assertCurrent(context.lease);
        context.observations.outputs.push(message.data);
        this.emitDiagnostic({
            topic: 'rallar.browser.director.output_received',
            handle: context.input.handle,
            data: {
                output: message.data,
                senderId: message.senderId,
                epoch: message.envelope.epoch,
                receivedAtEpochMs: message.receivedAtEpochMs
            },
            config: context.config
        });
    }
    private receiveSnapshot(context: DirectorRelayContext, message: RallarDirectorRelayMessage<unknown>): void {
        this.assertCurrent(context.lease);
        context.observations.snapshots.push(message.data);
        this.emitDiagnostic({
            topic: 'rallar.browser.director.snapshot_received',
            handle: context.input.handle,
            data: {
                snapshot: message.data,
                senderId: message.senderId,
                epoch: message.envelope.epoch,
                receivedAtEpochMs: message.receivedAtEpochMs
            },
            config: context.config
        });
    }
    private receiveSyncRequest(
        context: DirectorRelayContext,
        message: RallarDirectorRelayMessage<RallarMessagePayload>
    ): void {
        this.assertCurrent(context.lease);
        context.observations.syncRequests.push({
            senderId: message.senderId,
            epoch: message.envelope.epoch,
            receivedAtEpochMs: message.receivedAtEpochMs,
            payload: message.data
        });
        this.emitDiagnostic({
            topic: 'rallar.browser.director.sync_request_received',
            handle: context.input.handle,
            data: {
                syncRequest: context.observations.syncRequests.at(-1)
            },
            config: context.config
        });
    }

    relayStart = async (input: unknown): Promise<BlackBoxRallarDirectorCommandDiagnostics> => {
        const config = this.#options.requireConfig();
        const lease = this.#resources.lease();
        this.assertCurrent(lease);
        const normalized = normalizeDirectorRelayStartInput(input);
        if (this.#resources.handles().includes(normalized.handle)) {
            throw new Error('Director relay handle is already open: ' + normalized.handle);
        }
        const observations: DirectorRelayObservations = {
            acceptedIntents: [],
            outputs: [],
            snapshots: [],
            syncRequests: [],
            sequence: 0
        };
        const relay = this.createRelay({ input: normalized, config, lease, observations });
        const entry: DirectorRelayState = { handle: normalized.handle, input: normalized, relay, observations };
        this.#resources.add(normalized.handle, entry);
        const diagnostics = this.statusDiagnostics({
            status: 'relay_started',
            input: normalized,
            directorStatus: relay.status(),
            config: config,
            extra: {
                handle: normalized.handle,
                relay: {
                    handle: normalized.handle,
                    topicId: normalized.topicId,
                    intentTypeId: normalized.intentTypeId,
                    outputTypeId: normalized.outputTypeId,
                    heartbeatTypeId: normalized.heartbeatTypeId,
                    snapshotTypeId: normalized.snapshotTypeId,
                    syncRequestTypeId: normalized.syncRequestTypeId
                }
            }
        });
        this.emitDiagnostic({
            topic: 'rallar.browser.director.relay_started',
            handle: normalized.handle,
            data: diagnostics,
            config: config
        });
        return diagnostics;
    };
    intent = async (input: unknown): Promise<BlackBoxRallarDirectorCommandDiagnostics> => {
        const config = this.#options.requireConfig();
        const lease = this.#resources.lease();
        this.assertCurrent(lease);
        const normalized = normalizeDirectorIntentInput(input);
        const relay = this.requireRelay(normalized.handle);
        const sendResult = await relay.relay.sendIntent(normalized.intent);
        this.assertCurrent(lease);
        const diagnostics = this.statusDiagnostics({
            status: 'intent_sent',
            input: relay.input,
            directorStatus: relay.relay.status(),
            config: config,
            extra: {
                handle: normalized.handle,
                sendResult
            }
        });
        this.emitDiagnostic({
            topic: 'rallar.browser.director.intent_sent',
            handle: normalized.handle,
            data: {
                ...diagnostics,
                intent: normalized.intent
            },
            config: config
        });
        return diagnostics;
    };
    syncRequest = async (input: unknown): Promise<BlackBoxRallarDirectorCommandDiagnostics> => {
        const config = this.#options.requireConfig();
        const lease = this.#resources.lease();
        this.assertCurrent(lease);
        const normalized = normalizeDirectorSyncRequestInput(input);
        const relay = this.requireRelay(normalized.handle);
        const sendResult = await relay.relay.requestSync(normalized.payload);
        this.assertCurrent(lease);
        const diagnostics = this.statusDiagnostics({
            status: 'sync_requested',
            input: relay.input,
            directorStatus: relay.relay.status(),
            config: config,
            extra: {
                handle: normalized.handle,
                sendResult
            }
        });
        this.emitDiagnostic({
            topic: 'rallar.browser.director.sync_requested',
            handle: normalized.handle,
            data: {
                ...diagnostics,
                payload: normalized.payload
            },
            config: config
        });
        return diagnostics;
    };
    relayStop = async (input: unknown): Promise<BlackBoxRallarDirectorCommandDiagnostics> => {
        const config = this.#options.requireConfig();
        const lease = this.#resources.lease();
        this.assertCurrent(lease);
        const normalized = normalizeDirectorHandleInput(input);
        const relay = this.requireRelay(normalized.handle);
        const status = relay.relay.status();
        relay.relay.stop();
        this.#resources.delete(normalized.handle);
        const diagnostics = this.statusDiagnostics({
            status: 'relay_stopped',
            input: relay.input,
            directorStatus: status,
            config: config,
            extra: {
                handle: normalized.handle,
                acceptedIntentCount: relay.observations.acceptedIntents.length,
                outputCount: relay.observations.outputs.length,
                snapshotCount: relay.observations.snapshots.length,
                syncRequestCount: relay.observations.syncRequests.length
            }
        });
        this.emitDiagnostic({
            topic: 'rallar.browser.director.relay_stopped',
            handle: normalized.handle,
            data: diagnostics,
            config: config
        });
        return diagnostics;
    };
    summary = (): BlackBoxRallarDirectorRelaySummary => ({
        handles: this.#resources.handles(),
        relays: this.#resources.entries().map(([, entry]) => ({
            handle: entry.handle,
            roomId: entry.input.roomId,
            topicId: entry.input.topicId,
            intentTypeId: entry.input.intentTypeId,
            outputTypeId: entry.input.outputTypeId,
            acceptedIntentCount: entry.observations.acceptedIntents.length,
            outputCount: entry.observations.outputs.length,
            snapshotCount: entry.observations.snapshots.length,
            syncRequestCount: entry.observations.syncRequests.length,
            status: entry.relay.status()
        }))
    });
    closeAll = (config?: BlackBoxRallarConnectionConfig): readonly Error[] => {
        const errors: Error[] = [];
        for (const [handle, relay] of this.#resources.entries()) {
            try {
                relay.relay.stop();
                this.#resources.delete(handle);
                if (config) {
                    this.emitDiagnostic({
                        topic: 'rallar.browser.director.relay_stopped',
                        handle: handle,
                        data: {
                            status: 'relay_stopped',
                            handle,
                            reason: 'runtime-close',
                            acceptedIntentCount: relay.observations.acceptedIntents.length,
                            outputCount: relay.observations.outputs.length,
                            snapshotCount: relay.observations.snapshots.length,
                            syncRequestCount: relay.observations.syncRequests.length
                        },
                        config: config
                    });
                }
            }
            catch (caught) {
                const error = toError(caught);
                errors.push(error);
                this.#options.emitError({
                    config: config,
                    topic: 'rallar.browser.director.relay_stop_failed',
                    error: error,
                    data: {
                        handle,
                        reason: 'runtime-close'
                    }
                });
            }
        }
        return errors;
    };
}
