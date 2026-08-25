import { BrowserCrdtDocumentPersistence } from '@shared-web/browser/crdt/browser-crdt-document-persistence.ts';
import { BrowserCrdtDurableCatchUp } from '@shared-web/browser/crdt/browser-crdt-durable-catch-up.ts';
import { BrowserCrdtLiveDiagnostics } from '@shared-web/browser/crdt/browser-crdt-live-diagnostics.ts';
import { BrowserCrdtManualSync } from '@shared-web/browser/crdt/browser-crdt-manual-sync.ts';
import type { BrowserCrdtOperationAuthor } from '@shared-web/browser/crdt/browser-crdt-operation-author.ts';
import {
    createBrowserCrdtRuntimeId,
    normalizeBrowserCrdtSnapshot,
    normalizeBrowserCrdtUpdate,
    sortBrowserCrdtUpdates
} from '@shared-web/browser/crdt/browser-crdt-runtime-values.ts';
import {
    sendRallarCrdtLiveUpdate,
    sendRallarCrdtSyncRequest,
    sendRallarCrdtSyncResponse,
    subscribeRallarCrdtLiveTransport,
    type RallarCrdtMessageTransport,
    type RallarCrdtTransportKind
} from '@shared-web/browser/crdt/browser-crdt-transport.ts';
import type { RallarCrdtHttpCatchUpClient } from '@shared-web/browser/crdt/rallar-crdt-contracts.ts';
import type { RallarUnsubscribe } from '@shared-web/browser/rallar-data.ts';
import {
    RALLAR_CRDT_PROTOCOL_VERSION,
    toRallarCrdtDocumentKey,
    type RallarCrdtDependencyBlockedUpdate,
    type RallarCrdtDocument,
    type RallarCrdtDocumentRef,
    type RallarCrdtDocumentTypePolicy,
    type RallarCrdtFailedPendingUpdate,
    type RallarCrdtJsonValue,
    type RallarCrdtMetricsSink,
    type RallarCrdtOperationBatch,
    type RallarCrdtSyncOptions,
    type RallarCrdtSyncRequestEnvelope,
    type RallarCrdtSyncResponseEnvelope,
    type RallarCrdtSyncResult,
    type RallarCrdtTransportStrategy,
    type RallarCrdtUpdateEnvelope
} from '@shared/crdt/mod.ts';

export namespace BrowserCrdtLiveSync {
    export type Options<TValue, TPayload extends RallarCrdtOperationBatch> = Readonly<{
        ref: RallarCrdtDocumentRef;
        documentKey: string;
        engine: RallarCrdtDocument<TValue, TPayload>;
        operations: BrowserCrdtOperationAuthor<TPayload>;
        persistence: BrowserCrdtDocumentPersistence<TValue, TPayload>;
        pending: Map<string, RallarCrdtUpdateEnvelope<TPayload>>;
        failed: Map<string, RallarCrdtFailedPendingUpdate<TPayload>>;
        dependencyBlocked: Map<string, RallarCrdtDependencyBlockedUpdate<TPayload>>;
        transport: RallarCrdtTransportStrategy;
        policies: readonly RallarCrdtDocumentTypePolicy[];
        metrics?: RallarCrdtMetricsSink;
        durableCatchUp?: RallarCrdtHttpCatchUpClient<TPayload>;
        readTransport?: () => RallarCrdtMessageTransport | undefined;
        now: () => number;
        onSnapshotChanged(): void;
    }>;
}

/** Owns peer live sync and coordinates durable catch-up at transport boundaries. */
export class BrowserCrdtLiveSync<TValue, TPayload extends RallarCrdtOperationBatch> {
    private readonly options: BrowserCrdtLiveSync.Options<TValue, TPayload>;
    private readonly diagnostics: BrowserCrdtLiveDiagnostics;
    private readonly durable: BrowserCrdtDurableCatchUp<TValue, TPayload>;
    private readonly manualSync: BrowserCrdtManualSync<TValue, TPayload>;
    private unsubscribes: RallarUnsubscribe[] = [];
    private closed = false;

