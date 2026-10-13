import { recordRallarTiming, type RallarTimingSink } from '@shared-server/rallar-system/observability/timing.ts';
import { ALWorkPhaseCapture } from '@shared/alm/work/al-work-phase-capture.ts';
import type { WsQueueBoxServerReceiptObserver } from '@shared/services/ws-queue-box-server/ws-queue-box-server-receipt-observation.ts';

export interface CreateApiV1WsReceiptObserverInput {
    readonly enabled: boolean;
    readonly timing: RallarTimingSink;
    readonly serviceId: string;
    readonly publisherId: string;
    readonly workPhases?: {
        readonly serverPeerId: string;
        readonly clock: ALWorkPhaseCapture.Clock;
    };
}

export function createApiV1WsReceiptObserver(
    input: CreateApiV1WsReceiptObserverInput
): WsQueueBoxServerReceiptObserver | undefined {
    if (!input.enabled) {
        return undefined;
    }
    const observer: WsQueueBoxServerReceiptObserver = (wsReceipt) => {
        const event = {
            component: 'ws-receipt',
            operation: wsReceipt.kind,
            serviceId: input.serviceId,
            details: { publisherId: input.publisherId },
            wsReceipt
        };
        recordRallarTiming({ sink: input.timing, event, status: 'ok', durationMs: 0 });
    };
    if (input.workPhases === undefined) {
        return observer;
    }
    const phaseCapture = new ALWorkPhaseCapture({
        ...input.workPhases,
        maxRecords: 4096,
        maxBytes: 8 * 1024 * 1024,
        writeObservation: (observation, remainingBytes) =>
            writeApiV1WorkPhaseObservation(input, observation, remainingBytes)
    });
    return Object.assign(observer, { phaseCapture });
}

function writeApiV1WorkPhaseObservation(
    input: CreateApiV1WsReceiptObserverInput,
    observation: ALWorkPhaseCapture.Observation,
    remainingBytes: number
): ALWorkPhaseCapture.WriteResult {
    let result: ALWorkPhaseCapture.WriteResult = { status: 'failed' };
    const event = {
        component: 'ws-receipt',
        operation: observation.kind,
        serviceId: input.serviceId,
        details: { publisherId: input.publisherId },
        wsReceipt: observation
    };
    recordRallarTiming({
        event,
        status: 'ok',
        durationMs: 0,
        sink: (timingEvent) => {
            const bytes = new TextEncoder().encode(JSON.stringify(timingEvent) + '\n').length;
            if (bytes > remainingBytes || bytes > 65536) {
                result = { status: 'overflow' };
                return;
            }
            try {
                input.timing(timingEvent);
                result = { status: 'emitted', bytes };
            }
            catch { /* Optional phase evidence preserves mandatory work and the original failure. */ }
        }
    });
    return result;
}
