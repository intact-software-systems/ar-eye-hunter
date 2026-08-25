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
            return this.finish({
                status: 'local-only',
                transport,
                sentUpdateCount: 0,
                receivedUpdateCount: 0,
                pendingUpdateCount: this.options.pending.size,
                dependencyBlockedUpdateCount: this.options.dependencyBlocked.size,
                reason: options.reason ?? 'Document is opened in local-only mode.'
            });
        }
        if (!this.options.readTransport?.()) {
            const receivedHttpCatchUp = await this.options.durable.requestOverHttp(
                options.reason ?? 'manual-sync'
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

        let sentUpdateCount = 0;
        let failedCount = 0;
        let deferredReason: string | undefined;
        for (const update of this.pendingUpdates()) {
            this.options.diagnostics.rememberRetry();
            const outcome = await sendRallarCrdtLiveUpdate({
                update,
                transport: this.options.readTransport(),
                strategy: transport,
                policies: this.options.policies
            });
            sentUpdateCount += outcome.sentCount;
            failedCount += outcome.failedCount;
            deferredReason ??= outcome.reason;
            this.options.diagnostics.rememberSendOutcome(outcome);
        }
        if (
            !(await this.options.durable.requestOverWs(
                options.reason ?? 'manual-sync',
                transport
            ))
        ) {
            await this.options.durable.requestOverHttp(
                options.reason ?? 'manual-sync'
            );
        }
        await this.options.requestLiveCatchUp(
            options.reason ?? 'manual-sync',
            transport
        );

        const status = sentUpdateCount > 0
            ? 'synced'
            : deferredReason
            ? 'deferred'
            : failedCount > 0
            ? 'failed'
            : 'synced';
        return this.finish({
            status,
            transport,
            sentUpdateCount,
            receivedUpdateCount: 0,
            pendingUpdateCount: this.options.pending.size,
            dependencyBlockedUpdateCount: this.options.dependencyBlocked.size,
            reason: deferredReason,
            error: status === 'failed'
                ? (deferredReason ?? 'CRDT live sync failed.')
                : undefined
        });
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
