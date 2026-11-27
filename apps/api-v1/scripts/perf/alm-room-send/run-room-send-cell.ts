import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { Either } from '@shared/resilience/Either.ts';
import { toError } from '@shared/resilience/to-error.ts';
import type { ConnectionContext } from '@shared/websocket/json-web-socket-server.ts';

import { readRoomSendCellAnswer } from './answer/read-room-send-cell-answer.ts';
import { RoomSendClientStandIn } from './client-stand-in/room-send-client-stand-in.ts';
import {
    computeRoomSendProcessFigures,
    type RoomSendCpuUsage,
    type RoomSendProcessFigures
} from './compute-room-send-process-figures.ts';
import {
    computeRoomSendSchedule,
    type RoomSendSchedule,
    type RoomSendScheduledSend,
    type RoomSendScheduledSession
} from './compute-room-send-schedule.ts';
import { createDefaultRoomSendInstance, type RoomSendInstance } from './instance/create-room-send-instance.ts';
import { createRoomSendRoomAuthorizer } from './instance/create-room-send-room-authorizer.ts';
import { ROOM_SEND_SERVER_PEER_ID } from './instance/create-room-send-ws-server.ts';
import { offerRoomSendsWhenDue } from './offer-room-sends-when-due.ts';
import { ROOM_SEND_CELL_CONSTANTS } from './room-send-cell-constants.ts';
import type { RoomSendCellObservations } from './room-send-cell-observations.ts';
import { createDefaultRoomSendClock, type RoomSendClock } from './room-send-clock.ts';
import { RoomSendObservationLog } from './room-send-observation-log.ts';
import { RoomSendOfferLedger } from './room-send-offer-ledger.ts';
import { startRoomSendLoopLagSampling } from './start-room-send-loop-lag-sampling.ts';
import { toRoomSendAck } from './to-room-send-ack.ts';
import { toRoomSendMessage } from './to-room-send-message.ts';
import {
    validateRoomSendShape,
    type RoomSendShape,
    type RoomSendShapeIssue
} from './validate-room-send-shape.ts';

export interface RunRoomSendCellInput {
    readonly shape: RoomSendShape;
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
     * How long the run observes after its last offer, in milliseconds. It observes for this long whatever it has read
     * by then, and for at most one tick of its loop-lag timer more, and never stops at the last terminal receipt: two
     * runs with one tail count what they read again, and what they read late, over the same time.
     */
    readonly observationTailMs: number;
}

export interface RoomSendCellRunDependencies {
    readonly clock: RoomSendClock;
    /** Reads the processor time the process has used so far, as `process.cpuUsage()` does. */
    readonly readCpuUsage: () => RoomSendCpuUsage;
}

/** What a run read of the process it ran in. It is for the artifact, and no part of what the report computes. */
export interface RoomSendCellRuntime {
    /** From the window's opening to its last offer. */
    readonly sendWindow: RoomSendProcessFigures;
    /** From the last offer to the end of observation: the work the offers started goes on through it. */
    readonly tail: RoomSendProcessFigures;
    /** The most connections each instance's application pool opened: the shape's. */
    readonly applicationPoolMaxConnections: number;
}

export interface RoomSendCellRunResult {
    /** What the sessions' sockets read, what the instances handed off and what the entry answered. */
    readonly observations: RoomSendCellObservations;
    readonly runtime: RoomSendCellRuntime;
}

/** One run in progress: `ledger` and `log` take what it offers and observes. */
interface RoomSendRun {
    readonly schedule: RoomSendSchedule;
    readonly roomRef: GroupRef;
    readonly instances: readonly RoomSendInstance[];
    readonly ledger: RoomSendOfferLedger;
    readonly log: RoomSendObservationLog;
    readonly clock: RoomSendClock;
    readonly readCpuUsage: () => RoomSendCpuUsage;
    /** What a publisher does to recover a send; undefined under the sender recovery `none`. */
    readonly clientStandIn: RoomSendClientStandIn | undefined;
    /** It grows with each ACK and each answer to a repair request: the run waits for them all before it returns. */
    readonly answersInFlight: Promise<void>[];
}

interface DueRoomSend {
    readonly send: RoomSendScheduledSend;
    /** The instance the publisher's socket is on. */
    readonly publisherInstance: RoomSendInstance;
    readonly dueAtMs: number;
}

const RUN_ID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

/** The application and workspace of every run's room, and of every session's proven scope. */
const ROOM_SEND_SCOPE = { applicationId: 'room-send-cell', workspaceId: 'default' };

