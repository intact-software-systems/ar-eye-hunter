import type {
    RallarRtcFacade,
    RallarRtcRoomTransportStatus
} from '@shared-web/browser/rallar-rtc-facade.ts';
import type { RallarUnsubscribe } from '@shared-web/browser/rallar-shared-contracts.ts';
import type {
    RallarRoomFormation,
    RallarRoomFormationStatus
} from '@shared-web/browser/rooms/formation/rallar-room-formation-contracts.ts';
import { describeRtcRoomTransport } from '@shared-web/browser/rtc/rtc-room-transport-status.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';

import type {
    BlackBoxRallarEvent,
    BlackBoxRallarFormationCommandDiagnostics,
    BlackBoxRallarFormationCommandRequest,
    BlackBoxRallarFormationReadinessDiagnostics,
    BlackBoxRallarFormationRoomInput,
    BlackBoxRallarFormationRoomStatus,
    BlackBoxRallarFormationRuntime,
    BlackBoxRallarFormationSummary
} from '../black-box-rallar-operation-contracts.ts';

export const BLACK_BOX_RALLAR_FORMATION_TOPICS = {
    changed: 'rallar.browser.formation.changed',
    layout: 'rallar.browser.formation.layout',
    roomStatus: 'rallar.browser.formation.room-status',
    ready: 'rallar.browser.formation.ready'
} as const;

export interface BlackBoxRallarFormationControllerDependencies {
    formation(roomRef: GroupRef): RallarRoomFormation;
    readonly rtc: Pick<RallarRtcFacade, 'roomStatus' | 'waitForRoom' | 'onStatus'>;
    emit(event: Omit<BlackBoxRallarEvent, 'atEpochMs'>): void;
    now(): number;
}

export interface FormationReadinessCapturedFactsInput {
    readonly returnedRoomReason: unknown;
    readonly laneId: unknown;
    readonly desiredPeerIds: unknown;
    readonly readyPeerIds: unknown;
    readonly peerIdentitiesTruncated: unknown;
}

export interface FormationReadinessCapturedFacts {
    readonly returnedRoomReason: string | null;
    readonly laneId: string | null;
    readonly desiredPeerIds: readonly string[] | null;
    readonly readyPeerIds: readonly string[] | null;
    readonly peerIdentitiesTruncated: boolean | null;
}

const FORMATION_CAPTURED_ROOM_REASONS = [
    describeRtcRoomTransport('halted'),
    describeRtcRoomTransport('idle'),
    describeRtcRoomTransport('partial'),
    describeRtcRoomTransport('degraded'),
    describeRtcRoomTransport('idle', 'empty'),
    describeRtcRoomTransport('idle', 'timeout'),
    describeRtcRoomTransport('idle', 'failed'),
    describeRtcRoomTransport('idle', 'aborted'),
    describeRtcRoomTransport('idle', 'not-connected')
];

interface FormationReadinessRejection extends FormationReadinessCapturedFacts {
    readonly kind: 'formation-readiness-rejected';
    readonly roomTransportState: RallarRtcRoomTransportStatus['state'];
    readonly summaryAvailable: boolean;
    readonly roomOpen: boolean;
    readonly hasDesiredPeers: boolean;
    readonly desiredPeerCount: number;
    readonly readyPeerCount: number;
    readonly waitTerminalCause: 'unknown';
}

/**
 * The browser-side formation surface the black-box agents drive: it issues one of the eight
 * lifecycle commands through the shipped room handle, awaits the browser's own room readiness
 * without touching the network, and forwards what it observes as diagnostics.
 */
export class BlackBoxRallarFormationController implements BlackBoxRallarFormationRuntime {
    readonly #dependencies: BlackBoxRallarFormationControllerDependencies;

    constructor(dependencies: BlackBoxRallarFormationControllerDependencies) {
        this.#dependencies = dependencies;
    }

    command = async (
        request: BlackBoxRallarFormationCommandRequest
    ): Promise<BlackBoxRallarFormationCommandDiagnostics> => {
        const handle = this.#dependencies.formation(request.roomRef);
        const receipt = await this.#issue(handle, request);
        return { receipt, formation: this.#requireSummary(request.roomRef) };
    };

    /** Observes the product room-readiness owner without opening a lane itself. */
    readiness = async (
        room: BlackBoxRallarFormationRoomInput
    ): Promise<BlackBoxRallarFormationReadinessDiagnostics> => {
        const status = await this.#dependencies.rtc.waitForRoom(room.roomRef, {
            connect: false,
            timeoutMs: room.timeoutMs
        });
        const formationStatus = this.#dependencies.formation(room.roomRef).status();
        const summary = formationStatus === undefined
            ? undefined
            : toFormationSummary(room.roomRef, formationStatus, status.rtc);
        if (
            summary === undefined ||
            summary.room.state !== 'open' ||
            summary.room.desiredPeerIds.length === 0
        ) {
            const observation = toFormationReadinessRejection(status.rtc, summary !== undefined);
            const error = this.#notReady(room);
            try {
                this.#emit('rallar.browser.formation.not-ready', room.roomRef, observation);
            }
            catch {
                // The captured observation must not replace the original readiness failure.
            }
            throw error;
        }

