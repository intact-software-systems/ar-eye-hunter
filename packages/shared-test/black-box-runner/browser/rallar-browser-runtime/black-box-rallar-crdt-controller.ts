import { crdtCatchUpHttpApi } from '@shared-web/browser/crdt/crdt-catch-up-http-api.ts';
import type { RallarCrdtDocument, RallarCrdtOpenOptions, RallarFacade } from '@shared-web/browser/rallar.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import type {
    RallarCrdtDocumentHealth,
    RallarCrdtJsonValue,
    RallarCrdtOperationBatch,
    RallarCrdtSyncOptions,
    RallarCrdtSyncResult,
    RallarCrdtTransportStrategy,
    RallarCrdtUpdateEnvelope
} from '@shared/crdt/mod.ts';
import { toError } from '@shared/resilience/to-error.ts';
import { BlackBoxRallarCrdtResourceController } from './black-box-rallar-crdt-resource-controller.ts';
import type { BlackBoxRallarRuntimeDiagnostics } from './black-box-rallar-diagnostics.ts';
import type {
    BlackBoxRallarConnectionConfig,
    BlackBoxRallarCrdtCommandDiagnostics,
    BlackBoxRallarCrdtOpenInput,
    BlackBoxRallarCrdtRuntime,
    BlackBoxRallarCrdtRuntimeSummary,
    BlackBoxRallarCrdtWaitCondition,
    BlackBoxRallarCrdtWaitInput,
    BlackBoxRallarEvent
} from './black-box-rallar-operation-contracts.ts';
import type { BlackBoxRallarScopeDiagnostics } from './black-box-rallar-operation-policy.ts';
import {
    decodeBlackBoxRallarCrdtApplyInput,
    decodeBlackBoxRallarCrdtHandle,
    decodeBlackBoxRallarCrdtOpenInput,
    decodeBlackBoxRallarCrdtSyncInput,
    decodeBlackBoxRallarCrdtUndoRedoInput,
    decodeBlackBoxRallarCrdtWaitInput
} from './decode-black-box-rallar-crdt-input.ts';
import { matchesBlackBoxRallarCrdtWaitCondition } from './matches-black-box-rallar-crdt-wait-condition.ts';
import type { BlackBoxRallarGenerationPort } from './ports.ts';

const DEFAULT_WORKSPACE_ID = 'default';

function raceCrdtOperationWithClose<TResult>(
    operation: Promise<TResult>,
    signal: AbortSignal
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
            (result) => settle(() => resolve(result)),
            (caught) => settle(() => reject(toError(caught)))
        );
    });
}

export namespace BlackBoxRallarCrdtController {
    export interface Input extends BlackBoxRallarGenerationPort {
        operationSignal(): AbortSignal;
        readonly facade: Pick<RallarFacade, 'crdt' | 'isConnected'>;
        now(): number;
        delay(ms: number): Promise<void>;
        currentConnectionConfig(): BlackBoxRallarConnectionConfig | undefined;
        ensureLiveConnection(
            config: BlackBoxRallarConnectionConfig,
            transport: RallarCrdtTransportStrategy
        ): Promise<void>;
        scopeDiagnostics(config: BlackBoxRallarConnectionConfig): BlackBoxRallarScopeDiagnostics;
        emit(event: Omit<BlackBoxRallarEvent, 'atEpochMs'>): void;
        readonly emitError: BlackBoxRallarRuntimeDiagnostics['emitError'];
    }

    export type DocumentOperation<TResult> = (
        document: RallarCrdtDocument<RallarCrdtJsonValue>,
        assertCurrent: () => void
    ) => Promise<TResult>;

    export interface WaitProgress {
        readonly startEpochMs: number;
        attempts: number;
        stableSinceEpochMs?: number;
        lastSyncResult?: RallarCrdtSyncResult;
        lastValue?: RallarCrdtJsonValue;
        lastHealth?: RallarCrdtDocumentHealth;
    }

    export interface WaitRequest {
        readonly input: BlackBoxRallarCrdtWaitInput;
        readonly document: RallarCrdtDocument<RallarCrdtJsonValue>;
        readonly assertCurrent: () => void;
        readonly signal: AbortSignal;
        readonly progress: WaitProgress;
    }

