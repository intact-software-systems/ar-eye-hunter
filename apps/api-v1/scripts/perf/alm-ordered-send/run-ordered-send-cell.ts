import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { Either } from '@shared/resilience/Either.ts';
import { toError } from '@shared/resilience/to-error.ts';
import type { ConnectionContext } from '@shared/websocket/json-web-socket-server.ts';

import {
    computeOrderedSendSchedule,
    type OrderedSendSchedule,
    type OrderedSendScheduledSend,
    type OrderedSendScheduledSession
} from './compute-ordered-send-schedule.ts';
import { createDefaultOrderedSendInstance, type OrderedSendInstance } from './create-ordered-send-instance.ts';
import { createOrderedSendRoomAuthorizer } from './create-ordered-send-room-authorizer.ts';
import { offerOrderedSendsWhenDue } from './offer-ordered-sends-when-due.ts';
import { ORDERED_SEND_CELL_CONSTANTS } from './ordered-send-cell-constants.ts';
import type { OrderedSendCellObservations } from './ordered-send-cell-observations.ts';
import { createDefaultOrderedSendClock, type OrderedSendClock } from './ordered-send-clock.ts';
import { OrderedSendObservationLog } from './ordered-send-observation-log.ts';
import { OrderedSendOfferLedger } from './ordered-send-offer-ledger.ts';
import { toOrderedSendAck } from './to-ordered-send-ack.ts';
import { toOrderedSendCellAnswer } from './to-ordered-send-cell-answer.ts';
import { toOrderedSendMessage } from './to-ordered-send-message.ts';
import {
    validateOrderedSendShape,
    type OrderedSendShape,
    type OrderedSendShapeIssue
} from './validate-ordered-send-shape.ts';

export interface RunOrderedSendCellInput {
    readonly shape: OrderedSendShape;
    /**
     * A credential: it goes to each instance's database lifecycle and nowhere else. It names a migrated database, or
     * through its `schema` parameter a schema of one, that nothing else works while the run lasts: an instance's
     * outbox worker takes every WS outbox row it can see, whatever store namespace wrote it.
     */
    readonly databaseUrl: string;
    /**
     * A UUID of the caller's making that no other run on the database carries. The ids of the sessions and the sends
     * repeat from run to run, so it names the run's store namespace, its room and its NOTIFY channels: a run never
     * reads the rows an earlier run left in the same tables, and never hears another run's notices.
     */
    readonly runId: string;
    /**
     * How long the run observes after its last offer, in milliseconds. It observes for exactly this long whatever it
     * has read by then, and never stops at the last terminal receipt: two runs with one tail count what they read
     * again, and what they read late, over the same time.
     */
    readonly observationTailMs: number;
}

export interface OrderedSendCellRunDependencies {
    readonly clock: OrderedSendClock;
}

/** One run in progress: `ledger` and `log` take what it offers and observes, and `acksInFlight` grows with each ACK. */
interface OrderedSendRun {
    readonly schedule: OrderedSendSchedule;
    readonly roomRef: GroupRef;
    readonly instances: readonly OrderedSendInstance[];
    readonly ledger: OrderedSendOfferLedger;
    readonly log: OrderedSendObservationLog;
    readonly clock: OrderedSendClock;
    readonly acksInFlight: Promise<void>[];
}

interface DueOrderedSend {
    readonly send: OrderedSendScheduledSend;
    /** The instance the publisher's socket is on. */
    readonly publisherInstance: OrderedSendInstance;
    readonly dueAtMs: number;
}

const RUN_ID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

/** The application and workspace of every run's room, and of every session's proven scope. */
const ORDERED_SEND_SCOPE = { applicationId: 'ordered-send-cell', workspaceId: 'default' };

/** How often the run looks, while it observes its tail, whether an offer threw. */
const TAIL_POLL_MS = 25;

/** A room presence outlasts any run by far. */
const ROOM_PRESENCE_LIFETIME_MS = 24 * 60 * 60 * 1_000;

