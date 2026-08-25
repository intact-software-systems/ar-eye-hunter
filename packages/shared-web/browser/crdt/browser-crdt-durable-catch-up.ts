import type { BrowserCrdtDocumentPersistence } from '@shared-web/browser/crdt/browser-crdt-document-persistence.ts';
import type { BrowserCrdtLiveDiagnostics } from '@shared-web/browser/crdt/browser-crdt-live-diagnostics.ts';
import {
    createBrowserCrdtRuntimeId,
    normalizeBrowserCrdtSnapshot,
    normalizeBrowserCrdtUpdate
} from '@shared-web/browser/crdt/browser-crdt-runtime-values.ts';
import {
    sendRallarCrdtCatchUpRequest,
    type RallarCrdtMessageTransport,
    type RallarCrdtTransportKind
} from '@shared-web/browser/crdt/browser-crdt-transport.ts';
import type { RallarCrdtHttpCatchUpClient } from '@shared-web/browser/crdt/rallar-crdt-contracts.ts';
import {
    RALLAR_CRDT_PROTOCOL_VERSION,
    toRallarCrdtDocumentKey,
    type RallarCrdtAppendResponseEnvelope,
    type RallarCrdtCatchUpRequestEnvelope,
    type RallarCrdtCatchUpResponseEnvelope,
    type RallarCrdtDocument,
    type RallarCrdtDocumentRef,
    type RallarCrdtDocumentTypePolicy,
    type RallarCrdtFailedPendingUpdate,
    type RallarCrdtOperationBatch,
    type RallarCrdtTransportStrategy,
    type RallarCrdtUpdateEnvelope
} from '@shared/crdt/mod.ts';

export namespace BrowserCrdtDurableCatchUp {
    export type Options<TValue, TPayload extends RallarCrdtOperationBatch> = Readonly<{
        ref: RallarCrdtDocumentRef;
        documentKey: string;
        engine: RallarCrdtDocument<TValue, TPayload>;
        persistence: BrowserCrdtDocumentPersistence<TValue, TPayload>;
        diagnostics: BrowserCrdtLiveDiagnostics;
        durableCatchUp?: RallarCrdtHttpCatchUpClient<TPayload>;
        transport: RallarCrdtTransportStrategy;
        policies: readonly RallarCrdtDocumentTypePolicy[];
        readTransport?: () => RallarCrdtMessageTransport | undefined;
        now: () => number;
        applyRemoteUpdate(
            update: RallarCrdtUpdateEnvelope<TPayload>,
            transport: RallarCrdtTransportKind | undefined
        ): Promise<void>;
    }>;
}

/** Owns durable WS/HTTP catch-up and append acknowledgements. */
export class BrowserCrdtDurableCatchUp<TValue, TPayload extends RallarCrdtOperationBatch> {
    private readonly options: BrowserCrdtDurableCatchUp.Options<TValue, TPayload>;

    public constructor(
        options: BrowserCrdtDurableCatchUp.Options<TValue, TPayload>
    ) {
        this.options = options;
    }

    public async requestOverWs(
        reason: string,
        strategy: RallarCrdtTransportStrategy = this.options.transport
    ): Promise<boolean> {
        if (!strategyUsesWs(strategy)) {
            return false;
        }
        const request = this.createRequest('catch-up-request');
        const outcome = await sendRallarCrdtCatchUpRequest({
            request,
            transport: this.options.readTransport?.(),
            policies: this.options.policies
        });
        this.options.diagnostics.rememberSendOutcome(outcome);
        if (outcome.status === 'failed') {
            this.options.diagnostics.setSyncError(
                outcome.reason ??
                    `CRDT durable catch-up request failed: ${reason}.`
            );
        }
        return outcome.status === 'sent';
    }

    public async requestOverHttp(reason: string): Promise<boolean> {
        if (
            !this.options.durableCatchUp ||
            this.options.transport === 'local-only'
        ) {
            return false;
        }

        try {
            await this.handleResponse(
                await this.options.durableCatchUp(
                    this.createRequest('http-catch-up-request')
                ),
                undefined
            );
            this.options.diagnostics.setSyncError(undefined);
            return true;
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.options.diagnostics.setSyncError(
                `CRDT HTTP catch-up failed: ${reason}: ${message}`
            );
            return false;
        }
    }

    public async handleResponse(
        response: RallarCrdtCatchUpResponseEnvelope,
        transport: RallarCrdtTransportKind | undefined
    ): Promise<void> {
        if (toRallarCrdtDocumentKey(response.document) !== this.options.documentKey) {
            return;
        }

        if (response.snapshot) {
            this.options.engine.importSnapshot(
                await this.options.persistence.revealSnapshot(
                    normalizeBrowserCrdtSnapshot(response.snapshot)
                )
            );
            this.options.persistence.rememberSnapshot(
                response.snapshot.createdAtEpochMs
            );
        }
        for (const record of response.page.records) {
            await this.options.applyRemoteUpdate(
                normalizeBrowserCrdtUpdate<TPayload>(record.update),
                transport
            );
            this.options.diagnostics.rememberServerAppendSequence(
                record.append.appendSequence
            );
        }
        if (response.page.lastSequence !== undefined) {
            this.options.diagnostics.rememberServerAppendSequence(
                response.page.lastSequence
            );
        }
    }

    public async handleAppendResponse(
        response: RallarCrdtAppendResponseEnvelope<TPayload>
    ): Promise<void> {
        if (toRallarCrdtDocumentKey(response.document) !== this.options.documentKey) {
            return;
        }

        this.options.diagnostics.rememberServerAcknowledgement(
            response.acceptedAtEpochMs
        );
        for (const result of response.results) {
            if (result.status === 'accepted' || result.status === 'duplicate') {
                this.options.diagnostics.rememberServerAppendSequence(
                    result.append.appendSequence
                );
                await this.options.persistence.removePendingUpdate(
                    result.update.updateId
                );
                continue;
            }
            if (!result.update) {
                continue;
            }

            await this.options.persistence.removePendingUpdate(
                result.update.updateId
            );
            const failed: RallarCrdtFailedPendingUpdate<TPayload> = {
                update: result.update,
                failedAtEpochMs: this.options.now(),
                retryable: result.retryable,
                reason: result.reason
            };
            await this.options.persistence.rememberFailedUpdate(failed);
        }
    }

    private createRequest(prefix: string): RallarCrdtCatchUpRequestEnvelope {
        const afterSequence = this.options.diagnostics.health()
            .lastServerAppendSequence;
        return {
            protocolVersion: RALLAR_CRDT_PROTOCOL_VERSION,
            document: this.options.ref,
            requestId: createBrowserCrdtRuntimeId(prefix),
            replicaId: this.options.engine.replicaId,
            createdAtEpochMs: this.options.now(),
            afterSequence,
            maxUpdateCount: 100,
            includeSnapshot: afterSequence === undefined
        };
    }
}

function strategyUsesWs(strategy: RallarCrdtTransportStrategy): boolean {
    return (
        strategy === 'ws' ||
        strategy === 'ws-then-rtc' ||
        strategy === 'rtc-with-ws-fallback'
    );
}
