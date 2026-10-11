import { recordRallarTiming, type RallarTimingSink } from '@shared-server/rallar-system/observability/timing.ts';
import type { WsQueueBoxServerReceiptObserver } from '@shared/services/ws-queue-box-server/ws-queue-box-server-receipt-observation.ts';

export interface CreateApiV1WsReceiptObserverInput {
    readonly enabled: boolean;
    readonly timing: RallarTimingSink;
    readonly serviceId: string;
    readonly publisherId: string;
}

export function createApiV1WsReceiptObserver(
    input: CreateApiV1WsReceiptObserverInput
): WsQueueBoxServerReceiptObserver | undefined {
    if (!input.enabled) {
        return undefined;
    }
    return (wsReceipt) => {
        const event = {
            component: 'ws-receipt',
            operation: wsReceipt.kind,
            serviceId: input.serviceId,
            details: { publisherId: input.publisherId },
            wsReceipt
        };
        recordRallarTiming({ sink: input.timing, event, status: 'ok', durationMs: 0 });
    };
}
