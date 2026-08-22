import type {
    RallarDirectorRelayHandle,
    RallarDirectorRelayMessage,
    RallarDirectorStatus,
    RallarFacade
} from '@shared-web/browser/rallar.ts';
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
    BlackBoxRallarDirectorRuntime,
    BlackBoxRallarDirectorStatusInput,
    BlackBoxRallarDirectorSyncRequestInput,
    BlackBoxRallarEvent,
    BlackBoxRallarRoomRef,
    BlackBoxRallarSendInput,
    BlackBoxRallarTransport,
    ResolvedBlackBoxRallarScope
} from './contracts.ts';
import type { BlackBoxRallarGenerationPort } from './ports.ts';

export type BlackBoxRallarDirectorLease = Readonly<{
    generation: number;
}>;

export type BlackBoxRallarDirectorResourceController<TRelay> = Readonly<{
    lease(): BlackBoxRallarDirectorLease;
    assertCurrent(lease: BlackBoxRallarDirectorLease, message: string): void;
    add(handle: string, relay: TRelay): void;
    require(handle: string): TRelay;
    take(handle: string): TRelay;
    delete(handle: string): boolean;
    entries(): readonly (readonly [string, TRelay])[];
    handles(): readonly string[];
}>;

export function createBlackBoxRallarDirectorResourceController<TRelay>(
    generationPort: BlackBoxRallarGenerationPort
): BlackBoxRallarDirectorResourceController<TRelay> {
    const relays = new Map<string, TRelay>();

    const add = (handle: string, relay: TRelay): void => {
        if (relays.has(handle)) {
            throw new Error('Director relay handle is already active: ' + handle);
        }
        relays.set(handle, relay);
    };

    const requireRelay = (handle: string): TRelay => {
        const relay = relays.get(handle);
        if (!relay) {
            throw new Error('Director relay handle is not active: ' + handle);
        }
        return relay;
    };

    const take = (handle: string): TRelay => {
        const relay = requireRelay(handle);
        relays.delete(handle);
        return relay;
    };

    return {
        lease: () => ({ generation: generationPort.generation() }),
        assertCurrent: (lease, message) => {
            if (!generationPort.isCurrent(lease.generation)) {
                throw new Error(message);
            }
        },
        add,
        require: requireRelay,
        take,
        delete: (handle) => relays.delete(handle),
        entries: () => [...relays.entries()],
        handles: () => [...relays.keys()]
    };
}

type DirectorRelayState = {
    handle: string;
    input: BlackBoxRallarDirectorRelayStartInput;
    relay: RallarDirectorRelayHandle<unknown, BlackBoxRallarDirectorOutputRecord, unknown>;
    acceptedIntents: unknown[];
    outputs: unknown[];
    snapshots: unknown[];
    syncRequests: unknown[];
    sequence: number;
};

type DirectorFacade = Pick<RallarFacade, 'director' | 'rooms'>;

type ScopeDiagnostics = Readonly<{
    scope?: Readonly<{
        applicationId?: string;
        workspaceId?: string;
    }>;
    applicationId?: string;
    workspaceId?: string;
}>;

export type CreateBlackBoxRallarDirectorControllerOptions =
    & BlackBoxRallarGenerationPort
    & Readonly<{
        facade: DirectorFacade;
        now(): number;
        requireConfig(): BlackBoxRallarConnectionConfig;
        transportOf(config: BlackBoxRallarConnectionConfig): BlackBoxRallarTransport;
        roomRefOf(
            config: BlackBoxRallarConnectionConfig,
            input?: BlackBoxRallarSendInput
        ): BlackBoxRallarRoomRef | undefined;
        scopeOf(
            config: BlackBoxRallarConnectionConfig,
            input?: BlackBoxRallarSendInput
        ): ResolvedBlackBoxRallarScope | undefined;
        scopeDiagnostics(config: BlackBoxRallarConnectionConfig): ScopeDiagnostics;
        emit(event: Omit<BlackBoxRallarEvent, 'atEpochMs'>): void;
        emitError(
            config: BlackBoxRallarConnectionConfig | undefined,
            topic: string,
            error: unknown,
            data?: unknown
        ): void;
    }>;