        const diagnostics: BlackBoxRallarFormationReadinessDiagnostics = {
            readyAtEpochMs: this.#dependencies.now(),
            formation: summary
        };
        this.#emit(
            BLACK_BOX_RALLAR_FORMATION_TOPICS.ready,
            room.roomRef,
            diagnostics
        );
        return diagnostics;
    };

    summary = (roomRef: GroupRef): BlackBoxRallarFormationSummary | undefined => {
        const status = this.#dependencies.formation(roomRef).status();
        return status === undefined
            ? undefined
            : toFormationSummary(roomRef, status, this.#dependencies.rtc.roomStatus(roomRef).rtc);
    };

    installDiagnostics = (roomRef: GroupRef): RallarUnsubscribe => {
        const handle = this.#dependencies.formation(roomRef);
        const subscriptions = [
            handle.onChange((status) =>
                this.#emit(
                    BLACK_BOX_RALLAR_FORMATION_TOPICS.changed,
                    roomRef,
                    toFormationSummary(roomRef, status, this.#dependencies.rtc.roomStatus(roomRef).rtc)
                )
            ),
            handle.onLayout((event) =>
                this.#emit(BLACK_BOX_RALLAR_FORMATION_TOPICS.layout, roomRef, {
                    kind: event.kind,
                    ...(event.kind === 'layoutRemoved'
                        ? { role: event.role, identity: event.previous.identity }
                        : { role: event.layout.role, identity: event.layout.identity })
                })
            ),
            this.#dependencies.rtc.onStatus(() => {
                const summary = this.summary(roomRef);
                if (summary !== undefined) {
                    this.#emit(BLACK_BOX_RALLAR_FORMATION_TOPICS.roomStatus, roomRef, {
                        room: summary.room,
                        groupRevision: summary.causalRevision.groupRevision
                    });
                }
            })
        ];
        return () => {
            for (const unsubscribe of subscriptions) {
                unsubscribe();
            }
        };
    };

    #issue = (
        handle: RallarRoomFormation,
        request: BlackBoxRallarFormationCommandRequest
    ): Promise<GroupSnapshot> => {
        const { input } = request;
        const options = request.reason === undefined ? {} : { reason: request.reason };
        switch (input.command) {
            case 'connect':
                return handle.connect(
                    input.layout === undefined
                        ? options
                        : { ...options, layout: input.layout }
                );
            case 'reconfigure':
                return handle.reconfigure(
                    input.landing === undefined
                        ? options
                        : { ...options, landing: input.landing }
                );
            case 'plan':
                return handle.plan(options);
            case 'activate':
                return handle.activate(options);
            case 'pause':
                return handle.pause(options);
            case 'resume':
                return handle.resume(options);
            case 'reset':
                return handle.reset(options);
            case 'start':
                return handle.start(options);
        }
    };

    #notReady = (room: BlackBoxRallarFormationRoomInput): Error => {
        const summary = this.summary(room.roomRef);
        const observed = summary === undefined ? 'no room held' : 'state ' + summary.room.state;
        return new Error(
            'RALLAR_BLACK_BOX_FORMATION_NOT_READY: the room did not open within ' +
                room.timeoutMs +
                ' ms (' +
                observed +
                ').'
        );
    };

    #requireSummary = (roomRef: GroupRef): BlackBoxRallarFormationSummary => {
        const summary = this.summary(roomRef);
        if (summary === undefined) {
            throw new Error(
                'RALLAR_BLACK_BOX_FORMATION_ROOM_NOT_HELD: ' + roomRef.groupId
            );
        }
        return summary;
    };

    #emit = (topic: string, roomRef: GroupRef, data: object): void => {
        this.#dependencies.emit({
            kind: 'diagnostic',
            topic,
            roomId: roomRef.groupId,
            applicationId: roomRef.applicationId,
            workspaceId: roomRef.workspaceId,
            data
        });
    };
}

