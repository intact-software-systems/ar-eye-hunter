import assert from 'node:assert/strict';

import type {
    RallarBlackBoxTestAlmUsage,
    RallarBlackBoxTestMessagesSendCommand
} from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { AL_MESSAGE_ENVELOPE_VERSION, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { createALInboundOrderingCounters } from '@shared/alm/inbound/admission/al-inbound-ordering-counters.ts';
import type { ALOutboundPublicationStageReport } from '@shared/alm/outbound/publication/al-outbound-publication-stage.ts';
import {
    ALVolatileSessionBudget,
    type ALVolatileSessionLimits
} from '@shared/alm/volatile-budget/al-volatile-session-budget.ts';
import { toALVolatileSessionAdmission } from '@shared/alm/volatile-budget/to-al-volatile-session-admission.ts';

/** A connected fixture page uses the product's volatile ledger for both admission and its stats reading. */
export class AlmReloadVolatileSession {
    private readonly idleLimits: ALVolatileSessionLimits;
    private budget: ALVolatileSessionBudget;

    constructor(idleLimits: ALVolatileSessionLimits) {
        this.idleLimits = idleLimits;
        this.budget = new ALVolatileSessionBudget(idleLimits);
    }

    connect(limits: ALVolatileSessionLimits): void {
        this.budget = new ALVolatileSessionBudget(limits);
    }

    close(): void {
        this.budget = new ALVolatileSessionBudget(this.idleLimits);
    }

    admit(command: RallarBlackBoxTestMessagesSendCommand, msgId: string, nowMs: number): boolean {
        const message: ALMessage = {
            id: { v: AL_MESSAGE_ENVELOPE_VERSION, msgId, ts: nowMs, senderId: 'sender', traceId: `trace-${msgId}` },
            route: {
                topicId: command.topicId ?? '',
                contextId: 'alm-reload-room',
                resourceId: command.resourceId ?? msgId
            },
            constraints: { expiresAtMs: nowMs + (command.ttlMs ?? 30_000) },
            delivery: { reliability: command.reliability ?? 'at-least-once', ack: command.ack ?? 'receiver' },
            ordering: command.orderingKey === undefined
                ? undefined
                : { orderingKey: command.orderingKey, seq: command.seq },
            payload: {
                typeId: command.typeId,
                contentType: 'application/json',
                resource: JSON.stringify(command.payload)
            }
        };
        const admission = toALVolatileSessionAdmission(message, nowMs);
        assert(admission);
        return this.budget.tryAdmit(admission).right !== undefined;
    }

    readUsage(nowMs: number, publication: ALOutboundPublicationStageReport): RallarBlackBoxTestAlmUsage {
        return {
            ...this.budget.readReport(nowMs),
            orderingTracks: 0,
            deliveredMarkers: 0,
            repliesHeld: 0,
            replyWaitsOpen: 0,
            publication,
            ordering: createALInboundOrderingCounters()
        };
    }
}