/**
 * How often the run looks for a first-hop resend that has come due, a wait whose retries are spent and a send whose
 * lifetime is over: a resend leaves, and a send ends, at most this long after its deadline. The product's client
 * finds its deadline by its own work timer.
 */
const FIRST_HOP_POLL_MS = 10;

/** The timer whose lateness is sampled over the send window and over the tail. */
const LOOP_LAG_TICK_MS = 10;

/** A room presence outlasts any run by far. */
const ROOM_PRESENCE_LIFETIME_MS = 24 * 60 * 60 * 1_000;

/**
 * One run of the cell: three API instances in this process on one PostgreSQL database, fifteen sessions in one room,
 * and the shape's publishers each offering an ordered, receipted room send at its due instant. Returns everything
 * the run observed and what it read of its own process, or every issue of the shape and nothing run.
 *
 * What each thing takes on its way, as the API's own router decides it for a topic it has no definition of:
 * - a copy: the publisher's instance admits the send to the shared inbound store; whichever instance's worker takes
 *   its work row hands it to the router, which publishes one NOTIFY that carries the message, sends the copies of
 *   the sessions on that instance once the publish returned, and the other instances send theirs as the NOTIFY
 *   reaches them. No copy is a row of the WS outbox: one an instance missed is written again only when the send is
 *   handed to a router again. Once the server has admitted a send, its publisher offering it again brings no copy:
 *   the entry answers `duplicate` and hands nothing off. It is not without effect: while the send's receipt is still
 *   open on that instance, the instance writes the `admitted` receipt again, one more row of the WS outbox for each
 *   such offer (`WsQueueBoxServerReceiptAggregation.writeAdmittedReceipt`);
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
 * What differs from a deployment:
 * - one event loop runs the three instances and the load, where a deployment gives each instance a process. With no
 *   added latency that loop is busy most of the time, and two runs of one shape have differed several times over in
 *   how long an `admitted` receipt took: an absolute delay there measures the harness as much as the server. The
 *   result carries the loop's lag over the send window and over the tail to judge a run by, and the processor time
 *   of the whole process beside each;
 * - a frame enters at `acceptIncomingMessage`, below the socket bridge, so its size check and its JSON parse are no
 *   part of a run, and a session is a socket object the server writes to, with no WebSocket;
 * - a recipient has no client runtime: its socket takes every frame the server writes, a repeated copy and a copy
 *   ahead of its predecessor alike, where a client drops the first and holds the second back, and it sends no gap
 *   NACK of its own; it ACKs its first read of a copy and nothing else;
 * - a publisher reads a receipt each time it is written. What it does to recover a send is the shape's sender
 *   recovery: nothing under `none`; under `client-stand-in` what `RoomSendClientStandIn` states, a stand-in for
 *   the product's WS client whose comment also says what of that client it leaves out;
 * - the room authorizer admits a fixed audience and reads nothing, where the API's reads the room's current snapshot
 *   for each of the three decisions a send takes, and once more for each replay and each second dispatch: at least
 *   three round trips to the database a send that no run pays;
 * - the envelope carries no room send fence, which a browser's room send carries;
 * - no group and no client is in the database, so the target resolver has no snapshot to read and no connect,
 *   presence or heartbeat is written; none of the API's other workers run, no AppInbox reader among them, and no
 *   diagnostics sink is installed.
 *
 * No offer fails a run: what the entry answers is recorded as its answer, and an offer that throws, of a send, of a
 * send again or of an ACK, is recorded as `threw` with the error's name and message, and the run goes on to the end
 * of its tail.
 */
export async function runRoomSendCell(
    input: RunRoomSendCellInput,
    dependencies: RoomSendCellRunDependencies
): Promise<Either<readonly RoomSendShapeIssue[], RoomSendCellRunResult>> {
    const issues = validateRoomSendShape(input.shape);
    if (issues.length > 0) {
        return Either.ofLeft(issues);
    }
    assertRoomSendRunInput(input);
    const { clock, readCpuUsage } = dependencies;
    const schedule = computeRoomSendSchedule(input.shape);
    const roomRef = { ...ROOM_SEND_SCOPE, groupId: `room-${input.runId}` };
    const log = new RoomSendObservationLog(clock.nowMs);
    const instances = await createRoomSendInstances(input, { schedule, roomRef, log, clock });
    try {
        return Either.ofRight(
            await observeRoomSends({
                schedule,
                roomRef,
                instances,
                ledger: new RoomSendOfferLedger(),
                log,
                clock,
                readCpuUsage,
                clientStandIn: input.shape.senderRecovery === 'client-stand-in'
                    ? new RoomSendClientStandIn(ROOM_SEND_SERVER_PEER_ID)
                    : undefined,
                answersInFlight: []
            }, input.observationTailMs)
        );
    }
    finally {
        // A phase that threw left observation open: ending it here stops whatever still offers for the run.
        log.endObservation();
        await stopRoomSendInstances(instances);
    }
}