/**
 * One run of the cell: three API instances in this process on one PostgreSQL database, fifteen sessions in one room,
 * and the shape's publishers each offering an ordered, receipted room send at its due instant. Returns everything
 * the run observed, or every issue of the shape and nothing run.
 *
 * What each thing takes on its way, as the API's own router decides it for a topic it has no definition of:
 * - a copy: the publisher's instance admits the send to the shared inbound store; whichever instance's worker takes
 *   its work row hands it to the router, which publishes one NOTIFY that carries the message, sends the copies of
 *   the sessions on that instance once the publish returned, and the other instances send theirs as the NOTIFY
 *   reaches them. No copy is a row of the WS outbox: one an instance missed is written again only when the send is
 *   handed to a router again. A publisher that sends it again changes nothing: the entry answers `duplicate`, hands
 *   nothing off and publishes nothing;
 * - a receipt: a row the instance that admitted the send writes to the shared WS outbox. The instance whose worker
 *   takes the row writes it to the origin's socket when that socket is its own, and otherwise announces the row's
 *   key to the others by a NOTIFY, again and again until the row expires;
 * - an ACK: counted on the instance its session is on when that instance admitted the send, else relayed to the
 *   others by a NOTIFY.
 *
 * The database latency of the shape is added to: every statement of the three instances; BEGIN and COMMIT or
 * ROLLBACK of every transaction; every NOTIFY publish. It is not added to: the delivery of a NOTIFY to its
 * listeners; LISTEN and UNLISTEN; the opening of a connection and the `select 1` each pool is probed with; a second
 * protocol round trip inside one statement (describe before execute, a first use of a prepared statement); the
 * `set local` pair around a custom-planned statement; the warm-up of the pools.
 *
 * What differs from a deployment: one event loop runs the three instances and the load; a session is a socket
 * object the server writes to, with no WebSocket and no client runtime, so a publisher sends nothing again, answers
 * no NACK and no repair request, and reads a receipt each time it is written; the room authorizer admits a fixed
 * audience and reads nothing, where the API's reads the room's current snapshot for each of the three decisions a
 * send takes; no group and no client is in the database, so the target resolver has no snapshot to read and no
 * connect, presence or heartbeat is written; none of the API's other workers run.
 *
 * An offer that throws, of a send or of an ACK, fails the run once it has stopped; what the entry answers is never a
 * failure.
 */
export async function runOrderedSendCell(
    input: RunOrderedSendCellInput,
    dependencies: OrderedSendCellRunDependencies
): Promise<Either<readonly OrderedSendShapeIssue[], OrderedSendCellObservations>> {
    const issues = validateOrderedSendShape(input.shape);
    if (issues.length > 0) {
        return Either.ofLeft(issues);
    }
    if (!RUN_ID.test(input.runId)) {
        throw new TypeError('runId must be a lower-case UUID.');
    }
    if (!Number.isFinite(input.observationTailMs) || input.observationTailMs < 0) {
        throw new TypeError('observationTailMs must be a finite number of at least 0.');
    }
    const { clock } = dependencies;
    const schedule = computeOrderedSendSchedule(input.shape);
    const roomRef = { ...ORDERED_SEND_SCOPE, groupId: `room-${input.runId}` };
    const log = new OrderedSendObservationLog(clock.nowMs);
    const instances = await createOrderedSendInstances(input, { schedule, roomRef, log, clock });
    try {
        return Either.ofRight(
            await observeOrderedSends({
                schedule,
                roomRef,
                instances,
                ledger: new OrderedSendOfferLedger(),
                log,
                clock,
                acksInFlight: []
            }, input.observationTailMs)
        );
    }
    finally {
        await stopOrderedSendInstances(instances);
    }
}

export function createDefaultOrderedSendCellRunDependencies(): OrderedSendCellRunDependencies {
    return { clock: createDefaultOrderedSendClock() };
}

/** The three instances, each on pools of its own. One that cannot be created closes those created before it. */
async function createOrderedSendInstances(
    input: RunOrderedSendCellInput,
    run: Pick<OrderedSendRun, 'schedule' | 'roomRef' | 'log' | 'clock'>
): Promise<readonly OrderedSendInstance[]> {
    const connectedAtEpochMs = run.clock.nowEpochMs();
    const authorizeRoomMessage = createOrderedSendRoomAuthorizer({
        roomRef: run.roomRef,
        sessionPeerIds: run.schedule.sessions.map((session) => session.peerId),
        connectedAtEpochMs,
        expiresAtEpochMs: connectedAtEpochMs + ROOM_PRESENCE_LIFETIME_MS
    });
    const instances: OrderedSendInstance[] = [];
    try {
        for (let instanceIndex = 0; instanceIndex < ORDERED_SEND_CELL_CONSTANTS.instanceCount; instanceIndex += 1) {
            instances.push(
                await createDefaultOrderedSendInstance(
                    {
                        instanceIndex,
                        delayMs: input.shape.delayMs,
                        runId: input.runId,
                        scope: ORDERED_SEND_SCOPE,
                        authorizeRoomMessage,
                        recordHandOff: (message, handingInstanceIndex) =>
                            run.log.recordHandOff(message.id.msgId, handingInstanceIndex)
                    },
                    input.databaseUrl,
                    run.clock
                )
            );
        }
        return instances;
    }
    catch (error) {
        await stopOrderedSendInstances(instances);
        throw error;
    }
}

/** The phases of a run, in order: start, warm, connect, the send window, the tail, and the end of observation. */
async function observeOrderedSends(
    run: OrderedSendRun,
    observationTailMs: number
): Promise<OrderedSendCellObservations> {
    await openOrderedSendRoom(run);
    const sessionByPeerId = new Map(run.schedule.sessions.map((session) => [session.peerId, session]));

    const windowStartedAtMs = run.clock.nowMs();
    await offerOrderedSendsWhenDue({
        sends: run.schedule.sends.map((send): DueOrderedSend => ({
            send,
            publisherInstance: run.instances[sessionByPeerId.get(send.publisherPeerId)?.instanceIndex ?? 0],
            dueAtMs: windowStartedAtMs + send.dueOffsetMs
        })),
        nowMs: run.clock.nowMs,
        sleep: run.clock.sleep,
        offer: (due) => offerOrderedSend(due, run)
    });
    await observeOrderedSendTail(run, (run.ledger.getLastOfferAtMs() ?? windowStartedAtMs) + observationTailMs);

    const reads = run.log.endObservation();
    const sends = run.ledger.close();
    await Promise.all(run.acksInFlight);
    if (run.ledger.getFailures().length > 0) {
        throw new AggregateError(run.ledger.getFailures(), 'An offer of the ordered-send cell threw.');
    }
    return { sends, ...reads };
}

