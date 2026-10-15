import type { RallarRoomLayoutEvent } from '@shared-web/browser/rooms/formation/rallar-room-formation-contracts.ts';
import {
    isSameGroupLayoutIdentity,
    type GroupLayoutIdentity
} from '@shared/api/group-lifecycle/group-layout-identity.ts';

/** The `rallar.timing` shape the API journal uses, so one script attributes the server's and the browser's lines. */
export interface BlackBoxRallarLayoutTimingDiagnostic {
    readonly type: 'rallar.timing';
    readonly component: 'browser-formation';
    readonly operation: 'replan' | 'promotion';
    readonly status: 'ok';
    readonly durationMs: number;
    readonly atEpochMs: number;
    readonly details:
        | Readonly<{ planned: GroupLayoutIdentity; superseded: GroupLayoutIdentity | null; }>
        | Readonly<{ accepted: GroupLayoutIdentity; expected: GroupLayoutIdentity | null; expectedMatched: boolean; }>;
}

/** A planned layout the page observed and when, the fence the next promotion is measured against. */
interface ObservedPlannedLayout {
    readonly identity: GroupLayoutIdentity;
    readonly atEpochMs: number;
}

/** One room's layout events as timing lines: a replan from the plan it supersedes, a promotion from its plan. */
export class FormationLayoutTiming {
    readonly #emit: (timing: BlackBoxRallarLayoutTimingDiagnostic) => void;
    #observedPlanned: ObservedPlannedLayout | undefined;

    constructor(emit: (timing: BlackBoxRallarLayoutTimingDiagnostic) => void) {
        this.#emit = emit;
    }

    observe(event: RallarRoomLayoutEvent, atEpochMs: number): void {
        const timing = this.toTimingDiagnostic(event, atEpochMs);
        if (timing !== undefined) {
            this.#emit(timing);
        }
    }

    private toTimingDiagnostic(
        event: RallarRoomLayoutEvent,
        atEpochMs: number
    ): BlackBoxRallarLayoutTimingDiagnostic | undefined {
        const observedPlanned = this.#observedPlanned;
        switch (event.kind) {
            case 'layoutPlanned':
                this.#observedPlanned = { identity: event.layout.identity, atEpochMs };
                return {
                    ...toTimingLine('replan', observedPlanned, atEpochMs),
                    details: { planned: event.layout.identity, superseded: observedPlanned?.identity ?? null }
                };
            case 'layoutAccepted':
                this.#observedPlanned = undefined;
                return {
                    ...toTimingLine('promotion', observedPlanned, atEpochMs),
                    details: {
                        accepted: event.layout.identity,
                        expected: observedPlanned?.identity ?? null,
                        expectedMatched: observedPlanned !== undefined &&
                            isSameGroupLayoutIdentity(observedPlanned.identity, event.layout.identity)
                    }
                };
            case 'layoutRemoved':
                if (event.role === 'planned') {
                    this.#observedPlanned = undefined;
                }
                return undefined;
        }
    }
}

function toTimingLine(
    operation: BlackBoxRallarLayoutTimingDiagnostic['operation'],
    observedPlanned: ObservedPlannedLayout | undefined,
    atEpochMs: number
): Omit<BlackBoxRallarLayoutTimingDiagnostic, 'details'> {
    return {
        type: 'rallar.timing',
        component: 'browser-formation',
        operation,
        status: 'ok',
        durationMs: observedPlanned === undefined ? 0 : atEpochMs - observedPlanned.atEpochMs,
        atEpochMs
    };
}
