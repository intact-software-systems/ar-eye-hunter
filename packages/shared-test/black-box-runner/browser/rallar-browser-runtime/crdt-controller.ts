import type {
    RallarCrdtOperation,
    RallarCrdtOperationBatch,
    RallarCrdtSyncOptions,
    RallarCrdtTransportStrategy,
    RallarCrdtUpdateEnvelope,
} from '@shared/crdt/mod.ts';
import { catchUpRallarCrdtDocument } from '@shared-web/browser/api-integration.ts';
import type { RallarCrdtDocument, RallarCrdtOpenOptions, RallarFacade } from '@shared-web/browser/rallar.ts';
import type {
    BlackBoxRallarConnectionConfig,
    BlackBoxRallarCrdtApplyInput,
    BlackBoxRallarCrdtCommandDiagnostics,
    BlackBoxRallarCrdtHandleInput,
    BlackBoxRallarCrdtOpenInput,
    BlackBoxRallarCrdtRuntime,
    BlackBoxRallarCrdtRuntimeSummary,
    BlackBoxRallarCrdtSyncInput,
    BlackBoxRallarCrdtUndoRedoInput,
    BlackBoxRallarCrdtWaitCondition,
    BlackBoxRallarCrdtWaitInput,
    BlackBoxRallarCrdtWaitOperator,
    BlackBoxRallarEvent,
    BlackBoxRallarRoomRef,
} from './contracts.ts';
import type { BlackBoxRallarGenerationPort } from './ports.ts';
import type { GroupRef } from '@shared/api/group-types.ts';

export type BlackBoxRallarCrdtLease = Readonly<{
    generation: number;
}>;

export type BlackBoxRallarCrdtResourceController<TDocument> = Readonly<{
    lease(): BlackBoxRallarCrdtLease;
    assertCurrent(lease: BlackBoxRallarCrdtLease, message: string): void;
    open(handle: string, effect: () => Promise<TDocument>): Promise<TDocument>;
    track<TResult>(effect: Promise<TResult>): Promise<TResult>;
    run<TResult>(handle: string, effect: (document: TDocument) => Promise<TResult>): Promise<TResult>;
    release<TResult>(handle: string, effect: (document: TDocument) => Promise<TResult>): Promise<TResult>;
    require(handle: string): TDocument;
    take(handle: string): TDocument;
    delete(handle: string): boolean;
    entries(): readonly (readonly [string, TDocument])[];
    handles(): readonly string[];
    pending(): readonly Promise<unknown>[];
}>;

export function createBlackBoxRallarCrdtResourceController<TDocument>(
    generationPort: BlackBoxRallarGenerationPort,
): BlackBoxRallarCrdtResourceController<TDocument> {
    const documents = new Map<string, TDocument>();
    const pendingOpens = new Map<string, Promise<TDocument>>();
    const operationTails = new Map<string, Promise<unknown>>();
    const pendingEffects = new Set<Promise<unknown>>();

    const open = (handle: string, effect: () => Promise<TDocument>): Promise<TDocument> => {
        if (documents.has(handle) || pendingOpens.has(handle)) {
            return Promise.reject(new Error('CRDT document handle is already open: ' + handle));
        }

        const promise = (async () => {
            const document = await effect();
            documents.set(handle, document);
            return document;
        })();
        pendingOpens.set(handle, promise);
        void promise
            .finally(() => {
                if (pendingOpens.get(handle) === promise) {
                    pendingOpens.delete(handle);
                }
            })
            .catch(() => undefined);
        return promise;
    };

    const requireDocument = (handle: string): TDocument => {
        const document = documents.get(handle);
        if (!document) {
            throw new Error('CRDT document handle is not open: ' + handle);
        }
        return document;
    };

    const track = <TResult>(effect: Promise<TResult>): Promise<TResult> => {
        pendingEffects.add(effect);
        void effect
            .finally(() => {
                pendingEffects.delete(effect);
            })
            .catch(() => undefined);
        return effect;
    };

    const take = (handle: string): TDocument => {
        const document = requireDocument(handle);
        documents.delete(handle);
        return document;
    };

    const run = <TResult>(handle: string, effect: (document: TDocument) => Promise<TResult>): Promise<TResult> => {
        const previous = operationTails.get(handle) ?? Promise.resolve();
        const promise = previous.catch(() => undefined).then(() => effect(requireDocument(handle)));
        operationTails.set(handle, promise);
        void promise
            .finally(() => {
                if (operationTails.get(handle) === promise) {
                    operationTails.delete(handle);
                }
            })
            .catch(() => undefined);
        return promise;
    };

    const release = <TResult>(
        handle: string,
        effect: (document: TDocument) => Promise<TResult>,
    ): Promise<TResult> => {
        const previous = operationTails.get(handle) ?? Promise.resolve();
        const promise = previous.catch(() => undefined).then(async () => {
            const document = requireDocument(handle);
            const result = await effect(document);
            documents.delete(handle);
            return result;
        });
        operationTails.set(handle, promise);
        void promise
            .finally(() => {
                if (operationTails.get(handle) === promise) {
                    operationTails.delete(handle);
                }
            })
            .catch(() => undefined);
        return promise;
    };

    return {
        lease: () => ({ generation: generationPort.generation() }),
        assertCurrent: (lease, message) => {
            if (!generationPort.isCurrent(lease.generation)) {
                throw new Error(message);
            }
        },
        open,
        track,
        run,
        release,
        require: requireDocument,
        take,
        delete: handle => documents.delete(handle),
        entries: () => [...documents.entries()],
        handles: () => [...documents.keys()],
        pending: () => [...pendingOpens.values(), ...operationTails.values(), ...pendingEffects],
    };
}