/** Every instance subscribed and working, every application pool fully open, every session connected. */
async function openOrderedSendRoom(run: OrderedSendRun): Promise<void> {
    for (const instance of run.instances) {
        await instance.start();
    }
    await Promise.all(run.instances.map((instance) => instance.warmApplicationPool()));
    for (const session of run.schedule.sessions) {
        run.instances[session.instanceIndex].connectSession(session.peerId, toSessionSocket(session, run));
    }
}

/**
 * What the server writes a session's frames to. A frame is read the moment the server writes it, and the session
 * then owes at most one ACK, which it offers its own instance after its ACK offset.
 */
function toSessionSocket(session: OrderedSendScheduledSession, run: OrderedSendRun): ConnectionContext.Socket {
    return {
        readyState: WebSocket.OPEN,
        send: (frame) => {
            const copy = run.log.recordSocketFrame(session.peerId, frame);
            if (copy !== undefined) {
                run.acksInFlight.push(offerOrderedSendAck(copy, session, run));
            }
            return frame.length;
        },
        close: () => undefined
    };
}

/** The offer of one send on its publisher's instance. Its answer is recorded when it comes and waited for by nobody. */
function offerOrderedSend(due: DueOrderedSend, run: OrderedSendRun): void {
    const { send } = due;
    const frame = toWireValue(toOrderedSendMessage({
        send,
        roomRef: run.roomRef,
        createdAtEpochMs: run.clock.nowEpochMs()
    }));
    const sentAtMs = run.clock.nowMs();
    const answered = due.publisherInstance.acceptIncomingMessage(frame, send.publisherPeerId);
    run.ledger.recordOffer({
        msgId: send.msgId,
        publisherPeerId: send.publisherPeerId,
        seq: send.seq,
        dueAtMs: due.dueAtMs,
        sentAtMs,
        expectedRecipientPeerIds: send.expectedRecipientPeerIds
    });
    answered.then(
        (answer) => run.ledger.recordAnswer(send.msgId, toOrderedSendCellAnswer(answer, run.clock.nowMs())),
        (error) => run.ledger.recordFailure(toError(error))
    );
}

/** One ACK of one copy, offered on the reader's own instance once its ACK offset passed, while observation lasts. */
async function offerOrderedSendAck(
    copy: ALMessage,
    session: OrderedSendScheduledSession,
    run: OrderedSendRun
): Promise<void> {
    await run.clock.sleep(session.ackOffsetMs);
    if (!run.log.isObserving()) {
        return;
    }
    const ack = toOrderedSendAck({
        copy,
        recipientPeerId: session.peerId,
        observedAtEpochMs: run.clock.nowEpochMs()
    });
    try {
        await run.instances[session.instanceIndex].acceptIncomingMessage(toWireValue(ack), session.peerId);
    }
    catch (error) {
        run.ledger.recordFailure(toError(error));
    }
}

/**
 * Waits until `endAtMs`, whatever the sessions have read by then: a send whose receipt is complete may still read
 * that receipt again, and the server may write a `timed-out` receipt long after its send's deadline. Nothing says
 * that no receipt comes after `endAtMs` either; a send without a terminal receipt by then is counted as such. Only an
 * offer that threw ends the wait early, since its run fails.
 */
async function observeOrderedSendTail(run: OrderedSendRun, endAtMs: number): Promise<void> {
    let remainingMs = endAtMs - run.clock.nowMs();
    while (run.ledger.getFailures().length === 0 && remainingMs > 0) {
        await run.clock.sleep(Math.min(remainingMs, TAIL_POLL_MS));
        remainingMs = endAtMs - run.clock.nowMs();
    }
}

/** Stops every instance's work before any pool closes, and fails with every failure there was. */
async function stopOrderedSendInstances(instances: readonly OrderedSendInstance[]): Promise<void> {
    const stopped = await Promise.allSettled(instances.map((instance) => instance.stop()));
    const closed = await Promise.allSettled(instances.map((instance) => instance.close()));
    const failures = [...stopped, ...closed]
        .flatMap((outcome) => outcome.status === 'rejected' ? [toError(outcome.reason)] : []);
    if (failures.length > 0) {
        throw new AggregateError(failures, 'The ordered-send cell failed to stop its instances.');
    }
}

/** A message as the server's socket bridge hands it to the entry: the JSON of a frame, parsed. */
function toWireValue(message: ALMessage): object {
    return JSON.parse(JSON.stringify(message));
}
