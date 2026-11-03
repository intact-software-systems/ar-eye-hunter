import { decodeBlackBoxRallarConfigFields } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/decode-black-box-rallar-connection-config.ts';
import type {
    RallarBlackBoxTestAlmUsage,
    RallarBlackBoxTestMessagesSendCommand,
    RallarBlackBoxTestRtcConnectCommand
} from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { AL_MESSAGE_ENVELOPE_VERSION, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { ALOutboundPublicationStageReport } from '@shared/alm/outbound/publication/al-outbound-publication-stage.ts';
import {
    AL_VOLATILE_SESSION_LIMITS,
    ALVolatileSessionBudget
} from '@shared/alm/volatile-budget/al-volatile-session-budget.ts';
import { toALVolatileSessionAdmission } from '@shared/alm/volatile-budget/to-al-volatile-session-admission.ts';
import { assert } from '@std/assert';

/** A connected fixture page uses the product's volatile ledger for both admission and its stats reading. */
export class AlmReloadVolatileSession {
    private budget = new ALVolatileSessionBudget(AL_VOLATILE_SESSION_LIMITS);

    connect(command: RallarBlackBoxTestRtcConnectCommand): void {
        const limits = decodeBlackBoxRallarConfigFields(command.rallar ?? {}).almVolatileLimits;
        this.budget = new ALVolatileSessionBudget(limits ?? AL_VOLATILE_SESSION_LIMITS);
    }

    close(): void {
        this.budget = new ALVolatileSessionBudget(AL_VOLATILE_SESSION_LIMITS);
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
            publication
        };
    }
}
