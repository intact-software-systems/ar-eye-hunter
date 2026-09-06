import type { RallarRtcFacade } from '@shared-web/browser/rallar-rtc-facade.ts';
import type { RallarUnsubscribe } from '@shared-web/browser/rallar-shared-contracts.ts';
import type {
    RallarRoomFormation,
    RallarRoomFormationStatus
} from '@shared-web/browser/rooms/formation/rallar-room-formation-contracts.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';

import type { BlackBoxRallarRuntimeDiagnostics } from './black-box-rallar-diagnostics.ts';
import type {
    BlackBoxRallarEvent,
    BlackBoxRallarFormationCommandDiagnostics,
    BlackBoxRallarFormationCommandRequest,
    BlackBoxRallarFormationReadinessDiagnostics,
    BlackBoxRallarFormationRoomInput,
    BlackBoxRallarFormationRoomStatus,
    BlackBoxRallarFormationRuntime,
    BlackBoxRallarFormationSummary
} from './black-box-rallar-operation-contracts.ts';

export const BLACK_BOX_RALLAR_FORMATION_TOPICS = {
    changed: 'rallar.browser.formation.changed',
    layout: 'rallar.browser.formation.layout',
    roomStatus: 'rallar.browser.formation.room-status',
    ready: 'rallar.browser.formation.ready'
} as const;

export interface BlackBoxRallarFormationControllerDependencies {
    formation(roomRef: GroupRef): RallarRoomFormation;
    readonly rtc: Pick<RallarRtcFacade, 'roomStatus' | 'onStatus'>;
    emit(event: Omit<BlackBoxRallarEvent, 'atEpochMs'>): void;
    readonly emitError: BlackBoxRallarRuntimeDiagnostics['emitError'];
    now(): number;
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

    /**
     * The browser's own readiness fence (settled question Q3). It observes and never dials: the
     * room reads `open` the moment every desired peer is ready, and the non-empty desired set is
     * what keeps a layout with no peers at all from satisfying it on the first tick. Both wake
     * sources are load-bearing, because the RTC status stream never fires on the arrival of the
     * accepted layout that supplies the desired set.
     */
    readiness = (room: BlackBoxRallarFormationRoomInput): Promise<BlackBoxRallarFormationReadinessDiagnostics> => {
        const settled = this.#settleReadiness(room);
        if (settled !== undefined) {
            return Promise.resolve(settled);
        }

        return new Promise((resolve, reject) => {
            const subscriptions: RallarUnsubscribe[] = [];
            const stop = (): void => {
                clearTimeout(timer);
                for (const unsubscribe of subscriptions) {
                    unsubscribe();
                }
            };
            const settle = (): void => {
                const ready = this.#settleReadiness(room);
                if (ready !== undefined) {
                    stop();
                    resolve(ready);
                }
            };
            const timer = setTimeout(() => {
                stop();
                reject(this.#notReady(room));
            }, room.timeoutMs);

            subscriptions.push(this.#dependencies.rtc.onStatus(() => settle()));
            subscriptions.push(this.#dependencies.formation(room.roomRef).onChange(() => settle()));
            settle();
        });
    };

    summary = (roomRef: GroupRef): BlackBoxRallarFormationSummary | undefined => {
        const status = this.#dependencies.formation(roomRef).status();
        return status === undefined ? undefined : this.#toSummary(roomRef, status);
    };

    installDiagnostics = (roomRef: GroupRef): RallarUnsubscribe => {
        const handle = this.#dependencies.formation(roomRef);
        const subscriptions = [
            handle.onChange((status) =>
                this.#emit(BLACK_BOX_RALLAR_FORMATION_TOPICS.changed, roomRef, this.#toSummary(roomRef, status))
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
                return handle.connect(input.layout === undefined ? options : { ...options, layout: input.layout });
            case 'reconfigure':
                return handle.reconfigure(
                    input.landing === undefined ? options : { ...options, landing: input.landing }
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

    #settleReadiness = (
        room: BlackBoxRallarFormationRoomInput
    ): BlackBoxRallarFormationReadinessDiagnostics | undefined => {
        const summary = this.summary(room.roomRef);
        if (summary === undefined || summary.room.state !== 'open' || summary.room.desiredPeerIds.length === 0) {
            return undefined;
        }

        const diagnostics: BlackBoxRallarFormationReadinessDiagnostics = {
            readyAtEpochMs: this.#dependencies.now(),
            formation: summary
        };
        this.#emit(BLACK_BOX_RALLAR_FORMATION_TOPICS.ready, room.roomRef, diagnostics);
        return diagnostics;
    };

    #notReady = (room: BlackBoxRallarFormationRoomInput): Error => {
        const summary = this.summary(room.roomRef);
        const observed = summary === undefined ? 'no room held' : 'state ' + summary.room.state;
        return new Error(
            'RALLAR_BLACK_BOX_FORMATION_NOT_READY: the room did not open within ' +
                room.timeoutMs + ' ms (' + observed + ').'
        );
    };

    #requireSummary = (roomRef: GroupRef): BlackBoxRallarFormationSummary => {
        const summary = this.summary(roomRef);
        if (summary === undefined) {
            throw new Error('RALLAR_BLACK_BOX_FORMATION_ROOM_NOT_HELD: ' + roomRef.groupId);
        }
        return summary;
    };

    /**
     * Built field by field rather than spread: the status declares its absent-capable fields as
     * required-with-`undefined`, and a spread would carry explicit `undefined` keys into the block
     * that a recipe's `exists` operator then reads as present.
     */
    #toSummary = (roomRef: GroupRef, status: RallarRoomFormationStatus): BlackBoxRallarFormationSummary => {
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
            ...(status.condition !== undefined ? { condition: status.condition } : {}),
            ...(status.coverageRate !== undefined ? { coverageRate: status.coverageRate } : {}),
            room: this.#toRoomStatus(roomRef)
        };
    };

    /** The room block a pin may assert on; the peers array, lane id and read-time clock are dropped. */
    #toRoomStatus = (roomRef: GroupRef): BlackBoxRallarFormationRoomStatus => {
        const room = this.#dependencies.rtc.roomStatus(roomRef).rtc;
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