    public constructor(options: BrowserCrdtLiveSync.Options<TValue, TPayload>) {
        this.options = options;
        this.diagnostics = new BrowserCrdtLiveDiagnostics({
            documentKey: options.documentKey,
            metrics: options.metrics,
            now: options.now
        });
        this.durable = new BrowserCrdtDurableCatchUp({
            ref: options.ref,
            documentKey: options.documentKey,
            engine: options.engine,
            persistence: options.persistence,
            diagnostics: this.diagnostics,
            durableCatchUp: options.durableCatchUp,
            transport: options.transport,
            policies: options.policies,
            readTransport: options.readTransport,
            now: options.now,
            applyRemoteUpdate: async (update, transport) => {
                await this.applyRemoteUpdate(update, transport);
            }
        });
        this.manualSync = new BrowserCrdtManualSync({
            pending: options.pending,
            dependencyBlocked: options.dependencyBlocked,
            transport: options.transport,
            policies: options.policies,
            readTransport: options.readTransport,
            durable: this.durable,
            diagnostics: this.diagnostics,
            requestLiveCatchUp: async (reason, strategy) => {
                await this.requestLiveCatchUp(reason, strategy);
            }
        });
    }

    public async start(): Promise<void> {
        this.subscribe();
        if (!(await this.durable.requestOverWs('open'))) {
            await this.durable.requestOverHttp('open');
        }
        await this.requestLiveCatchUp('open');
    }

    public close(): void {
        this.closed = true;
        for (const unsubscribe of this.unsubscribes) {
            unsubscribe();
        }
        this.unsubscribes = [];
    }

    public health(): BrowserCrdtLiveDiagnostics.Health {
        return this.diagnostics.health();
    }

    public recordMetric(
        name: Parameters<RallarCrdtMetricsSink['record']>[0]['name'],
        value: number,
        tags?: Readonly<Record<string, string>>
    ): void {
        this.diagnostics.recordMetric(name, value, tags);
    }

    public async sendUpdate(
        update: RallarCrdtUpdateEnvelope<TPayload>
    ): Promise<void> {
        const outcome = await sendRallarCrdtLiveUpdate({
            update,
            transport: this.options.readTransport?.(),
            strategy: this.options.transport,
            policies: this.options.policies
        });
        this.diagnostics.rememberSendOutcome(outcome);
        if (outcome.status === 'failed') {
            this.diagnostics.setSyncError(
                outcome.reason ?? 'CRDT live update send failed.'
            );
        }
    }

    public async sync(
        options: RallarCrdtSyncOptions = {}
    ): Promise<RallarCrdtSyncResult> {
        return await this.manualSync.sync(options);
    }

    public async applyRemoteUpdate(
        update: RallarCrdtUpdateEnvelope<TPayload>,
        transport?: RallarCrdtTransportKind
    ): Promise<void> {
        if (
            this.closed ||
            toRallarCrdtDocumentKey(update.document) !== this.options.documentKey
        ) {
            return;
        }

        const engineUpdate = await this.options.persistence.revealUpdate(update);
        const result = this.options.engine.apply(engineUpdate);
        this.diagnostics.rememberApplyResult(result, transport);
        if (result.status === 'applied' || result.status === 'duplicate') {
            this.options.operations.remember(engineUpdate);
        }
        await this.options.persistence.persistApplyResult(update, result);
        if (result.status === 'applied' || result.status === 'duplicate') {
            this.options.onSnapshotChanged();
        }
    }

    private subscribe(): void {
        this.unsubscribes = [
            ...subscribeRallarCrdtLiveTransport<TPayload>({
                ref: this.options.ref,
                transport: this.options.readTransport?.(),
                strategy: this.options.transport,
                policies: this.options.policies,
                onUpdate: async (update, transport) => {
                    await this.applyRemoteUpdate(update, transport);
                },
                onSyncRequest: async (request, transport) => {
                    await this.handleSyncRequest(request, transport);
                },
                onSyncResponse: async (response, transport) => {
                    await this.handleSyncResponse(response, transport);
                },
                onAppendResponse: async (response) => {
                    await this.durable.handleAppendResponse(response);
                },
                onCatchUpResponse: async (response, transport) => {
                    await this.durable.handleResponse(response, transport);
                }
            })
        ];
    }