/** Sanitizes only supplemental returned-room facts; readiness policy and counts stay with their owners. */
export function toFormationReadinessCapturedFacts(
    input: FormationReadinessCapturedFactsInput
): FormationReadinessCapturedFacts {
    const desiredCandidates = toCapturedPeerIdentities(input.desiredPeerIds);
    const readyCandidates = toCapturedPeerIdentities(input.readyPeerIds);
    const desiredPeerIds: string[] | null = desiredCandidates === null ? null : [];
    const readyPeerIds: string[] | null = readyCandidates === null ? null : [];
    const facts = {
        returnedRoomReason: typeof input.returnedRoomReason === 'string' &&
                FORMATION_CAPTURED_ROOM_REASONS.includes(input.returnedRoomReason)
            ? input.returnedRoomReason
            : null,
        laneId: isCapturedPeerIdentity(input.laneId) ? input.laneId : null,
        desiredPeerIds,
        readyPeerIds,
        peerIdentitiesTruncated: typeof input.peerIdentitiesTruncated === 'boolean'
            ? input.peerIdentitiesTruncated
            : null
    };
    if (desiredPeerIds === null || readyPeerIds === null) {
        facts.peerIdentitiesTruncated = facts.peerIdentitiesTruncated === true ? true : null;
    }
    if (
        (desiredPeerIds !== null && Array.isArray(input.desiredPeerIds) &&
            input.desiredPeerIds.length > 10) ||
        (readyPeerIds !== null && Array.isArray(input.readyPeerIds) &&
            input.readyPeerIds.length > 10)
    ) {
        facts.peerIdentitiesTruncated = true;
    }
    if (desiredPeerIds && desiredCandidates && appendCapturedPeerIdentities(facts, desiredPeerIds, desiredCandidates)) {
        facts.peerIdentitiesTruncated = true;
    }
    if (readyPeerIds && readyCandidates && appendCapturedPeerIdentities(facts, readyPeerIds, readyCandidates)) {
        facts.peerIdentitiesTruncated = true;
    }
    return facts;
}

/** Each list retains its longest prefix that fits beside previously retained facts. */
function appendCapturedPeerIdentities(
    facts: FormationReadinessCapturedFacts,
    retained: string[],
    candidates: readonly string[]
): boolean {
    for (const identity of candidates) {
        retained.push(identity);
        // This caps the facts payload, not its recorder envelope or unrelated metadata.
        if (new TextEncoder().encode(JSON.stringify(facts)).byteLength > 8_192) {
            retained.pop();
            return true;
        }
    }
    return false;
}

function toCapturedPeerIdentities(value: unknown): string[] | null {
    return Array.isArray(value) && value.every(isCapturedPeerIdentity)
        ? value.slice(0, 10)
        : null;
}

function isCapturedPeerIdentity(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0 && value.length <= 256;
}

function toFormationReadinessRejection(
    room: RallarRtcRoomTransportStatus,
    summaryAvailable: boolean
): FormationReadinessRejection {
    return {
        kind: 'formation-readiness-rejected',
        roomTransportState: room.state,
        summaryAvailable,
        roomOpen: room.state === 'open',
        hasDesiredPeers: room.desiredPeerIds.length > 0,
        desiredPeerCount: room.desiredPeerIds.length,
        readyPeerCount: room.readyPeerIds.length,
        waitTerminalCause: 'unknown',
        ...toFormationReadinessCapturedFacts({
            returnedRoomReason: room.reason,
            laneId: room.laneId,
            desiredPeerIds: room.desiredPeerIds,
            readyPeerIds: room.readyPeerIds,
            peerIdentitiesTruncated: false
        })
    };
}

/**
 * Built field by field rather than spread: the status declares its absent-capable fields as
 * required-with-`undefined`, and a spread would carry explicit `undefined` keys into the block
 * that a recipe's `exists` operator then reads as present.
 */
function toFormationSummary(
    roomRef: GroupRef,
    status: RallarRoomFormationStatus,
    room: RallarRtcRoomTransportStatus
): BlackBoxRallarFormationSummary {
    return {
        roomRef,
        stage: status.stage,
        formationEpoch: status.formationEpoch,
        formationAttemptCount: status.formationAttemptCount,
        ...(status.lastFormationOutcome !== undefined
            ? { lastFormationOutcome: status.lastFormationOutcome }
            : {}),
        causalRevision: status.snapshot.causalRevision,
        transportState: status.transportState,
        dialing: status.dialing,
        memberPolicy: status.memberPolicy,
        ...(status.accepted !== undefined ? { accepted: status.accepted } : {}),
        ...(status.planned !== undefined ? { planned: status.planned } : {}),
        ...(status.condition !== undefined
            ? { condition: status.condition }
            : {}),
        ...(status.coverageRate !== undefined
            ? { coverageRate: status.coverageRate }
            : {}),
        room: toFormationRoomStatus(room)
    };
}

/** The room block a pin may assert on; the peers array, lane id and read-time clock are dropped. */
function toFormationRoomStatus(
    room: RallarRtcRoomTransportStatus
): BlackBoxRallarFormationRoomStatus {
    return {
        state: room.state,
        ...(room.acceptedLayoutIdentity !== undefined
            ? { acceptedLayoutIdentity: room.acceptedLayoutIdentity }
            : {}),
        desiredPeerIds: room.desiredPeerIds,
        readyPeerIds: room.readyPeerIds,
        activePeerIds: room.activePeerIds,
        failedPeerIds: room.failedPeerIds
    };
}