/** What only a caller's mistake gets wrong: the run's id and its tail are the caller's to make, never an operator's. */
function assertRoomSendRunInput(input: RunRoomSendCellInput): void {
    if (!RUN_ID.test(input.runId)) {
        throw new TypeError('runId must be a lower-case UUID.');
    }
    if (!Number.isFinite(input.observationTailMs) || input.observationTailMs < 0) {
        throw new TypeError('observationTailMs must be a finite number of at least 0.');
    }
}

export function createDefaultRoomSendCellRunDependencies(): RoomSendCellRunDependencies {
    return {
        clock: createDefaultRoomSendClock(),
        readCpuUsage: () => {
            const { user, system } = process.cpuUsage();
            return { userMicros: user, systemMicros: system };
        }
    };
}

/** The three instances, each on pools of its own. One that cannot be created closes those created before it. */
async function createRoomSendInstances(
    input: RunRoomSendCellInput,
    run: Pick<RoomSendRun, 'schedule' | 'roomRef' | 'log' | 'clock'>
): Promise<readonly RoomSendInstance[]> {
    const connectedAtEpochMs = run.clock.nowEpochMs();
    const authorizeRoomMessage = createRoomSendRoomAuthorizer({
        roomRef: run.roomRef,
        sessionPeerIds: run.schedule.sessions.map((session) => session.peerId),
        connectedAtEpochMs,
        expiresAtEpochMs: connectedAtEpochMs + ROOM_PRESENCE_LIFETIME_MS
    });
    const instances: RoomSendInstance[] = [];
    try {
        for (let instanceIndex = 0; instanceIndex < ROOM_SEND_CELL_CONSTANTS.instanceCount; instanceIndex += 1) {
            instances.push(
                await createDefaultRoomSendInstance(
                    {
                        instanceIndex,
                        delayMs: input.shape.delayMs,
                        applicationPoolMaxConnections: input.shape.applicationPoolMaxConnections,
                        runId: input.runId,
                        scope: ROOM_SEND_SCOPE,
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
        await stopRoomSendInstances(instances);
        throw error;
    }
}

/** The phases of a run, in order: start, warm, connect, the send window, the tail, and the end of observation. */
async function observeRoomSends(
    run: RoomSendRun,
    observationTailMs: number
): Promise<RoomSendCellRunResult> {
    await openRoomSendRoom(run);

    const windowStartedAtMs = run.clock.nowMs();
    const firstHopResends = run.clientStandIn === undefined
        ? Promise.resolve()
        : offerFirstHopResendsWhenDue(run.clientStandIn, run);
    const sendWindow = await readProcessFiguresOver(
        run,
        windowStartedAtMs,
        () => offerRoomSendsOverWindow(run, windowStartedAtMs)
    );
    const tailEndsAtMs = (run.ledger.getLastOfferAtMs() ?? windowStartedAtMs) + observationTailMs;
    const tail = await readProcessFiguresOver(run, run.clock.nowMs(), () => observeRoomSendTail(run, tailEndsAtMs));

    const reads = run.log.endObservation();
    const offers = run.ledger.close();
    const standInRecord = {
        sendEnds: [...(run.clientStandIn?.getSendEnds() ?? [])],
        declinedRepairs: [...(run.clientStandIn?.getDeclinedRepairs() ?? [])]
    };
    await Promise.all([...run.answersInFlight, firstHopResends]);
    return {
        observations: { ...offers, ...reads, ...standInRecord },
        runtime: {
            sendWindow,
            tail,
            applicationPoolMaxConnections: run.instances[0].applicationPoolMaxConnections
        }
    };
}

/**
 * What the process read of itself while `work` lasted, from `startedAtMs`: its processor time, and the lateness of a
 * timer armed again as each tick fired.
 */
async function readProcessFiguresOver(
    run: RoomSendRun,
    startedAtMs: number,
    work: () => Promise<void>
): Promise<RoomSendProcessFigures> {
    const cpuAtStart = run.readCpuUsage();
    const loopLagSampling = startRoomSendLoopLagSampling(run.clock, LOOP_LAG_TICK_MS);
    try {
        await work();
    }
    catch (error) {
        await loopLagSampling.stop();
        throw error;
    }
    const endedAtMs = run.clock.nowMs();
    const cpuAtEnd = run.readCpuUsage();
    return computeRoomSendProcessFigures({
        startedAtMs,
        endedAtMs,
        cpuAtStart,
        cpuAtEnd,
        loopLagsMs: await loopLagSampling.stop()
    });
}

/**
 * The send window: every send offered at its due instant. It ends with the last offer; the work the last offers
 * start goes on after it, in the tail.
 */
async function offerRoomSendsOverWindow(run: RoomSendRun, windowStartedAtMs: number): Promise<void> {
    await offerRoomSendsWhenDue({
        sends: run.schedule.sends.map((send): DueRoomSend => ({
            send,
            publisherInstance: run.instances[send.publisherInstanceIndex],
            dueAtMs: windowStartedAtMs + send.dueOffsetMs
        })),
        nowMs: run.clock.nowMs,
        sleep: run.clock.sleep,
        offer: (due) => offerRoomSend(due, run)
    });
}

/** Every instance subscribed and working, every application pool fully open, every session connected. */
async function openRoomSendRoom(run: RoomSendRun): Promise<void> {
    for (const instance of run.instances) {
        await instance.start();
    }
    await Promise.all(run.instances.map((instance) => instance.warmApplicationPool()));
    for (const session of run.schedule.sessions) {
        run.instances[session.instanceIndex].connectSession(session.peerId, toSessionSocket(session, run));
    }
}

/**
 * What the server writes a session's frames to. A frame is read the moment the server writes it. The session then
 * owes at most one ACK, which it offers its own instance after its ACK offset, and under the sender recovery
 * `client-stand-in` whatever its stand-in answers the frame.
 */
function toSessionSocket(session: RoomSendScheduledSession, run: RoomSendRun): ConnectionContext.Socket {
    return {
        readyState: WebSocket.OPEN,
        send: (frame) => {
            const recorded = run.log.recordSocketFrame(session.peerId, frame);
            if (recorded?.ackOwedCopy !== undefined) {
                run.answersInFlight.push(offerRoomSendAck(recorded.ackOwedCopy, session, run));
            }
            if (recorded !== undefined && run.clientStandIn !== undefined) {
                const answer = run.clientStandIn.acceptSocketRead(session.peerId, recorded.read);
                if (answer.reoffers.length > 0 || answer.followUp !== undefined) {
                    run.answersInFlight.push(offerRepairAnswer(answer, run.clientStandIn, run));
                }
            }
            return frame.length;
        },
        close: () => undefined
    };
}

/** The first offer of one send on its publisher's instance. What comes of it is recorded when it comes and waited for by nobody. */
function offerRoomSend(due: DueRoomSend, run: RoomSendRun): void {
    const { send } = due;
    const message = toRoomSendMessage({ send, roomRef: run.roomRef, createdAtEpochMs: run.clock.nowEpochMs() });
    const frame = JSON.stringify(message);
    const sentAtMs = run.clock.nowMs();
    const answered = readRoomSendCellAnswer(
        () => due.publisherInstance.acceptIncomingMessage(toWireValue(frame), send.publisherPeerId),
        run.clock.nowMs
    );
    run.ledger.recordOffer({
        msgId: send.msgId,
        publisherPeerId: send.publisherPeerId,
        seq: send.seq,
        dueAtMs: due.dueAtMs,
        sentAtMs,
        expectedRecipientPeerIds: send.expectedRecipientPeerIds
    });
    // A client's frame has left its socket whatever the server then does with it, so a stand-in holds the send
    // even when this offer throws.
    run.clientStandIn?.recordFirstOffer({ send, message, frame, offeredAtMs: sentAtMs });
    void answered.then((answer) => run.ledger.recordAnswer(send.msgId, answer));
}

/**
 * One later offer of a send: the frame of its first offer again, at the same entry of its publisher's instance. What
 * comes of it is recorded when it comes and waited for by nobody.
 */
function reofferRoomSend(reoffer: RoomSendClientStandIn.Reoffer, run: RoomSendRun): void {
    const { send } = reoffer;
    const sentAtMs = run.clock.nowMs();
    const answered = readRoomSendCellAnswer(
        () =>
            run.instances[send.publisherInstanceIndex]
                .acceptIncomingMessage(toWireValue(reoffer.frame), send.publisherPeerId),
        run.clock.nowMs
    );
    const resendPosition = run.ledger.recordResend({
        msgId: send.msgId,
        cause: reoffer.cause,
        attempt: reoffer.attempt,
        sentAtMs
    });
    void answered.then((answer) => run.ledger.recordResendAnswer(resendPosition, answer));
}

/**
 * Offers what a repair request asked for, while observation lasts: one turn of the event loop after its publisher
 * read the request, as a client that took it from a socket would, and each later execution of the request a turn
 * after the one before it. A send may end or expire in that turn, so each re-offer is asked of the stand-in again at
 * the instant it leaves, and one the stand-in then declines is not offered.
 */
async function offerRepairAnswer(
    firstAnswer: RoomSendClientStandIn.RepairAnswer,
    clientStandIn: RoomSendClientStandIn,
    run: RoomSendRun
): Promise<void> {
    let answer: RoomSendClientStandIn.RepairAnswer | undefined = firstAnswer;
    while (answer !== undefined) {
        await run.clock.sleep(0);
        if (!run.log.isObserving()) {
            return;
        }
        for (const reoffer of answer.reoffers) {
            if (clientStandIn.confirmRepairReoffer(reoffer, run.clock.nowMs())) {
                reofferRoomSend(reoffer, run);
            }
        }
        answer = answer.followUp === undefined
            ? undefined
            : clientStandIn.serveRepairFollowUp(answer.followUp, run.clock.nowMs());
    }
}

/**
 * Offers each first-hop resend within one poll of its deadline, while observation lasts, and has the stand-in end
 * within one poll each send whose retries are spent or whose lifetime is over.
 */
async function offerFirstHopResendsWhenDue(
    clientStandIn: RoomSendClientStandIn,
    run: RoomSendRun
): Promise<void> {
    await run.clock.sleep(FIRST_HOP_POLL_MS);
    while (run.log.isObserving()) {
        const nowMs = run.clock.nowMs();
        clientStandIn.takeFirstHopResendsDue(nowMs).forEach((reoffer) => reofferRoomSend(reoffer, run));
        clientStandIn.endExpiredSends(nowMs);
        await run.clock.sleep(FIRST_HOP_POLL_MS);
    }
}

/**
 * One ACK of one copy, offered on the reader's own instance once its ACK offset passed, while observation lasts, and
 * recorded with what came of it.
 */
async function offerRoomSendAck(
    copy: ALMessage,
    session: RoomSendScheduledSession,
    run: RoomSendRun
): Promise<void> {
    await run.clock.sleep(session.ackOffsetMs);
    if (!run.log.isObserving()) {
        return;
    }
    const ack = toRoomSendAck({
        copy,
        recipientPeerId: session.peerId,
        observedAtEpochMs: run.clock.nowEpochMs()
    });
    const frame = toWireValue(JSON.stringify(ack));
    const ackPosition = run.ledger.recordAck({
        msgId: copy.id.msgId,
        recipientPeerId: session.peerId,
        sentAtMs: run.clock.nowMs()
    });
    run.ledger.recordAckAnswer(
        ackPosition,
        await readRoomSendCellAnswer(
            () => run.instances[session.instanceIndex].acceptIncomingMessage(frame, session.peerId),
            run.clock.nowMs
        )
    );
}

/**
 * Waits until `endAtMs`, whatever the sessions have read and whatever an offer threw by then: a send whose receipt is
 * complete may still read that receipt again, and the server may write a `timed-out` receipt long after its send's
 * deadline. Nothing says that no receipt comes after `endAtMs` either; a send without a terminal receipt by then is
 * counted as such.
 */
async function observeRoomSendTail(run: RoomSendRun, endAtMs: number): Promise<void> {
    let remainingMs = endAtMs - run.clock.nowMs();
    while (remainingMs > 0) {
        await run.clock.sleep(remainingMs);
        remainingMs = endAtMs - run.clock.nowMs();
    }
}

/** Stops every instance's work before any pool closes, and fails with every failure there was. */
async function stopRoomSendInstances(instances: readonly RoomSendInstance[]): Promise<void> {
    const stopped = await Promise.allSettled(instances.map((instance) => instance.stop()));
    const closed = await Promise.allSettled(instances.map((instance) => instance.close()));
    const failures = [...stopped, ...closed]
        .flatMap((outcome) => outcome.status === 'rejected' ? [toError(outcome.reason)] : []);
    if (failures.length > 0) {
        throw new AggregateError(failures, 'The room-send cell failed to stop its instances.');
    }
}

/** A frame as the server's socket bridge hands it to the entry: its JSON, parsed. */
function toWireValue(frame: string): object {
    return JSON.parse(frame);
}