export type BlackBoxRallarDirectorController =
    & BlackBoxRallarDirectorRuntime
    & Readonly<{
        summary(): BlackBoxRallarDirectorRelaySummary;
        closeAll(config?: BlackBoxRallarConnectionConfig): readonly unknown[];
    }>;

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> {
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
    const record = asRecord(input);
    const rallarConfig = asRecord(record.rallar);
    const scope = optionalRecord(record.scope) ?? optionalRecord(rallarConfig.scope);
    const roomRef = optionalRecord(record.roomRef) ?? optionalRecord(rallarConfig.roomRef);
    return {
        roomId: stringValue(record.roomId) ?? stringValue(record.groupId) ?? stringValue(rallarConfig.roomId),
        applicationId: stringValue(record.applicationId) ?? stringValue(rallarConfig.applicationId),
        workspaceId: stringValue(record.workspaceId) ?? stringValue(rallarConfig.workspaceId),
        scope,
        roomRef: roomRef as BlackBoxRallarRoomRef | undefined,
        timeoutMs: optionalNumber(record.timeoutMs)
    };
}

function normalizeDirectorAppointInput(input: unknown): BlackBoxRallarDirectorAppointInput {
    const record = asRecord(input);
    return {
        ...normalizeDirectorRoomInput(record),
        heartbeatTtlMs: optionalNumber(record.heartbeatTtlMs)
    };
}

function normalizeDirectorStatusInput(input: unknown): BlackBoxRallarDirectorStatusInput {
    const record = asRecord(input);
    return {
        ...normalizeDirectorRoomInput(record),
        refresh: typeof record.refresh === 'boolean' ? record.refresh : undefined,
        now: optionalNumber(record.now)
    };
}

function normalizeDirectorRelayStartInput(input: unknown): BlackBoxRallarDirectorRelayStartInput {
    const record = asRecord(input);
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
    const record = asRecord(input);
    const handle = stringValue(record.handle);
    if (!handle) {
        throw new Error('Director relay command requires handle.');
    }
    return { handle, timeoutMs: optionalNumber(record.timeoutMs) };
}

function normalizeDirectorIntentInput(input: unknown): BlackBoxRallarDirectorIntentInput {
    const record = asRecord(input);
    return { ...normalizeDirectorHandleInput(record), intent: record.intent };
}

function normalizeDirectorSyncRequestInput(input: unknown): BlackBoxRallarDirectorSyncRequestInput {
    const record = asRecord(input);
    return { ...normalizeDirectorHandleInput(record), payload: record.payload };
}

function intentIdFromPayload(payload: unknown, fallback: string): string {
    const record = asRecord(payload);
    return stringValue(record.intentId) ?? stringValue(record.id) ?? stringValue(record.messageId) ?? fallback;
}

