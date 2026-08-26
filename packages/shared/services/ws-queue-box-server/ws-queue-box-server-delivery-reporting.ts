import type {
    WsDeliveryDiagnosticsEvent,
    WsDeliveryDiagnosticsSink,
    WsOutboxDeliveryOutcome
} from './ws-queue-box-server-contracts.ts';

export namespace WsQueueBoxServerDeliveryReporting {
    export interface Dependencies {
        readonly outboundOutcome?: (outcome: WsOutboxDeliveryOutcome) => void;
        readonly diagnostics?: WsDeliveryDiagnosticsSink;
    }
}

export class WsQueueBoxServerDeliveryReporting {
    readonly #outboundOutcome?: (outcome: WsOutboxDeliveryOutcome) => void;
    readonly #diagnostics?: WsDeliveryDiagnosticsSink;

    constructor(dependencies: WsQueueBoxServerDeliveryReporting.Dependencies) {
        this.#outboundOutcome = dependencies.outboundOutcome;
        this.#diagnostics = dependencies.diagnostics;
    }

    recordOutcome(outcome: WsOutboxDeliveryOutcome): void {
        try {
            this.#outboundOutcome?.(outcome);
        }
        catch (error) {
            const runtimeError = error instanceof Error ? error : new Error(String(error));
            console.error('WS outbox delivery outcome sink failed', runtimeError);
        }
    }

    recordDiagnostics(event: WsDeliveryDiagnosticsEvent): void {
        try {
            this.#diagnostics?.(event);
        }
        catch {
            // Observational diagnostics must never change delivery behavior.
        }
    }
}
