import type { BrowserCrdtDurableCatchUp } from '@shared-web/browser/crdt/browser-crdt-durable-catch-up.ts';
import type { BrowserCrdtLiveDiagnostics } from '@shared-web/browser/crdt/browser-crdt-live-diagnostics.ts';
import { sortBrowserCrdtUpdates } from '@shared-web/browser/crdt/browser-crdt-runtime-values.ts';
import {
    sendRallarCrdtLiveUpdate,
    type RallarCrdtMessageTransport
} from '@shared-web/browser/crdt/browser-crdt-transport.ts';
import type {
    RallarCrdtDependencyBlockedUpdate,
    RallarCrdtDocumentTypePolicy,
    RallarCrdtOperationBatch,
    RallarCrdtSyncOptions,
    RallarCrdtSyncResult,
    RallarCrdtTransportStrategy,
    RallarCrdtUpdateEnvelope
} from '@shared/crdt/mod.ts';

export namespace BrowserCrdtManualSync {
    export type Options<TValue, TPayload extends RallarCrdtOperationBatch> = Readonly<{
        pending: Map<string, RallarCrdtUpdateEnvelope<TPayload>>;
        dependencyBlocked: Map<string, RallarCrdtDependencyBlockedUpdate<TPayload>>;
        transport: RallarCrdtTransportStrategy;
        policies: readonly RallarCrdtDocumentTypePolicy[];
        readTransport?: () => RallarCrdtMessageTransport | undefined;
        durable: BrowserCrdtDurableCatchUp<TValue, TPayload>;
        diagnostics: BrowserCrdtLiveDiagnostics;
        requestLiveCatchUp(
            reason: string,
            strategy: RallarCrdtTransportStrategy
        ): Promise<void>;
    }>;
}

/** Owns the explicit document.sync transport-selection policy. */
export class BrowserCrdtManualSync<TValue, TPayload extends RallarCrdtOperationBatch> {
    private readonly options: BrowserCrdtManualSync.Options<TValue, TPayload>;

    public constructor(
        options: BrowserCrdtManualSync.Options<TValue, TPayload>
    ) {
        this.options = options;
    }

    public async sync(
        options: RallarCrdtSyncOptions = {}
    ): Promise<RallarCrdtSyncResult> {
        const transport = options.transport ?? this.options.transport;
        if (transport === 'local-only') {
            return this.finishLocalOnlySync(options.reason);
        }
        const liveTransport = this.options.readTransport?.();
        if (!liveTransport) {
            return await this.syncWithoutLiveTransport(transport, options.reason);
        }
        return await this.syncPendingUpdates(transport, liveTransport, options.reason);
    }

    private finishLocalOnlySync(reason: string | undefined): RallarCrdtSyncResult {
        return this.finish({
            status: 'local-only',
            transport: 'local-only',
            sentUpdateCount: 0,
            receivedUpdateCount: 0,
            pendingUpdateCount: this.options.pending.size,
            dependencyBlockedUpdateCount: this.options.dependencyBlocked.size,
            reason: reason ?? 'Document is opened in local-only mode.'
        });
    }

    private async syncWithoutLiveTransport(
        transport: RallarCrdtTransportStrategy,
        reason: string | undefined
    ): Promise<RallarCrdtSyncResult> {
        const receivedHttpCatchUp = await this.options.durable.requestOverHttp(
            reason ?? 'manual-sync'
        );
        const result: RallarCrdtSyncResult = {
            status: receivedHttpCatchUp ? 'synced' : 'deferred',
            transport,
            sentUpdateCount: 0,
            receivedUpdateCount: 0,
            pendingUpdateCount: this.options.pending.size,
            dependencyBlockedUpdateCount: this.options.dependencyBlocked.size,
            reason: receivedHttpCatchUp
                ? undefined
                : 'No CRDT live transport is configured.'
        };
        this.options.diagnostics.recordSync(result);
        return result;
    }

    private async syncPendingUpdates(
        transport: RallarCrdtTransportStrategy,
        liveTransport: RallarCrdtMessageTransport,
        reason: string | undefined
    ): Promise<RallarCrdtSyncResult> {
        const sendResult = await this.sendPendingUpdates(transport, liveTransport);
        await this.requestCatchUp(reason ?? 'manual-sync', transport);
        const status = resolveManualSyncStatus(sendResult);
        return this.finish({
            status,
            transport,
            sentUpdateCount: sendResult.sentUpdateCount,
            receivedUpdateCount: 0,
            pendingUpdateCount: this.options.pending.size,
            dependencyBlockedUpdateCount: this.options.dependencyBlocked.size,
            reason: sendResult.deferredReason,
            error: status === 'failed'
                ? (sendResult.deferredReason ?? 'CRDT live sync failed.')
                : undefined
        });
    }

    private async sendPendingUpdates(
        transport: RallarCrdtTransportStrategy,
        liveTransport: RallarCrdtMessageTransport
    ) {
        let sentUpdateCount = 0;
        let failedCount = 0;
        let deferredReason: string | undefined;
        for (const update of this.pendingUpdates()) {
            this.options.diagnostics.rememberRetry();
            const outcome = await sendRallarCrdtLiveUpdate({
                update,
                transport: liveTransport,
                strategy: transport,
                policies: this.options.policies
            });
            sentUpdateCount += outcome.sentCount;
            failedCount += outcome.failedCount;
            deferredReason ??= outcome.reason;
            this.options.diagnostics.rememberSendOutcome(outcome);
        }
        return { sentUpdateCount, failedCount, deferredReason };
    }

    private async requestCatchUp(
        reason: string,
        transport: RallarCrdtTransportStrategy
    ): Promise<void> {
        if (!(await this.options.durable.requestOverWs(reason, transport))) {
            await this.options.durable.requestOverHttp(reason);
        }
        await this.options.requestLiveCatchUp(reason, transport);
    }

    private pendingUpdates(): readonly RallarCrdtUpdateEnvelope<TPayload>[] {
        return sortBrowserCrdtUpdates([...this.options.pending.values()]);
    }

    private finish(result: RallarCrdtSyncResult): RallarCrdtSyncResult {
        this.options.diagnostics.setSyncError(
            result.status === 'failed' ? result.error : undefined
        );
        this.options.diagnostics.recordSync(result);
        return result;
    }
}

function resolveManualSyncStatus(
    sendResult: Readonly<{
        sentUpdateCount: number;
        failedCount: number;
        deferredReason: string | undefined;
    }>
): RallarCrdtSyncResult['status'] {
    if (sendResult.sentUpdateCount > 0) {
        return 'synced';
    }
    if (sendResult.deferredReason) {
        return 'deferred';
    }
    return sendResult.failedCount > 0 ? 'failed' : 'synced';
}