    private async requestLiveCatchUp(
        reason: string,
        strategy: RallarCrdtTransportStrategy = this.options.transport
    ): Promise<void> {
        if (strategy === 'local-only') {
            return;
        }
        const request: RallarCrdtSyncRequestEnvelope = {
            protocolVersion: RALLAR_CRDT_PROTOCOL_VERSION,
            document: this.options.ref,
            requestId: createBrowserCrdtRuntimeId('sync-request'),
            replicaId: this.options.engine.replicaId,
            createdAtEpochMs: this.options.now(),
            knownUpdateIds: Array.from(this.options.engine.seenUpdateIds()).sort(),
            missingUpdateIds: this.options.engine.dependencyState().missingUpdateIds,
            maxUpdateCount: 100
        };
        const outcome = await sendRallarCrdtSyncRequest({
            request,
            transport: this.options.readTransport?.(),
            strategy,
            policies: this.options.policies
        });
        this.diagnostics.rememberSendOutcome(outcome);
        if (outcome.status === 'sent') {
            this.diagnostics.rememberSyncRequest();
        }
        else if (outcome.status === 'failed') {
            this.diagnostics.setSyncError(
                outcome.reason ?? `CRDT live catch-up request failed: ${reason}.`
            );
        }
    }

    private async handleSyncRequest(
        request: RallarCrdtSyncRequestEnvelope,
        transport: RallarCrdtTransportKind
    ): Promise<void> {
        if (
            toRallarCrdtDocumentKey(request.document) !==
                this.options.documentKey ||
            request.replicaId === this.options.engine.replicaId
        ) {
            return;
        }

        const known = new Set(request.knownUpdateIds);
        const missingFilter = request.missingUpdateIds?.length
            ? new Set(request.missingUpdateIds)
            : undefined;
        const updates = this.pendingUpdates()
            .filter((update) => !known.has(update.updateId))
            .filter((update) => missingFilter ? missingFilter.has(update.updateId) : true)
            .slice(0, request.maxUpdateCount ?? 100);
        const response: RallarCrdtSyncResponseEnvelope<RallarCrdtJsonValue, TPayload> = {
            protocolVersion: RALLAR_CRDT_PROTOCOL_VERSION,
            document: this.options.ref,
            requestId: request.requestId,
            responseId: createBrowserCrdtRuntimeId('sync-response'),
            replicaId: this.options.engine.replicaId,
            createdAtEpochMs: this.options.now(),
            updates,
            hasMore: updates.length >= (request.maxUpdateCount ?? 100),
            reason: 'peer-catch-up-development-only'
        };
        const outcome = await sendRallarCrdtSyncResponse({
            response,
            transport: this.options.readTransport?.(),
            replyTransport: transport,
            policies: this.options.policies
        });
        this.diagnostics.rememberSendOutcome(outcome);
        if (outcome.status === 'sent') {
            this.diagnostics.rememberSyncResponse();
        }
    }

    private async handleSyncResponse(
        response: RallarCrdtSyncResponseEnvelope,
        transport: RallarCrdtTransportKind
    ): Promise<void> {
        if (
            toRallarCrdtDocumentKey(response.document) !==
                this.options.documentKey ||
            response.replicaId === this.options.engine.replicaId
        ) {
            return;
        }

        this.diagnostics.rememberSyncResponse();
        if (response.snapshot) {
            this.options.engine.importSnapshot(
                await this.options.persistence.revealSnapshot(
                    normalizeBrowserCrdtSnapshot(response.snapshot)
                )
            );
        }
        for (const update of response.updates) {
            await this.applyRemoteUpdate(
                normalizeBrowserCrdtUpdate<TPayload>(update),
                transport
            );
        }
    }

    private pendingUpdates(): readonly RallarCrdtUpdateEnvelope<TPayload>[] {
        return sortBrowserCrdtUpdates([...this.options.pending.values()]);
    }
}
