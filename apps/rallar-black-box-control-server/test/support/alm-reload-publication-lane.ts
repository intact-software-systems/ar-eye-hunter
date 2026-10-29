import { assert } from '@std/assert';

import type { RallarBlackBoxTestMessagesSendCommand } from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { AL_MESSAGE_ENVELOPE_VERSION, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import {
    AL_MESSAGE_RESOURCE_LIMITS,
    computeALMessageEnvelopeBytes
} from '@shared/al-contracts/al-message-resource-limits.ts';
import {
    AL_PUBLICATION_STAGE_LIMITS,
    decodeALPublicationStageLimits,
    type ALPublicationStageLimits
} from '@shared/al-contracts/publication/al-publication-stage-limits.ts';
import { toALPublicationLaneKey } from '@shared/al-contracts/publication/to-al-publication-stream-key.ts';
import { resolveALChannelSendDefaults } from '@shared/al-contracts/resolve-al-channel-send-defaults.ts';
import type { ALDeliveryCarrier, ALDeliverySettlementSink } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import type { ALOutboundRuntimeDiagnosticsSink } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import { ALOutboundPublicationStage } from '@shared/alm/outbound/publication/al-outbound-publication-stage.ts';
import { Either } from '@shared/resilience/Either.ts';
import { toError } from '@shared/resilience/to-error.ts';
import { InboxOutboxEngine } from '@shared/services/inbox-outbox-engine.ts';

const PUBLICATION_STAGE_TASK_ID = 'al-outbound-publication-stage';

/** The room the fixture's live sends name; only its stream identity matters to the stage. */
const FIXTURE_ROOM = { applicationId: 'rallar-server', workspaceId: 'default', groupId: 'alm-reload-room' } as const;

export interface AlmReloadFixtureClock {
    readonly nowMs: () => number;
    readonly setNowMs: (nowMs: number) => void;
}

export interface AlmReloadPublicationLaneInput {
    /** The fixture's clock: the stage stamps and schedules by it, each engine pass reads it, and `advanceTo` moves it. */
    readonly clock: AlmReloadFixtureClock;
    /** The fixture carrier: it settles each value an opportunity selected, the way the fixture settles a send. */
    readonly submit: (msgIds: readonly string[]) => void;
    readonly settle: ALDeliverySettlementSink;
    readonly diagnostics: ALOutboundRuntimeDiagnosticsSink;
}

/** A live send's command with the options its channel decides itself (D466, D467). */
export type AlmReloadLiveCommand = RallarBlackBoxTestMessagesSendCommand & Readonly<{ ttlMs: number; }>;

/** One live send under the identity the fixture gave it. */
export interface AlmReloadLiveSend {
    readonly command: AlmReloadLiveCommand;
    readonly msgId: string;
    readonly traceId: string;
    readonly carrier: ALDeliveryCarrier;
    /** The sender's fixed audience; undefined for a send to the whole room. */
    readonly recipientPeerIds: readonly string[] | undefined;
}

/** A live send asks no receipt and keeps its channel's lifetime unless it names one. */
export function toAlmReloadLiveCommand(command: RallarBlackBoxTestMessagesSendCommand): AlmReloadLiveCommand {
    const defaults = resolveALChannelSendDefaults({ purpose: 'live', durability: undefined, hasLogicalAudience: true });
    return { ...command, ack: defaults.ack, ttlMs: command.ttlMs ?? defaults.ttlMs };
}

/** A connect's `rallar.almPublicationLimits` as the harness decodes it; absent, the product's own. */
export function decodeAlmReloadPublicationLimits(value: unknown): Either<string, ALPublicationStageLimits> {
    if (value === undefined) {
        return Either.ofRight(AL_PUBLICATION_STAGE_LIMITS);
    }
    return decodeALPublicationStageLimits(value, '$.rallar.almPublicationLimits').mapLeft((issues) =>
        issues.map((issue) => `${issue.path}: ${issue.message}`).join(' ')
    );
}

interface AlmReloadConnectStage {
    readonly engine: InboxOutboxEngine;
    readonly stage: ALOutboundPublicationStage<string>;
    /** Every lane the stage opened, so the fixture can read when the next one is due. */
    readonly laneKeys: Set<string>;
}

/**
 * The sender page's publication stage: the shared `ALOutboundPublicationStage` on a queue engine that never starts, so
 * the fixture's clock alone decides when an opportunity runs. One connect holds one stage under the connect's limits,
 * as `BrowserPublicationStages` composes it; a new connect or a close stops it.
 */
export class AlmReloadPublicationLane {
    private readonly input: AlmReloadPublicationLaneInput;
    private limits: ALPublicationStageLimits = AL_PUBLICATION_STAGE_LIMITS;
    private current: AlmReloadConnectStage | undefined;
    private readonly failures: Error[] = [];

    constructor(input: AlmReloadPublicationLaneInput) {
        this.input = input;
    }

    /** A new connect starts its stage under its own limits; the stage before it stops, as its epoch closes. */
    connect(limits: ALPublicationStageLimits): void {
        this.close();
        this.limits = limits;
    }

    /** Settles every staged value `skipped`/`disposed`, as the connect's epoch closing does. */
    close(): void {
        const stopped = this.current;
        this.current = undefined;
        stopped?.stage.dispose();
    }

    /** The stage refuses a value it cannot hold, and the refusal is the value's admission verdict. */
    stage(send: AlmReloadLiveSend): void {
        const current = this.current ?? this.startStage();
        const msg = toLiveMessage(send, this.input.clock.nowMs());
        current.laneKeys.add(toALPublicationLaneKey(msg));
        const policy = send.command.publication;
        assert(policy, 'a live send names its publication');
        const result = current.stage.stage({
            msg,
            carrier: send.carrier,
            policy,
            bytes: computeALMessageEnvelopeBytes(msg).right ?? AL_MESSAGE_RESOURCE_LIMITS.envelopeBytes,
            context: send.msgId
        });
        if (result.kind === 'refused') {
            this.input.settle({
                kind: 'admission',
                msgId: send.msgId,
                traceId: send.traceId,
                carrier: send.carrier,
                atMs: this.input.clock.nowMs(),
                verdict: result,
                trackedReceiptAlgo: 'none'
            });
        }
    }

    /** False when the stage holds no such value: one an opportunity selected is its carrier's to cancel. */
    cancel(msgId: string): boolean {
        return this.current?.stage.cancel(msgId) ?? false;
    }

    /**
     * Moves the fixture's clock to `targetMs`, running each lane opportunity at its own due time on the way, and stops
     * early once `reached` holds.
     */
    async advanceTo(targetMs: number, reached: () => boolean): Promise<void> {
        const { clock } = this.input;
        await this.runDueOpportunities();
        while (!reached()) {
            const nextMs = this.readNextOpportunityAtMs();
            if (nextMs === undefined || nextMs > targetMs) {
                clock.setNowMs(Math.max(clock.nowMs(), targetMs));
                return;
            }
            assert(nextMs > clock.nowMs(), `the lane did not run its opportunity due at ${nextMs}`);
            clock.setNowMs(nextMs);
            await this.runDueOpportunities();
        }
    }

    private readNextOpportunityAtMs(): number | undefined {
        const current = this.current;
        if (current === undefined) {
            return undefined;
        }
        const next = [...current.laneKeys].flatMap((laneKey) =>
            current.stage.readLane(laneKey)?.nextOpportunityAtMs ?? []
        );
        return next.length === 0 ? undefined : Math.min(...next);
    }

    /** One engine pass at the fixture's now; `stop` joins the opportunities it started, so their settlements landed. */
    async runDueOpportunities(): Promise<void> {
        const current = this.current;
        if (current === undefined) {
            return;
        }
        await current.engine.executeOnce();
        const stopFailure = await current.engine.stop().then(() => undefined, toError);
        // A runnable's failure reaches both `reportTaskFailure` and `stop`: drained here, it is thrown once.
        const [reported] = this.failures.splice(0);
        const failure = stopFailure ?? reported;
        if (failure !== undefined) {
            throw failure;
        }
    }

    private startStage(): AlmReloadConnectStage {
        const engine = new InboxOutboxEngine({
            nowEpochMs: this.input.clock.nowMs,
            random: () => 0,
            reportTaskFailure: (_taskId, error) => {
                this.failures.push(error);
                return undefined;
            }
        });
        const stage = new ALOutboundPublicationStage<string>({
            taskId: PUBLICATION_STAGE_TASK_ID,
            queueEngine: engine,
            clock: { nowMs: this.input.clock.nowMs },
            submit: (selected) => Promise.resolve(this.input.submit(selected.map(({ context }) => context))),
            settle: this.input.settle,
            diagnostics: this.input.diagnostics,
            limits: this.limits
        });
        this.current = { engine, stage, laneKeys: new Set() };
        return this.current;
    }
}

/** The envelope the live channel builds: best-effort, no receipt, and a deadline its lifetime past staging. */
function toLiveMessage(send: AlmReloadLiveSend, nowMs: number): ALMessage {
    const { command } = send;
    return {
        id: { v: AL_MESSAGE_ENVELOPE_VERSION, msgId: send.msgId, ts: nowMs, senderId: 'sender', traceId: send.traceId },
        route: {
            topicId: command.topicId ?? '',
            contextId: FIXTURE_ROOM.groupId,
            resourceId: command.resourceId ?? send.msgId
        },
        targets: send.recipientPeerIds === undefined
            ? { mode: 'multicast', groupRef: FIXTURE_ROOM }
            : { mode: 'multicast', groupRef: FIXTURE_ROOM, recipientPeerIds: send.recipientPeerIds },
        constraints: { expiresAtMs: nowMs + command.ttlMs },
        delivery: { reliability: 'best-effort', ack: 'none' },
        payload: { typeId: command.typeId, contentType: 'application/json', resource: JSON.stringify(command.payload) }
    };
}