    export interface DiagnosticsInput {
        readonly update?: RallarCrdtUpdateEnvelope<RallarCrdtOperationBatch>;
        readonly result?: BlackBoxRallarCrdtCommandDiagnostics['result'];
        readonly value?: RallarCrdtJsonValue;
        readonly transportStrategy?: RallarCrdtTransportStrategy;
        readonly attempts?: number;
        readonly waitedMs?: number;
        readonly stableForMs?: number;
        readonly conditions?: readonly BlackBoxRallarCrdtWaitCondition[];
        readonly lastSyncResult?: RallarCrdtSyncResult;
    }
}

export class BlackBoxRallarCrdtController implements BlackBoxRallarCrdtRuntime {
    readonly #input: BlackBoxRallarCrdtController.Input;

    readonly #resources: BlackBoxRallarCrdtResourceController<RallarCrdtDocument<RallarCrdtJsonValue>>;

    public constructor(input: BlackBoxRallarCrdtController.Input) {
        this.#input = input;
        this.#resources = new BlackBoxRallarCrdtResourceController(input);
    }

    public async open(
        rawInput: unknown
    ): Promise<BlackBoxRallarCrdtCommandDiagnostics> {
        const input = decodeBlackBoxRallarCrdtOpenInput(rawInput);
        const handle = input.handle ?? input.name;
        const openOptions = this.#toCrdtOpenOptions(input);
        const generation = this.#input.generation();
        let config: BlackBoxRallarConnectionConfig | undefined;
        try {
            if (!this.#input.isCurrent(generation)) {
                throw new Error('CRDT document open was cancelled because the Rallar runtime closed.');
            }
            const document = await this.#resources.open(handle, async () => {
                config = await this.#ensureCrdtLiveConnection(input);
                const opened = await this.#input.facade.crdt.open<RallarCrdtJsonValue>(
                    input.name,
                    openOptions
                );
                if (!this.#input.isCurrent(generation)) {
                    await opened.close();
                    throw new Error('CRDT document open was cancelled because the Rallar runtime closed.');
                }
                return opened;
            });
            const diagnostics = this.#toCrdtDiagnostics('opened', handle, document, {
                transportStrategy: input.transport
            });
            this.#emitCrdtDiagnostic('rallar.browser.crdt.opened', handle, diagnostics, config);
            return diagnostics;
        }
        catch (caught) {
            const error = toError(caught);
            this.#input.emitError({
                config,
                topic: 'rallar.browser.crdt.open_failed',
                error,
                data: {
                    handle,
                    transportStrategy: input.transport
                }
            });
            throw error;
        }
    }

    public async apply(
        input: unknown
    ): Promise<BlackBoxRallarCrdtCommandDiagnostics> {
        const { handle, batch } = decodeBlackBoxRallarCrdtApplyInput(input);

        return await this.#runCrdtOperation(handle, async (document, assertCurrent) => {
            try {
                const update = await document.applyLocal(batch);
                assertCurrent();
                const diagnostics = this.#toCrdtDiagnostics('applied', handle, document, {
                    update
                });
                this.#emitCrdtDiagnostic('rallar.browser.crdt.applied', handle, diagnostics);
                return diagnostics;
            }
            catch (caught) {
                const error = toError(caught);
                this.#input.emitError({
                    config: undefined,
                    topic: 'rallar.browser.crdt.apply_failed',
                    error,
                    data: { handle }
                });
                throw error;
            }
        });
    }

    public async read(
        input: unknown
    ): Promise<BlackBoxRallarCrdtCommandDiagnostics> {
        const handle = decodeBlackBoxRallarCrdtHandle(input);
        const document = this.#resources.require(handle);
        const diagnostics = this.#toCrdtDiagnostics('read', handle, document, {
            value: document.read()
        });
        this.#emitCrdtDiagnostic('rallar.browser.crdt.read', handle, diagnostics);
        return diagnostics;
    }

    public async sync(
        input: unknown
    ): Promise<BlackBoxRallarCrdtCommandDiagnostics> {
        const { handle, reason, transport } = decodeBlackBoxRallarCrdtSyncInput(input);
        const options: RallarCrdtSyncOptions = { reason, transport };

        return await this.#runCrdtOperation(handle, async (document, assertCurrent) => {
            try {
                const result = await document.sync(options);
                assertCurrent();
                const diagnostics = this.#toCrdtDiagnostics('synced', handle, document, {
                    result,
                    transportStrategy: transport
                });
                this.#emitCrdtDiagnostic('rallar.browser.crdt.synced', handle, diagnostics);
                return diagnostics;
            }
            catch (caught) {
                const error = toError(caught);
                this.#input.emitError({
                    config: undefined,
                    topic: 'rallar.browser.crdt.sync_failed',
                    error,
                    data: { handle }
                });
                throw error;
            }
        });
    }

    public async health(
        input: unknown
    ): Promise<BlackBoxRallarCrdtCommandDiagnostics> {
        const handle = decodeBlackBoxRallarCrdtHandle(input);
        const document = this.#resources.require(handle);
        const diagnostics = this.#toCrdtDiagnostics('health', handle, document);
        this.#emitCrdtDiagnostic('rallar.browser.crdt.health', handle, diagnostics);
        return diagnostics;
    }

    public async wait(
        rawInput: unknown
    ): Promise<BlackBoxRallarCrdtCommandDiagnostics> {
        const input = decodeBlackBoxRallarCrdtWaitInput(rawInput);
        return await this.#runCrdtOperation(
            input.handle,
            (document, assertCurrent) =>
                this.#crdtWaitEffect({
                    input,
                    document,
                    assertCurrent,
                    signal: this.#input.operationSignal(),
                    progress: { attempts: 0, startEpochMs: this.#input.now() }
                })
        );
    }

    public async undo(
        input: unknown
    ): Promise<BlackBoxRallarCrdtCommandDiagnostics> {
        const { handle, targetOperationGroupId, operations, operationGroupId } = decodeBlackBoxRallarCrdtUndoRedoInput(
            input
        );

        return await this.#runCrdtOperation(handle, async (document, assertCurrent) => {
            try {
                const update = await document.undoOperationGroup({
                    targetOperationGroupId,
                    operations,
                    ...(operationGroupId ? { operationGroupId } : {})
                });
                assertCurrent();
                const diagnostics = this.#toCrdtDiagnostics('undone', handle, document, {
                    update
                });
                this.#emitCrdtDiagnostic('rallar.browser.crdt.undone', handle, diagnostics);
                return diagnostics;
            }
            catch (caught) {
                const error = toError(caught);
                this.#input.emitError({
                    config: undefined,
                    topic: 'rallar.browser.crdt.undo_failed',
                    error,
                    data: { handle }
                });
                throw error;
            }
        });
    }

    public async redo(
        input: unknown
    ): Promise<BlackBoxRallarCrdtCommandDiagnostics> {
        const { handle, targetOperationGroupId, operations, operationGroupId } = decodeBlackBoxRallarCrdtUndoRedoInput(
            input
        );

        return await this.#runCrdtOperation(handle, async (document, assertCurrent) => {
            try {
                const update = await document.redoOperationGroup({
                    targetOperationGroupId,
                    operations,
                    ...(operationGroupId ? { operationGroupId } : {})
                });
                assertCurrent();
                const diagnostics = this.#toCrdtDiagnostics('redone', handle, document, {
                    update
                });
                this.#emitCrdtDiagnostic('rallar.browser.crdt.redone', handle, diagnostics);
                return diagnostics;
            }
            catch (caught) {
                const error = toError(caught);
                this.#input.emitError({
                    config: undefined,
                    topic: 'rallar.browser.crdt.redo_failed',
                    error,
                    data: { handle }
                });
                throw error;
            }
        });
    }

    public async close(
        input: unknown
    ): Promise<BlackBoxRallarCrdtCommandDiagnostics> {
        const handle = decodeBlackBoxRallarCrdtHandle(input);
        const lease = this.#resources.lease();
        this.#resources.assertCurrent(lease, 'CRDT operation completed after the runtime closed.');
        const diagnostics = await this.#resources.release(handle, async (document) => {
            const diagnostics = this.#toCrdtDiagnostics('closed', handle, document);
            await document.close();
            return diagnostics;
        });
        this.#resources.assertCurrent(lease, 'CRDT operation completed after the runtime closed.');
        this.#emitCrdtDiagnostic('rallar.browser.crdt.closed', handle, diagnostics);
        return diagnostics;
    }

    public async destroy(
        input: unknown
    ): Promise<BlackBoxRallarCrdtCommandDiagnostics> {
        const handle = decodeBlackBoxRallarCrdtHandle(input);
        const lease = this.#resources.lease();
        this.#resources.assertCurrent(lease, 'CRDT operation completed after the runtime closed.');
        const diagnostics = await this.#resources.release(handle, async (document) => {
            const diagnostics = this.#toCrdtDiagnostics('destroyed', handle, document);
            await document.destroy();
            return diagnostics;
        });
        this.#resources.assertCurrent(lease, 'CRDT operation completed after the runtime closed.');
        this.#emitCrdtDiagnostic('rallar.browser.crdt.destroyed', handle, diagnostics);
        return diagnostics;
    }

    public summary(): BlackBoxRallarCrdtRuntimeSummary {
        return {
            handles: this.#resources.handles(),
            documents: this.#resources.entries().map(([handle, document]) => ({
                handle,
                ref: document.ref,
                health: document.health()
            }))
        };
    }

    public pending(): readonly Promise<void>[] {
        return this.#resources.pending();
    }

    public async closeAll(
        config?: BlackBoxRallarConnectionConfig
    ): Promise<readonly Error[]> {
        const errors: Error[] = [];
        for (const [handle, document] of this.#resources.entries()) {
            try {
                await document.close();
                this.#resources.delete(handle);
                this.#emitCrdtDiagnostic(
                    'rallar.browser.crdt.closed',
                    handle,
                    {
                        status: 'closed',
                        handle,
                        ref: document.ref,
                        reason: 'runtime-close'
                    },
                    config
                );
            }
            catch (caught) {
                const error = toError(caught);
                errors.push(error);
                this.#input.emitError({
                    config,
                    topic: 'rallar.browser.crdt.close_failed',
                    error,
                    data: {
                        handle,
                        reason: 'runtime-close'
                    }
                });
            }
        }
        return errors;
    }

    #crdtRoomRef(input: BlackBoxRallarCrdtOpenInput): GroupRef | undefined {
        const explicit = input.roomRef;
        if (explicit?.applicationId && explicit.groupId) {
            return {
                applicationId: explicit.applicationId,
                workspaceId: explicit.workspaceId ?? DEFAULT_WORKSPACE_ID,
                groupId: explicit.groupId
            };
        }

        const roomId = input.roomId;
        const applicationId = input.applicationId ?? input.scope?.applicationId;
        if (!roomId || !applicationId) {
            return undefined;
        }

        const workspaceId = input.workspaceId ?? input.scope?.workspaceId;

        return {
            applicationId,
            workspaceId: workspaceId ?? DEFAULT_WORKSPACE_ID,
            groupId: roomId
        };
    }

    #toCrdtOpenScope(input: BlackBoxRallarCrdtOpenInput): RallarCrdtOpenOptions['scope'] {
        const scope = input.scope;
        const kind = scope?.kind;
        const roomRef = this.#crdtRoomRef(input);
        if (kind === 'app') {
            return { kind: 'app' };
        }
        if (kind === 'principal') {
            const principalId = scope?.principalId ?? input.principalId;
            if (!principalId) {
                throw new Error('CRDT principal scope requires principalId.');
            }
            return { kind: 'principal', principalId };
        }
        if (kind === 'custom') {
            const customScope = scope?.customScope ?? input.customScope;
            if (!customScope) {
                throw new Error('CRDT custom scope requires customScope.');
            }
            return { kind: 'custom', customScope };
        }
        if (kind === 'room') {
            if (!roomRef) {
                throw new Error('CRDT room scope requires a scoped room reference.');
            }
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

    #toCrdtConnectionConfig(input: BlackBoxRallarCrdtOpenInput): BlackBoxRallarConnectionConfig {
        const roomRef = this.#crdtRoomRef(input);
        const applicationId = input.applicationId ?? roomRef?.applicationId;
        const workspaceId = input.workspaceId ?? roomRef?.workspaceId ??
            DEFAULT_WORKSPACE_ID;
        const scope = applicationId
            ? {
                applicationId,
                workspaceId
            }
            : undefined;

        return {
            connection: input.handle ?? input.name,
            actor: input.actor,
            roomId: input.roomId ?? roomRef?.groupId,
            ...(roomRef ? { roomRef } : {}),
            rallar: {
                ...input.rallar,
                expectedSessionId: input.sessionId ?? input.rallar?.expectedSessionId,
                apiBaseUrl: input.apiBaseUrl ?? '',
                ...(input.username ? { username: input.username } : {}),
                ...(input.password ? { password: input.password } : {}),
                ...(input.displayName ? { displayName: input.displayName } : {}),
                ...(input.register !== undefined ? { register: input.register } : {}),
                ...(applicationId ? { applicationId } : {}),
                ...(workspaceId ? { workspaceId } : {}),
                ...(scope ? { scope } : {}),
                ...(roomRef ? { roomRef } : {}),
                ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
                transport: 'realtime'
            }
        };
    }

    #toCrdtOpenOptions(
        input: BlackBoxRallarCrdtOpenInput
    ): RallarCrdtOpenOptions<RallarCrdtJsonValue> {
        const scope = this.#toCrdtOpenScope(input);
        return {
            ...(input.applicationId ? { applicationId: input.applicationId } : {}),
            ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
            ...(input.documentId ? { documentId: input.documentId } : {}),
            ...(input.documentType ? { documentType: input.documentType } : {}),
            ...(scope ? { scope } : {}),
            ...(input.transport ? { transport: input.transport } : {}),
            ...(input.persist !== undefined ? { persist: input.persist } : {}),
            ...(input.tabSync !== undefined ? { tabSync: input.tabSync } : {}),
            ...(input.initialValue !== undefined ? { initialValue: input.initialValue } : {}),
            ...(input.policies ? { policies: input.policies } : {}),
            ...(input.validation ? { validation: input.validation } : {}),
            ...(input.encryption ? { encryption: input.encryption } : {}),
            ...(input.actor ? { actorId: input.actor } : {}),
            ...(input.sessionId ? { sessionId: input.sessionId } : {}),
            ...(input.durableCatchUp === 'http'
                ? { durableCatchUp: crdtCatchUpHttpApi.catchUpDocument }
                : {})
        };
    }

    async #ensureCrdtLiveConnection(
        input: BlackBoxRallarCrdtOpenInput
    ): Promise<BlackBoxRallarConnectionConfig | undefined> {
        if ((input.transport ?? 'local-only') === 'local-only') {
            return undefined;
        }
        if (!input.apiBaseUrl) {
            if (this.#input.facade.isConnected()) {
                return this.#input.currentConnectionConfig();
            }
            throw new Error('crdt.open requires apiBaseUrl or an existing Rallar connection for live transports.');
        }

        const config = this.#toCrdtConnectionConfig(input);
        await this.#input.ensureLiveConnection(config, input.transport ?? 'ws');
        return config;
    }

    #toCrdtDiagnostics(
        status: BlackBoxRallarCrdtCommandDiagnostics['status'],
        handle: string,
        document: RallarCrdtDocument<RallarCrdtJsonValue>,
        options: BlackBoxRallarCrdtController.DiagnosticsInput = {}
    ): BlackBoxRallarCrdtCommandDiagnostics {
        const health = document.health();
        let value = options.value;
        if (value === undefined && status !== 'closed' && status !== 'destroyed') {
            value = document.read();
        }

        return {
            status,
            handle,
            ref: document.ref,
            ...(options.transportStrategy ? { transportStrategy: options.transportStrategy } : {}),
            ...(options.update ? { updateId: options.update.updateId } : {}),
            ...(value !== undefined ? { value } : {}),
            ...(options.result !== undefined ? { result: options.result } : {}),
            health,
            pendingUpdateCount: document.pendingUpdates().length,
            failedPendingUpdateCount: document.failedPendingUpdates().length,
            dependencyBlockedUpdateCount: document.dependencyBlockedUpdates().length,
            ...(options.attempts !== undefined ? { attempts: options.attempts } : {}),
            ...(options.waitedMs !== undefined ? { waitedMs: options.waitedMs } : {}),
            ...(options.stableForMs !== undefined ? { stableForMs: options.stableForMs } : {}),
            ...(options.conditions ? { conditions: options.conditions } : {}),
            ...(options.lastSyncResult !== undefined ? { lastSyncResult: options.lastSyncResult } : {})
        };
    }

    #emitCrdtDiagnostic(
        topic: string,
        handle: string,
        data: BlackBoxRallarEvent['data'],
        config?: BlackBoxRallarConnectionConfig
    ): void {
        this.#input.emit({
            kind: 'diagnostic',
            topic,
            connection: config?.connection ?? handle,
            actor: config?.actor,
            roomId: config?.roomId,
            ...(config ? this.#input.scopeDiagnostics(config) : {}),
            data
        });
    }

    async #runCrdtOperation<TResult>(
        handle: string,
        effect: BlackBoxRallarCrdtController.DocumentOperation<TResult>
    ): Promise<TResult> {
        const lease = this.#resources.lease();
        this.#resources.assertCurrent(lease, 'CRDT operation completed after the runtime closed.');
        return await this.#resources.run(handle, async (document) => {
            const assertCurrent = () =>
                this.#resources.assertCurrent(lease, 'CRDT operation completed after the runtime closed.');
            assertCurrent();
            const result = await effect(document, assertCurrent);
            assertCurrent();
            return result;
        });
    }

    async #pollCrdtWait(
        request: BlackBoxRallarCrdtController.WaitRequest
    ): Promise<BlackBoxRallarCrdtCommandDiagnostics> {
        const { input, document, progress } = request;
        const deadlineEpochMs = progress.startEpochMs + (input.timeoutMs ?? 10_000);
        const stableForMs = input.stableForMs ?? 0;
        while (true) {
            progress.attempts += 1;
            if (input.sync) {
                progress.lastSyncResult = await raceCrdtOperationWithClose(
                    this.#resources.track(document.sync(input.sync)),
                    request.signal
                );
                request.assertCurrent();
            }
            const value = document.read();
            const health = document.health();
            progress.lastValue = value;
            progress.lastHealth = health;
            const currentEpochMs = this.#input.now();
            const matched = input.conditions.every((condition) =>
                matchesBlackBoxRallarCrdtWaitCondition(condition, value, health)
            );
            if (matched) {
                progress.stableSinceEpochMs ??= currentEpochMs;
                if (currentEpochMs - progress.stableSinceEpochMs >= stableForMs) {
                    request.assertCurrent();
                    return this.#toCrdtDiagnostics('wait_matched', input.handle, document, {
                        value,
                        result: { matched: true, matchedAtEpochMs: currentEpochMs },
                        attempts: progress.attempts,
                        waitedMs: currentEpochMs - progress.startEpochMs,
                        stableForMs,
                        conditions: input.conditions,
                        lastSyncResult: progress.lastSyncResult
                    });
                }
            }
            else {
                progress.stableSinceEpochMs = undefined;
            }
            if (currentEpochMs >= deadlineEpochMs) {
                throw new Error('Timed out waiting for CRDT conditions on handle: ' + input.handle);
            }
            await raceCrdtOperationWithClose(
                this.#input.delay(Math.min(input.intervalMs ?? 250, Math.max(0, deadlineEpochMs - currentEpochMs))),
                request.signal
            );
            request.assertCurrent();
        }
    }

    async #crdtWaitEffect(
        request: BlackBoxRallarCrdtController.WaitRequest
    ): Promise<BlackBoxRallarCrdtCommandDiagnostics> {
        const { input, document, progress } = request;
        this.#emitCrdtDiagnostic('rallar.browser.crdt.waiting', input.handle, {
            status: 'waiting',
            handle: input.handle,
            ref: document.ref,
            timeoutMs: input.timeoutMs ?? 10_000,
            intervalMs: input.intervalMs ?? 250,
            stableForMs: input.stableForMs ?? 0,
            conditions: input.conditions,
            sync: input.sync
        });
        try {
            const diagnostics = await this.#pollCrdtWait(request);
            this.#emitCrdtDiagnostic('rallar.browser.crdt.wait_matched', input.handle, diagnostics);
            return diagnostics;
        }
        catch (caught) {
            const error = toError(caught);
            this.#input.emitError({
                config: undefined,
                topic: 'rallar.browser.crdt.wait_failed',
                error,
                data: {
                    handle: input.handle,
                    attempts: progress.attempts,
                    waitedMs: this.#input.now() - progress.startEpochMs,
                    stableForMs: input.stableForMs ?? 0,
                    conditions: input.conditions,
                    lastValue: progress.lastValue,
                    lastHealth: progress.lastHealth,
                    lastSyncResult: progress.lastSyncResult
                }
            });
            throw error;
        }
    }
}