const DEFAULT_WORKSPACE_ID = 'default';

type CrdtFacade = Pick<RallarFacade, 'crdt' | 'isConnected'>;

type ScopeDiagnostics = Readonly<{
    scope?: Readonly<{
        applicationId?: string;
        workspaceId?: string;
    }>;
    applicationId?: string;
    workspaceId?: string;
}>;

export type CreateBlackBoxRallarCrdtControllerOptions = BlackBoxRallarGenerationPort &
    Readonly<{
        operationSignal(): AbortSignal;
        facade: CrdtFacade;
        now(): number;
        delay(ms: number): Promise<void>;
        currentConnectionConfig(): BlackBoxRallarConnectionConfig | undefined;
        ensureLiveConnection(
            config: BlackBoxRallarConnectionConfig,
            transportStrategy: RallarCrdtTransportStrategy,
        ): Promise<void>;
        scopeDiagnostics(config: BlackBoxRallarConnectionConfig): ScopeDiagnostics;
        emit(event: Omit<BlackBoxRallarEvent, 'atEpochMs'>): void;
        emitError(
            config: BlackBoxRallarConnectionConfig | undefined,
            topic: string,
            error: unknown,
            data?: unknown,
        ): void;
    }>;

export type BlackBoxRallarCrdtController = BlackBoxRallarCrdtRuntime &
    Readonly<{
        summary(): BlackBoxRallarCrdtRuntimeSummary;
        pending(): readonly Promise<unknown>[];
        closeAll(config?: BlackBoxRallarConnectionConfig): Promise<readonly unknown[]>;
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

function raceCrdtOperationWithClose<TResult>(
    operation: Promise<TResult>,
    signal: AbortSignal,
): Promise<TResult> {
    const closedError = () => new Error('CRDT operation completed after the runtime closed.');
    if (signal.aborted) {
        return Promise.reject(closedError());
    }

    return new Promise<TResult>((resolve, reject) => {
        let settled = false;
        const settle = (effect: () => void): void => {
            if (settled) {
                return;
            }
            settled = true;
            signal.removeEventListener('abort', onAbort);
            effect();
        };
        const onAbort = (): void => settle(() => reject(closedError()));
        signal.addEventListener('abort', onAbort, { once: true });
        void operation.then(
            result => settle(() => resolve(result)),
            error => settle(() => reject(error)),
        );
    });
}

function waitForCrdtDelay(
    delay: (ms: number) => Promise<void>,
    durationMs: number,
    signal: AbortSignal,
): Promise<void> {
    return raceCrdtOperationWithClose(delay(durationMs), signal);
}

export function createBlackBoxRallarCrdtController(
    options: CreateBlackBoxRallarCrdtControllerOptions,
): BlackBoxRallarCrdtController {
    const crdtController = createBlackBoxRallarCrdtResourceController<
        RallarCrdtDocument<unknown, RallarCrdtOperationBatch>
    >(options);
    const rallar = options.facade;
    const lifecycle = options;
    const now = options.now;
    const wait = options.delay;
    const emit = options.emit;
    const emitError = options.emitError;
    const scopeDiagnostics = options.scopeDiagnostics;

    function crdtHandle(input: unknown): string {
        const record = asRecord(input);
        const handle = stringValue(record.handle) ?? stringValue(record.commandId) ?? stringValue(record.name);
        if (!handle) {
            throw new Error('CRDT command requires handle.');
        }

        return handle;
    }

    function crdtRoomRef(input: BlackBoxRallarCrdtOpenInput): GroupRef | undefined {
        const explicit = input.roomRef ?? (optionalRecord(input.rallar?.roomRef) as BlackBoxRallarRoomRef | undefined);
        if (explicit?.applicationId && explicit.groupId) {
            return {
                applicationId: String(explicit.applicationId),
                workspaceId: String(explicit.workspaceId ?? DEFAULT_WORKSPACE_ID),
                groupId: String(explicit.groupId),
            };
        }

        const roomId = input.roomId ?? stringValue(input.rallar?.roomId);
        const applicationId =
            input.applicationId ??
            stringValue(input.rallar?.applicationId) ??
            stringValue(optionalRecord(input.scope)?.applicationId);
        if (!roomId || !applicationId) {
            return undefined;
        }

        const workspaceId =
            input.workspaceId ??
            stringValue(input.rallar?.workspaceId) ??
            stringValue(optionalRecord(input.scope)?.workspaceId);

        return {
            applicationId,
            workspaceId: workspaceId ?? DEFAULT_WORKSPACE_ID,
            groupId: roomId,
        };
    }

    function normalizeCrdtOpenInput(input: BlackBoxRallarCrdtOpenInput | unknown): BlackBoxRallarCrdtOpenInput {
        const record = asRecord(input);
        const rallarConfig = asRecord(record.rallar);
        const scope = optionalRecord(record.scope) ?? optionalRecord(rallarConfig.scope);
        const roomRef = optionalRecord(record.roomRef) ?? optionalRecord(rallarConfig.roomRef);
        const name = stringValue(record.name);
        if (!name) {
            throw new Error('crdt.open requires name.');
        }

        return {
            handle: stringValue(record.handle) ?? stringValue(record.commandId) ?? name,
            name,
            applicationId: stringValue(record.applicationId) ?? stringValue(rallarConfig.applicationId),
            workspaceId: stringValue(record.workspaceId) ?? stringValue(rallarConfig.workspaceId),
            documentId: stringValue(record.documentId),
            documentType: stringValue(record.documentType),
            scope,
            roomRef: roomRef as BlackBoxRallarRoomRef | undefined,
            principalId: stringValue(record.principalId),
            customScope: stringValue(record.customScope),
            transport: toCrdtTransport(record.transport) ?? toCrdtTransport(rallarConfig.crdtTransport),
            persist: typeof record.persist === 'boolean' ? record.persist : undefined,
            tabSync: typeof record.tabSync === 'boolean' ? record.tabSync : undefined,
            initialValue: record.initialValue,
            policies: Array.isArray(record.policies)
                ? (record.policies as readonly Readonly<Record<string, unknown>>[])
                : undefined,
            validation: optionalRecord(record.validation),
            encryption: optionalRecord(record.encryption),
            durableCatchUp:
                record.durableCatchUp === 'http' ? 'http' : record.durableCatchUp === false ? false : undefined,
            apiBaseUrl: stringValue(record.apiBaseUrl) ?? stringValue(rallarConfig.apiBaseUrl),
            actor: stringValue(record.actor),
            sessionId: stringValue(record.sessionId) ?? stringValue(rallarConfig.sessionId),
            username: stringValue(record.username) ?? stringValue(rallarConfig.username),
            password: stringValue(record.password) ?? stringValue(rallarConfig.password),
            displayName: stringValue(record.displayName) ?? stringValue(rallarConfig.displayName),
            register:
                record.register === true || record.register === 'if-needed'
                    ? record.register
                    : rallarConfig.register === true || rallarConfig.register === 'if-needed'
                      ? rallarConfig.register
                      : undefined,
            timeoutMs:
                typeof record.timeoutMs === 'number'
                    ? record.timeoutMs
                    : typeof rallarConfig.timeoutMs === 'number'
                      ? rallarConfig.timeoutMs
                      : undefined,
            roomId: stringValue(record.roomId) ?? stringValue(rallarConfig.roomId),
            rallar: rallarConfig,
        };
    }

    function toCrdtTransport(value: unknown): RallarCrdtTransportStrategy | undefined {
        return value === 'local-only' ||
            value === 'ws' ||
            value === 'rtc' ||
            value === 'ws-then-rtc' ||
            value === 'rtc-with-ws-fallback'
            ? value
            : undefined;
    }

    function toCrdtOpenScope(input: BlackBoxRallarCrdtOpenInput): RallarCrdtOpenOptions['scope'] {
        const scope = optionalRecord(input.scope);
        const kind = stringValue(scope?.kind);
        const roomRef = crdtRoomRef(input);
        if (kind === 'app') {
            return { kind: 'app' };
        }
        if (kind === 'principal') {
            const principalId = stringValue(scope?.principalId) ?? input.principalId;
            if (principalId) {
                return { kind: 'principal', principalId };
            }
        }
        if (kind === 'custom') {
            const customScope = stringValue(scope?.customScope) ?? input.customScope;
            if (customScope) {
                return { kind: 'custom', customScope };
            }
        }
        if (kind === 'room' && roomRef) {
            return { kind: 'room', roomRef };
        }
        if (input.principalId) {
            return { kind: 'principal', principalId: input.principalId };
        }
        if (input.customScope) {
            return { kind: 'custom', customScope: input.customScope };
        }
        if (roomRef) {
            return { kind: 'room', roomRef };
        }

        return undefined;
    }

    function toCrdtConnectionConfig(input: BlackBoxRallarCrdtOpenInput): BlackBoxRallarConnectionConfig {
        const roomRef = crdtRoomRef(input);
        const applicationId = input.applicationId ?? stringValue(input.rallar?.applicationId) ?? roomRef?.applicationId;
        const workspaceId =
            input.workspaceId ?? stringValue(input.rallar?.workspaceId) ?? roomRef?.workspaceId ?? DEFAULT_WORKSPACE_ID;
        const scope = applicationId
            ? {
                  applicationId,
                  workspaceId,
              }
            : undefined;

        return {
            connection: input.handle ?? input.name,
            actor: input.actor,
            roomId: input.roomId ?? roomRef?.groupId,
            ...(roomRef ? { roomRef } : {}),
            rallar: {
                ...asRecord(input.rallar),
                apiBaseUrl: input.apiBaseUrl ?? stringValue(input.rallar?.apiBaseUrl) ?? '',
                ...(input.username ? { username: input.username } : {}),
                ...(input.password ? { password: input.password } : {}),
                ...(input.displayName ? { displayName: input.displayName } : {}),
                ...(input.register !== undefined ? { register: input.register } : {}),
                ...(applicationId ? { applicationId } : {}),
                ...(workspaceId ? { workspaceId } : {}),
                ...(scope ? { scope } : {}),
                ...(roomRef ? { roomRef } : {}),
                ...(input.sessionId ? { expectedSessionId: input.sessionId } : {}),
                ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
                transport: 'realtime',
            },
        };
    }

    function toCrdtOpenOptions(
        input: BlackBoxRallarCrdtOpenInput,
    ): RallarCrdtOpenOptions<unknown, RallarCrdtOperationBatch> {
        return {
            ...(input.applicationId ? { applicationId: input.applicationId } : {}),
            ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
            ...(input.documentId ? { documentId: input.documentId } : {}),
            ...(input.documentType ? { documentType: input.documentType } : {}),
            ...(toCrdtOpenScope(input) ? { scope: toCrdtOpenScope(input) } : {}),
            ...(input.transport ? { transport: input.transport } : {}),
            ...(input.persist !== undefined ? { persist: input.persist } : {}),
            ...(input.tabSync !== undefined ? { tabSync: input.tabSync } : {}),
            ...(input.initialValue !== undefined ? { initialValue: input.initialValue } : {}),
            ...(input.policies ? { policies: input.policies as any } : {}),
            ...(input.validation ? { validation: input.validation as any } : {}),
            ...(input.encryption ? { encryption: input.encryption as any } : {}),
            ...(input.actor ? { actorId: input.actor } : {}),
            ...(input.sessionId ? { sessionId: input.sessionId } : {}),
            ...(input.durableCatchUp === 'http' ? { durableCatchUp: catchUpRallarCrdtDocument } : {}),
        };
    }


    async function ensureCrdtLiveConnection(
        input: BlackBoxRallarCrdtOpenInput,
    ): Promise<BlackBoxRallarConnectionConfig | undefined> {
        if ((input.transport ?? 'local-only') === 'local-only') {
            return undefined;
        }
        if (!input.apiBaseUrl) {
            if (rallar.isConnected()) {
                return options.currentConnectionConfig();
            }
            throw new Error('crdt.open requires apiBaseUrl or an existing Rallar connection for live transports.');
        }

        const config = toCrdtConnectionConfig(input);
        await options.ensureLiveConnection(config, input.transport ?? 'ws');
        return config;
    }

    function requireCrdtDocument(handle: string): RallarCrdtDocument<unknown, RallarCrdtOperationBatch> {
        return crdtController.require(handle);
    }

    function optionalNumber(value: unknown): number | undefined {
        return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
    }

    function normalizeCrdtWaitCondition(value: unknown): BlackBoxRallarCrdtWaitCondition {
        const record = asRecord(value);
        const source = record.source === 'value' || record.source === 'health' ? record.source : undefined;
        const operator = isCrdtWaitOperator(record.operator) ? record.operator : undefined;
        if (!source || !operator) {
            throw new Error('crdt.wait conditions require source and supported operator.');
        }

        return {
            source,
            ...(stringValue(record.path) ? { path: stringValue(record.path) } : {}),
            operator,
            ...(record.expected !== undefined ? { expected: record.expected } : {}),
        };
    }

    function normalizeCrdtWaitInput(input: BlackBoxRallarCrdtWaitInput | unknown): BlackBoxRallarCrdtWaitInput {
        const record = asRecord(input);
        const handle = crdtHandle(record);
        const conditions = Array.isArray(record.conditions) ? record.conditions.map(normalizeCrdtWaitCondition) : [];
        if (conditions.length === 0) {
            throw new Error('crdt.wait requires at least one condition.');
        }

        const syncRecord = record.sync === false ? false : optionalRecord(record.sync);

        return {
            handle,
            ...(optionalNumber(record.timeoutMs) !== undefined
                ? {
                      timeoutMs: Math.max(0, optionalNumber(record.timeoutMs) as number),
                  }
                : {}),
            ...(optionalNumber(record.intervalMs) !== undefined
                ? {
                      intervalMs: Math.max(0, optionalNumber(record.intervalMs) as number),
                  }
                : {}),
            ...(optionalNumber(record.stableForMs) !== undefined
                ? {
                      stableForMs: Math.max(0, optionalNumber(record.stableForMs) as number),
                  }
                : {}),
            ...(syncRecord !== undefined
                ? {
                      sync:
                          syncRecord === false
                              ? false
                              : {
                                    ...(stringValue(syncRecord.reason)
                                        ? {
                                              reason: stringValue(syncRecord.reason),
                                          }
                                        : {}),
                                    ...(toCrdtTransport(syncRecord.transport)
                                        ? {
                                              transport: toCrdtTransport(syncRecord.transport),
                                          }
                                        : {}),
                                },
                  }
                : {}),
            conditions,
        };
    }

    function isCrdtWaitOperator(value: unknown): value is BlackBoxRallarCrdtWaitOperator {
        return (
            value === 'equals' ||
            value === 'notEquals' ||
            value === 'contains' ||
            value === 'exists' ||
            value === 'gte' ||
            value === 'lte'
        );
    }

    function normalizeCrdtWaitPath(path: string): string {
        if (path.startsWith('$.')) {
            return path.slice('$.'.length);
        }
        return path;
    }

    function lookupCrdtWaitPath(
        root: unknown,
        path: string | undefined,
    ): Readonly<{
        exists: boolean;
        value?: unknown;
    }> {
        if (!path || path.trim().length === 0) {
            return {
                exists: root !== undefined,
                value: root,
            };
        }

        let current = root;
        const segments = normalizeCrdtWaitPath(path)
            .split('.')
            .filter(segment => segment.length > 0);
        for (const segment of segments) {
            if ((Array.isArray(current) || typeof current === 'string') && segment === 'length') {
                current = current.length;
                continue;
            }

            if (Array.isArray(current)) {
                const index = Number(segment);
                if (!Number.isInteger(index) || index < 0 || index >= current.length) {
                    return { exists: false };
                }
                current = current[index];
                continue;
            }

            if (!current || typeof current !== 'object') {
                return { exists: false };
            }

            const record = current as Record<string, unknown>;
            if (!Object.prototype.hasOwnProperty.call(record, segment)) {
                return { exists: false };
            }
            current = record[segment];
        }

        return {
            exists: true,
            value: current,
        };
    }

    function sameCrdtWaitValue(left: unknown, right: unknown): boolean {
        try {
            return JSON.stringify(left) === JSON.stringify(right);
        } catch (_error) {
            return Object.is(left, right);
        }
    }

    function containsCrdtWaitValue(value: unknown, expected: unknown): boolean {
        if (Array.isArray(value)) {
            return value.some(entry => sameCrdtWaitValue(entry, expected));
        }
        if (typeof value === 'string') {
            return value.includes(String(expected));
        }
        if (value && typeof value === 'object') {
            if (typeof expected === 'string') {
                try {
                    return JSON.stringify(value).includes(expected);
                } catch (_error) {
                    return String(value).includes(expected);
                }
            }
            return Object.values(value as Record<string, unknown>).some(entry => sameCrdtWaitValue(entry, expected));
        }

        return String(value).includes(String(expected));
    }

    function crdtWaitConditionMatches(
        condition: BlackBoxRallarCrdtWaitCondition,
        value: unknown,
        health: unknown,
    ): boolean {
        const source = condition.source === 'value' ? value : health;
        const lookup = lookupCrdtWaitPath(source, condition.path);

        switch (condition.operator) {
            case 'equals':
                return lookup.exists && sameCrdtWaitValue(lookup.value, condition.expected);
            case 'notEquals':
                return !lookup.exists || !sameCrdtWaitValue(lookup.value, condition.expected);
            case 'contains':
                return lookup.exists && containsCrdtWaitValue(lookup.value, condition.expected);
            case 'exists':
                return condition.expected === undefined ? lookup.exists : lookup.exists === Boolean(condition.expected);
            case 'gte':
                return (
                    lookup.exists &&
                    typeof lookup.value === 'number' &&
                    typeof condition.expected === 'number' &&
                    lookup.value >= condition.expected
                );
            case 'lte':
                return (
                    lookup.exists &&
                    typeof lookup.value === 'number' &&
                    typeof condition.expected === 'number' &&
                    lookup.value <= condition.expected
                );
        }
    }

    function crdtRuntimeSummary(): BlackBoxRallarCrdtRuntimeSummary {
        return {
            handles: crdtController.handles(),
            documents: crdtController.entries().map(([handle, document]) => ({
                handle,
                ref: document.ref,
                health: document.health(),
            })),
        };
    }

    function toCrdtDiagnostics(
        status: BlackBoxRallarCrdtCommandDiagnostics['status'],
        handle: string,
        document: RallarCrdtDocument<unknown, RallarCrdtOperationBatch> | undefined,
        options: Readonly<{
            update?: RallarCrdtUpdateEnvelope<RallarCrdtOperationBatch>;
            result?: unknown;
            value?: unknown;
            transportStrategy?: RallarCrdtTransportStrategy;
            attempts?: number;
            waitedMs?: number;
            stableForMs?: number;
            conditions?: readonly BlackBoxRallarCrdtWaitCondition[];
            lastSyncResult?: unknown;
        }> = {},
    ): BlackBoxRallarCrdtCommandDiagnostics {
        const health = document?.health();
        const value =
            options.value !== undefined
                ? options.value
                : document && status !== 'closed' && status !== 'destroyed'
                  ? document.read()
                  : undefined;

        return {
            status,
            handle,
            ...(document ? { ref: document.ref } : {}),
            ...(options.transportStrategy ? { transportStrategy: options.transportStrategy } : {}),
            ...(options.update ? { updateId: options.update.updateId } : {}),
            ...(value !== undefined ? { value } : {}),
            ...(options.result !== undefined ? { result: options.result } : {}),
            ...(health !== undefined ? { health } : {}),
            ...(document ? { pendingUpdateCount: document.pendingUpdates().length } : {}),
            ...(document
                ? {
                      failedPendingUpdateCount: document.failedPendingUpdates().length,
                  }
                : {}),
            ...(document
                ? {
                      dependencyBlockedUpdateCount: document.dependencyBlockedUpdates().length,
                  }
                : {}),
            ...(options.attempts !== undefined ? { attempts: options.attempts } : {}),
            ...(options.waitedMs !== undefined ? { waitedMs: options.waitedMs } : {}),
            ...(options.stableForMs !== undefined ? { stableForMs: options.stableForMs } : {}),
            ...(options.conditions ? { conditions: options.conditions } : {}),
            ...(options.lastSyncResult !== undefined ? { lastSyncResult: options.lastSyncResult } : {}),
        };
    }

    function emitCrdtDiagnostic(
        topic: string,
        handle: string,
        data: unknown,
        config?: BlackBoxRallarConnectionConfig,
    ): void {
        emit({
            kind: 'diagnostic',
            topic,
            connection: config?.connection ?? handle,
            actor: config?.actor,
            roomId: config?.roomId,
            ...(config ? scopeDiagnostics(config) : {}),
            data,
        });
    }


    async function crdtOpen(
        rawInput: BlackBoxRallarCrdtOpenInput | unknown,
    ): Promise<BlackBoxRallarCrdtCommandDiagnostics> {
        const input = normalizeCrdtOpenInput(rawInput);
        const handle = crdtHandle(input);
        const generation = lifecycle.generation();
        let config: BlackBoxRallarConnectionConfig | undefined;
        try {
            if (!lifecycle.isCurrent(generation)) {
                throw new Error('CRDT document open was cancelled because the Rallar runtime closed.');
            }
            const document = await crdtController.open(handle, async () => {
                config = await ensureCrdtLiveConnection(input);
                const opened = await rallar.crdt.open(input.name, toCrdtOpenOptions(input));
                if (!lifecycle.isCurrent(generation)) {
                    await opened.close();
                    throw new Error('CRDT document open was cancelled because the Rallar runtime closed.');
                }
                return opened;
            });
            const diagnostics = toCrdtDiagnostics('opened', handle, document, {
                transportStrategy: input.transport,
            });
            emitCrdtDiagnostic('rallar.browser.crdt.opened', handle, diagnostics, config);
            return diagnostics;
        } catch (error) {
            emitError(config, 'rallar.browser.crdt.open_failed', error, {
                handle,
                transportStrategy: input.transport,
            });
            throw error;
        }
    }

    async function runCrdtOperation<TResult>(
        handle: string,
        effect: (
            document: RallarCrdtDocument<unknown, RallarCrdtOperationBatch>,
            assertCurrent: () => void,
        ) => Promise<TResult>,
    ): Promise<TResult> {
        const lease = crdtController.lease();
        crdtController.assertCurrent(lease, 'CRDT operation completed after the runtime closed.');
        return await crdtController.run(handle, async document => {
            const assertCurrent = () =>
                crdtController.assertCurrent(lease, 'CRDT operation completed after the runtime closed.');
            assertCurrent();
            const result = await effect(document, assertCurrent);
            assertCurrent();
            return result;
        });
    }

    async function crdtApply(
        input: BlackBoxRallarCrdtApplyInput | unknown,
    ): Promise<BlackBoxRallarCrdtCommandDiagnostics> {
        const record = asRecord(input);
        const handle = crdtHandle(record);
        const batch = record.batch as RallarCrdtOperationBatch | undefined;
        if (!batch) {
            throw new Error('crdt.apply requires batch.');
        }

        return await runCrdtOperation(handle, async (document, assertCurrent) => {
            try {
                const update = await document.applyLocal(batch);
                assertCurrent();
                const diagnostics = toCrdtDiagnostics('applied', handle, document, {
                    update,
                });
                emitCrdtDiagnostic('rallar.browser.crdt.applied', handle, diagnostics);
                return diagnostics;
            } catch (error) {
                emitError(undefined, 'rallar.browser.crdt.apply_failed', error, { handle });
                throw error;
            }
        });
    }

    async function crdtRead(
        input: BlackBoxRallarCrdtHandleInput | unknown,
    ): Promise<BlackBoxRallarCrdtCommandDiagnostics> {
        const handle = crdtHandle(input);
        const document = requireCrdtDocument(handle);
        const diagnostics = toCrdtDiagnostics('read', handle, document, {
            value: document.read(),
        });
        emitCrdtDiagnostic('rallar.browser.crdt.read', handle, diagnostics);
        return diagnostics;
    }

    async function crdtSync(
        input: BlackBoxRallarCrdtSyncInput | unknown,
    ): Promise<BlackBoxRallarCrdtCommandDiagnostics> {
        const record = asRecord(input);
        const handle = crdtHandle(record);
        const options: RallarCrdtSyncOptions = {
            ...(stringValue(record.reason) ? { reason: stringValue(record.reason) } : {}),
            ...(toCrdtTransport(record.transport) ? { transport: toCrdtTransport(record.transport) } : {}),
        };

        return await runCrdtOperation(handle, async (document, assertCurrent) => {
            try {
                const result = await document.sync(options);
                assertCurrent();
                const diagnostics = toCrdtDiagnostics('synced', handle, document, {
                    result,
                    transportStrategy: toCrdtTransport(record.transport),
                });
                emitCrdtDiagnostic('rallar.browser.crdt.synced', handle, diagnostics);
                return diagnostics;
            } catch (error) {
                emitError(undefined, 'rallar.browser.crdt.sync_failed', error, { handle });
                throw error;
            }
        });
    }

    async function crdtHealth(
        input: BlackBoxRallarCrdtHandleInput | unknown,
    ): Promise<BlackBoxRallarCrdtCommandDiagnostics> {
        const handle = crdtHandle(input);
        const document = requireCrdtDocument(handle);
        const diagnostics = toCrdtDiagnostics('health', handle, document);
        emitCrdtDiagnostic('rallar.browser.crdt.health', handle, diagnostics);
        return diagnostics;
    }

    async function crdtWaitEffect(
        input: BlackBoxRallarCrdtWaitInput,
        document: RallarCrdtDocument<unknown, RallarCrdtOperationBatch>,
        assertCurrent: () => void,
    ): Promise<BlackBoxRallarCrdtCommandDiagnostics> {
        const timeoutMs = input.timeoutMs ?? 10_000;
        const intervalMs = input.intervalMs ?? 250;
        const stableForMs = input.stableForMs ?? 0;
        const startEpochMs = now();
        const deadlineEpochMs = startEpochMs + timeoutMs;
        const operationSignal = lifecycle.operationSignal();
        const syncOptions: RallarCrdtSyncOptions | undefined =
            input.sync && typeof input.sync === 'object'
                ? {
                      ...(input.sync.reason ? { reason: input.sync.reason } : {}),
                      ...(input.sync.transport ? { transport: input.sync.transport } : {}),
                  }
                : undefined;
        let attempts = 0;
        let stableSinceEpochMs: number | undefined;
        let lastSyncResult: unknown;
        let lastValue: unknown;
        let lastHealth: unknown;

        emitCrdtDiagnostic('rallar.browser.crdt.waiting', input.handle, {
            status: 'waiting',
            handle: input.handle,
            ref: document.ref,
            timeoutMs,
            intervalMs,
            stableForMs,
            conditions: input.conditions,
            sync: input.sync,
        });

        try {
            while (true) {
                attempts += 1;
                if (syncOptions) {
                    lastSyncResult = await raceCrdtOperationWithClose(
                        crdtController.track(document.sync(syncOptions)),
                        operationSignal,
                    );
                    assertCurrent();
                }

                lastValue = document.read();
                lastHealth = document.health();
                const currentEpochMs = now();
                const matched = input.conditions.every(condition =>
                    crdtWaitConditionMatches(condition, lastValue, lastHealth),
                );

                if (matched) {
                    stableSinceEpochMs ??= currentEpochMs;
                    if (stableForMs <= 0 || currentEpochMs - stableSinceEpochMs >= stableForMs) {
                        assertCurrent();
                        const diagnostics = toCrdtDiagnostics('wait_matched', input.handle, document, {
                            value: lastValue,
                            result: {
                                matched: true,
                                matchedAtEpochMs: currentEpochMs,
                            },
                            attempts,
                            waitedMs: currentEpochMs - startEpochMs,
                            stableForMs,
                            conditions: input.conditions,
                            lastSyncResult,
                        });
                        emitCrdtDiagnostic('rallar.browser.crdt.wait_matched', input.handle, diagnostics);
                        return diagnostics;
                    }
                } else {
                    stableSinceEpochMs = undefined;
                }

                if (currentEpochMs >= deadlineEpochMs) {
                    throw new Error('Timed out waiting for CRDT conditions on handle: ' + input.handle);
                }

                await waitForCrdtDelay(
                    wait,
                    Math.min(intervalMs, Math.max(0, deadlineEpochMs - currentEpochMs)),
                    operationSignal,
                );
                assertCurrent();
            }
        } catch (error) {
            emitError(undefined, 'rallar.browser.crdt.wait_failed', error, {
                handle: input.handle,
                attempts,
                waitedMs: now() - startEpochMs,
                stableForMs,
                conditions: input.conditions,
                lastValue,
                lastHealth,
                lastSyncResult,
            });
            throw error;
        }
    }

    async function crdtWait(
        rawInput: BlackBoxRallarCrdtWaitInput | unknown,
    ): Promise<BlackBoxRallarCrdtCommandDiagnostics> {
        const input = normalizeCrdtWaitInput(rawInput);
        return await runCrdtOperation(input.handle, (document, assertCurrent) =>
            crdtWaitEffect(input, document, assertCurrent),
        );
    }

    async function crdtUndo(
        input: BlackBoxRallarCrdtUndoRedoInput | unknown,
    ): Promise<BlackBoxRallarCrdtCommandDiagnostics> {
        const record = asRecord(input);
        const handle = crdtHandle(record);
        const targetOperationGroupId = stringValue(record.targetOperationGroupId);
        const operations = Array.isArray(record.operations)
            ? (record.operations as readonly RallarCrdtOperation[])
            : undefined;
        if (!targetOperationGroupId || !operations) {
            throw new Error('crdt.undo requires targetOperationGroupId and operations.');
        }

        return await runCrdtOperation(handle, async (document, assertCurrent) => {
            try {
                const update = await document.undoOperationGroup({
                    targetOperationGroupId,
                    operations,
                    ...(stringValue(record.operationGroupId)
                        ? {
                              operationGroupId: stringValue(record.operationGroupId),
                          }
                        : {}),
                });
                assertCurrent();
                const diagnostics = toCrdtDiagnostics('undone', handle, document, {
                    update,
                });
                emitCrdtDiagnostic('rallar.browser.crdt.undone', handle, diagnostics);
                return diagnostics;
            } catch (error) {
                emitError(undefined, 'rallar.browser.crdt.undo_failed', error, { handle });
                throw error;
            }
        });
    }

    async function crdtRedo(
        input: BlackBoxRallarCrdtUndoRedoInput | unknown,
    ): Promise<BlackBoxRallarCrdtCommandDiagnostics> {
        const record = asRecord(input);
        const handle = crdtHandle(record);
        const targetOperationGroupId = stringValue(record.targetOperationGroupId);
        const operations = Array.isArray(record.operations)
            ? (record.operations as readonly RallarCrdtOperation[])
            : undefined;
        if (!targetOperationGroupId || !operations) {
            throw new Error('crdt.redo requires targetOperationGroupId and operations.');
        }

        return await runCrdtOperation(handle, async (document, assertCurrent) => {
            try {
                const update = await document.redoOperationGroup({
                    targetOperationGroupId,
                    operations,
                    ...(stringValue(record.operationGroupId)
                        ? {
                              operationGroupId: stringValue(record.operationGroupId),
                          }
                        : {}),
                });
                assertCurrent();
                const diagnostics = toCrdtDiagnostics('redone', handle, document, {
                    update,
                });
                emitCrdtDiagnostic('rallar.browser.crdt.redone', handle, diagnostics);
                return diagnostics;
            } catch (error) {
                emitError(undefined, 'rallar.browser.crdt.redo_failed', error, { handle });
                throw error;
            }
        });
    }

    async function crdtClose(
        input: BlackBoxRallarCrdtHandleInput | unknown,
    ): Promise<BlackBoxRallarCrdtCommandDiagnostics> {
        const handle = crdtHandle(input);
        const lease = crdtController.lease();
        crdtController.assertCurrent(lease, 'CRDT operation completed after the runtime closed.');
        const diagnostics = await crdtController.release(handle, async document => {
            const diagnostics = toCrdtDiagnostics('closed', handle, document);
            await document.close();
            return diagnostics;
        });
        crdtController.assertCurrent(lease, 'CRDT operation completed after the runtime closed.');
        emitCrdtDiagnostic('rallar.browser.crdt.closed', handle, diagnostics);
        return diagnostics;
    }

    async function crdtDestroy(
        input: BlackBoxRallarCrdtHandleInput | unknown,
    ): Promise<BlackBoxRallarCrdtCommandDiagnostics> {
        const handle = crdtHandle(input);
        const lease = crdtController.lease();
        crdtController.assertCurrent(lease, 'CRDT operation completed after the runtime closed.');
        const diagnostics = await crdtController.release(handle, async document => {
            const diagnostics = toCrdtDiagnostics('destroyed', handle, document);
            await document.destroy();
            return diagnostics;
        });
        crdtController.assertCurrent(lease, 'CRDT operation completed after the runtime closed.');
        emitCrdtDiagnostic('rallar.browser.crdt.destroyed', handle, diagnostics);
        return diagnostics;
    }


    async function closeAll(
        config?: BlackBoxRallarConnectionConfig,
    ): Promise<readonly unknown[]> {
        const errors: unknown[] = [];
        for (const [handle, document] of crdtController.entries()) {
            try {
                await document.close();
                crdtController.delete(handle);
                emitCrdtDiagnostic(
                    'rallar.browser.crdt.closed',
                    handle,
                    {
                        status: 'closed',
                        handle,
                        ref: document.ref,
                        reason: 'runtime-close',
                    },
                    config,
                );
            } catch (error) {
                errors.push(error);
                emitError(config, 'rallar.browser.crdt.close_failed', error, {
                    handle,
                    reason: 'runtime-close',
                });
            }
        }
        return errors;
    }

    return {
        open: crdtOpen,
        apply: crdtApply,
        read: crdtRead,
        sync: crdtSync,
        health: crdtHealth,
        wait: crdtWait,
        undo: crdtUndo,
        redo: crdtRedo,
        close: crdtClose,
        destroy: crdtDestroy,
        summary: crdtRuntimeSummary,
        pending: crdtController.pending,
        closeAll,
    };
}