export function createBlackBoxRallarDirectorController(
    options: CreateBlackBoxRallarDirectorControllerOptions
): BlackBoxRallarDirectorController {
    const resources = createBlackBoxRallarDirectorResourceController<DirectorRelayState>(options);
    const rallar = options.facade;
    const assertCurrent = (lease: BlackBoxRallarDirectorLease): void => {
        resources.assertCurrent(lease, 'Director operation completed after the runtime closed.');
    };
    const toRoomRef = (
        input: BlackBoxRallarDirectorRoomInput,
        config: BlackBoxRallarConnectionConfig
    ): BlackBoxRallarRoomRef | undefined =>
        input.roomRef ?? options.roomRefOf(config, input as BlackBoxRallarSendInput);
    const toTarget = (
        input: BlackBoxRallarDirectorRoomInput,
        config: BlackBoxRallarConnectionConfig
    ): string | BlackBoxRallarRoomRef | undefined => toRoomRef(input, config) ?? input.roomId ?? config.roomId;
    const toScope = (
        input: BlackBoxRallarDirectorRoomInput,
        config: BlackBoxRallarConnectionConfig
    ): ResolvedBlackBoxRallarScope | undefined => options.scopeOf(config, input as BlackBoxRallarSendInput);
    const statusDiagnostics = (
        status: BlackBoxRallarDirectorCommandDiagnostics['status'],
        input: BlackBoxRallarDirectorRoomInput,
        directorStatus: RallarDirectorStatus,
        config: BlackBoxRallarConnectionConfig,
        extra: Omit<
            BlackBoxRallarDirectorCommandDiagnostics,
            | 'status'
            | 'roomId'
            | 'roomRef'
            | 'role'
            | 'state'
            | 'isDirector'
            | 'isFresh'
            | 'appointment'
            | 'directorStatus'
        > = {}
    ): BlackBoxRallarDirectorCommandDiagnostics => {
        const roomRef = toRoomRef(input, config);
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
    const emitDiagnostic = (
        topic: string,
        handle: string | undefined,
        data: unknown,
        config: BlackBoxRallarConnectionConfig
    ): void => {
        options.emit({
            kind: 'diagnostic',
            topic,
            connection: config.connection,
            actor: config.actor,
            transport: options.transportOf(config),
            roomId: config.roomId,
            ...options.scopeDiagnostics(config),
            data: {
                ...(handle ? { handle } : {}),
                ...(isRecord(data) ? data : { value: data })
            }
        });
    };
    const relaySnapshot = (entry: DirectorRelayState): Record<string, unknown> => {
        const status = entry.relay.status();
        return entry.input.snapshot !== undefined
            ? { handle: entry.handle, static: true, status, snapshot: entry.input.snapshot }
            : {
                handle: entry.handle,
                status,
                acceptedIntents: entry.acceptedIntents,
                outputs: entry.outputs,
                snapshots: entry.snapshots,
                syncRequests: entry.syncRequests,
                sequence: entry.sequence,
                generatedAtEpochMs: options.now()
            };
    };
    const requireRelay = (handle: string): DirectorRelayState => {
        try {
            return resources.require(handle);
        }
        catch {
            throw new Error('Director relay handle is not open: ' + handle);
        }
    };

    return {
        appoint: async (input) => {
            const config = options.requireConfig();
            const lease = resources.lease();
            assertCurrent(lease);
            const normalized = normalizeDirectorAppointInput(input);
            const directorStatus = await rallar.director.appoint(toTarget(normalized, config) as any, {
                heartbeatTtlMs: normalized.heartbeatTtlMs,
                scope: toScope(normalized, config),
                timeoutMs: normalized.timeoutMs
            } as any);
            assertCurrent(lease);
            const diagnostics = statusDiagnostics('appointed', normalized, directorStatus, config);
            emitDiagnostic('rallar.browser.director.appointed', undefined, diagnostics, config);
            return diagnostics;
        },
        resign: async (input) => {
            const config = options.requireConfig();
            const lease = resources.lease();
            assertCurrent(lease);
            const normalized = normalizeDirectorRoomInput(input);
            const directorStatus = await rallar.director.resign(toTarget(normalized, config) as any, {
                scope: toScope(normalized, config),
                timeoutMs: normalized.timeoutMs
            } as any);
            assertCurrent(lease);
            const diagnostics = statusDiagnostics('resigned', normalized, directorStatus, config);
            emitDiagnostic('rallar.browser.director.resigned', undefined, diagnostics, config);
            return diagnostics;
        },
        status: async (input) => {
            const config = options.requireConfig();
            const lease = resources.lease();
            assertCurrent(lease);
            const normalized = normalizeDirectorStatusInput(input);
            if (normalized.refresh) {
                await rallar.rooms.refresh({
                    scope: toScope(normalized, config),
                    timeoutMs: normalized.timeoutMs
                } as any);
            }
            assertCurrent(lease);
            const directorStatus = rallar.director.status(toTarget(normalized, config) as any, {
                now: normalized.now
            });
            const diagnostics = statusDiagnostics('status', normalized, directorStatus, config);
            emitDiagnostic('rallar.browser.director.status', undefined, diagnostics, config);
            return diagnostics;
        },
        relayStart: async (input) => {
            const config = options.requireConfig();
            const lease = resources.lease();
            assertCurrent(lease);
            const normalized = normalizeDirectorRelayStartInput(input);
            if (resources.handles().includes(normalized.handle)) {
                throw new Error('Director relay handle is already open: ' + normalized.handle);
            }
            let entry!: DirectorRelayState;
            const relay = rallar.director.createRelay<unknown, BlackBoxRallarDirectorOutputRecord, unknown>({
                roomId: normalized.roomId ?? config.roomId,
                roomRef: toRoomRef(normalized, config) as any,
                laneId: normalized.laneId,
                topicId: normalized.topicId,
                intentTypeId: normalized.intentTypeId,
                outputTypeId: normalized.outputTypeId,
                heartbeatTypeId: normalized.heartbeatTypeId,
                snapshotTypeId: normalized.snapshotTypeId,
                syncRequestTypeId: normalized.syncRequestTypeId,
                heartbeatIntervalMs: normalized.heartbeatIntervalMs,
                snapshotIntervalMs: normalized.snapshotIntervalMs,
                readSnapshot: () => relaySnapshot(entry),
                onIntent: (message: RallarDirectorRelayMessage<unknown>) => {
                    assertCurrent(lease);
                    const nextSequence = entry.sequence + 1;
                    const output: BlackBoxRallarDirectorOutputRecord = {
                        kind: 'black-box-director-output',
                        intentId: intentIdFromPayload(message.data, `intent-${nextSequence}`),
                        sequence: nextSequence,
                        senderId: message.senderId,
                        directorSessionId: entry.relay.status().appointment?.sessionId,
                        directorPrincipalId: entry.relay.status().appointment?.principalId,
                        epoch: message.envelope.epoch,
                        receivedAtEpochMs: message.receivedAtEpochMs,
                        payload: message.data
                    };
                    entry.sequence = nextSequence;
                    entry.acceptedIntents.push({
                        intentId: output.intentId,
                        senderId: message.senderId,
                        epoch: message.envelope.epoch,
                        receivedAtEpochMs: message.receivedAtEpochMs,
                        payload: message.data
                    });
                    entry.outputs.push(output);
                    emitDiagnostic('rallar.browser.director.intent_received', entry.handle, {
                        intent: entry.acceptedIntents.at(-1),
                        output
                    }, config);
                    return output;
                },
                onOutput: (message: RallarDirectorRelayMessage<BlackBoxRallarDirectorOutputRecord>) => {
                    assertCurrent(lease);
                    entry.outputs.push(message.data);
                    emitDiagnostic('rallar.browser.director.output_received', entry.handle, {
                        output: message.data,
                        senderId: message.senderId,
                        epoch: message.envelope.epoch,
                        receivedAtEpochMs: message.receivedAtEpochMs
                    }, config);
                },
                onSnapshot: (message: RallarDirectorRelayMessage<unknown>) => {
                    assertCurrent(lease);
                    entry.snapshots.push(message.data);
                    emitDiagnostic('rallar.browser.director.snapshot_received', entry.handle, {
                        snapshot: message.data,
                        senderId: message.senderId,
                        epoch: message.envelope.epoch,
                        receivedAtEpochMs: message.receivedAtEpochMs
                    }, config);
                },
                onSyncRequest: (message: RallarDirectorRelayMessage<unknown>) => {
                    assertCurrent(lease);
                    entry.syncRequests.push({
                        senderId: message.senderId,
                        epoch: message.envelope.epoch,
                        receivedAtEpochMs: message.receivedAtEpochMs,
                        payload: message.data
                    });
                    emitDiagnostic('rallar.browser.director.sync_request_received', entry.handle, {
                        syncRequest: entry.syncRequests.at(-1)
                    }, config);
                }
            });
            entry = {
                handle: normalized.handle,
                input: normalized,
                relay,
                acceptedIntents: [],
                outputs: [],
                snapshots: [],
                syncRequests: [],
                sequence: 0
            };
            resources.add(normalized.handle, entry);
            const diagnostics = statusDiagnostics('relay_started', normalized, relay.status(), config, {
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
            });
            emitDiagnostic('rallar.browser.director.relay_started', normalized.handle, diagnostics, config);
            return diagnostics;
        },
        intent: async (input) => {
            const config = options.requireConfig();
            const lease = resources.lease();
            assertCurrent(lease);
            const normalized = normalizeDirectorIntentInput(input);
            const relay = requireRelay(normalized.handle);
            const sendResult = await relay.relay.sendIntent(normalized.intent);
            assertCurrent(lease);
            const diagnostics = statusDiagnostics('intent_sent', relay.input, relay.relay.status(), config, {
                handle: normalized.handle,
                sendResult
            });
            emitDiagnostic('rallar.browser.director.intent_sent', normalized.handle, {
                ...diagnostics,
                intent: normalized.intent
            }, config);
            return diagnostics;
        },
        syncRequest: async (input) => {
            const config = options.requireConfig();
            const lease = resources.lease();
            assertCurrent(lease);
            const normalized = normalizeDirectorSyncRequestInput(input);
            const relay = requireRelay(normalized.handle);
            const sendResult = await relay.relay.requestSync(normalized.payload);
            assertCurrent(lease);
            const diagnostics = statusDiagnostics('sync_requested', relay.input, relay.relay.status(), config, {
                handle: normalized.handle,
                sendResult
            });
            emitDiagnostic('rallar.browser.director.sync_requested', normalized.handle, {
                ...diagnostics,
                payload: normalized.payload
            }, config);
            return diagnostics;
        },
        relayStop: async (input) => {
            const config = options.requireConfig();
            const lease = resources.lease();
            assertCurrent(lease);
            const normalized = normalizeDirectorHandleInput(input);
            const relay = requireRelay(normalized.handle);
            const status = relay.relay.status();
            relay.relay.stop();
            resources.delete(normalized.handle);
            const diagnostics = statusDiagnostics('relay_stopped', relay.input, status, config, {
                handle: normalized.handle,
                acceptedIntentCount: relay.acceptedIntents.length,
                outputCount: relay.outputs.length,
                snapshotCount: relay.snapshots.length,
                syncRequestCount: relay.syncRequests.length
            });
            emitDiagnostic('rallar.browser.director.relay_stopped', normalized.handle, diagnostics, config);
            return diagnostics;
        },
        summary: () => ({
            handles: resources.handles(),
            relays: resources.entries().map(([, entry]) => ({
                handle: entry.handle,
                roomId: entry.input.roomId,
                topicId: entry.input.topicId,
                intentTypeId: entry.input.intentTypeId,
                outputTypeId: entry.input.outputTypeId,
                acceptedIntentCount: entry.acceptedIntents.length,
                outputCount: entry.outputs.length,
                snapshotCount: entry.snapshots.length,
                syncRequestCount: entry.syncRequests.length,
                status: entry.relay.status()
            }))
        }),
        closeAll: (config) => {
            const errors: unknown[] = [];
            for (const [handle, relay] of resources.entries()) {
                try {
                    relay.relay.stop();
                    resources.delete(handle);
                    if (config) {
                        emitDiagnostic('rallar.browser.director.relay_stopped', handle, {
                            status: 'relay_stopped',
                            handle,
                            reason: 'runtime-close',
                            acceptedIntentCount: relay.acceptedIntents.length,
                            outputCount: relay.outputs.length,
                            snapshotCount: relay.snapshots.length,
                            syncRequestCount: relay.syncRequests.length
                        }, config);
                    }
                }
                catch (error) {
                    errors.push(error);
                    options.emitError(config, 'rallar.browser.director.relay_stop_failed', error, {
                        handle,
                        reason: 'runtime-close'
                    });
                }
            }
            return errors;
        }
    };
}
