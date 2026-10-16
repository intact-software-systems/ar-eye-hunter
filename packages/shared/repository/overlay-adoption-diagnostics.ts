export type OverlayAdoptionOutcome =
    | 'initial-set'
    | 'adopted'
    | 'equal'
    | 'dominated-dropped'
    | 'membership-ineligible-dropped'
    | 'membership-ineligible-deferred'
    | 'membership-deferred-adopted'
    | 'incomparable-conflict'
    | 'server-superseded-bootstrap'
    | 'bootstrap-dropped-over-server';

export interface OverlayAdoptionDiagnosticsEvent {
    readonly overlayId: string;
    readonly outcome: OverlayAdoptionOutcome;
}

export type OverlayAdoptionDiagnosticsSink = (
    event: OverlayAdoptionDiagnosticsEvent
) => void;

export interface RallarOverlayAdoptionDiagnostics {
    readonly initialSetCount: number;
    readonly adoptedCount: number;
    readonly equalCount: number;
    readonly dominatedDroppedCount: number;
    readonly membershipIneligibleDroppedCount: number;
    readonly membershipIneligibleDeferredCount: number;
    readonly membershipDeferredAdoptedCount: number;
    readonly incomparableConflictCount: number;
    readonly serverSupersededBootstrapCount: number;
    readonly bootstrapDroppedOverServerCount: number;
}

type MutableOverlayAdoptionDiagnostics = {
    -readonly [Counter in keyof RallarOverlayAdoptionDiagnostics]: number;
};

const OVERLAY_ADOPTION_OUTCOME_COUNTERS = {
    'initial-set': 'initialSetCount',
    adopted: 'adoptedCount',
    equal: 'equalCount',
    'dominated-dropped': 'dominatedDroppedCount',
    'membership-ineligible-dropped': 'membershipIneligibleDroppedCount',
    'membership-ineligible-deferred': 'membershipIneligibleDeferredCount',
    'membership-deferred-adopted': 'membershipDeferredAdoptedCount',
    'incomparable-conflict': 'incomparableConflictCount',
    'server-superseded-bootstrap': 'serverSupersededBootstrapCount',
    'bootstrap-dropped-over-server': 'bootstrapDroppedOverServerCount'
} as const satisfies Record<OverlayAdoptionOutcome, keyof RallarOverlayAdoptionDiagnostics>;

// One process-wide sink and counter object keep the adoption surface additive and opt-in.
let adoptionDiagnosticsSink: OverlayAdoptionDiagnosticsSink | undefined;
const adoptionCounters: MutableOverlayAdoptionDiagnostics = createEmptyOverlayAdoptionDiagnostics();

export function setOverlayAdoptionDiagnosticsSink(
    sink: OverlayAdoptionDiagnosticsSink | undefined
): void {
    adoptionDiagnosticsSink = sink;
}

export function readOverlayAdoptionDiagnostics(): RallarOverlayAdoptionDiagnostics {
    return { ...adoptionCounters };
}

export function resetOverlayAdoptionDiagnostics(): void {
    Object.assign(adoptionCounters, createEmptyOverlayAdoptionDiagnostics());
}

function createEmptyOverlayAdoptionDiagnostics(): MutableOverlayAdoptionDiagnostics {
    return {
        initialSetCount: 0,
        adoptedCount: 0,
        equalCount: 0,
        dominatedDroppedCount: 0,
        membershipIneligibleDroppedCount: 0,
        membershipIneligibleDeferredCount: 0,
        membershipDeferredAdoptedCount: 0,
        incomparableConflictCount: 0,
        serverSupersededBootstrapCount: 0,
        bootstrapDroppedOverServerCount: 0
    };
}

export function emitOverlayAdoption(
    overlayId: string,
    outcome: OverlayAdoptionOutcome
): void {
    adoptionCounters[OVERLAY_ADOPTION_OUTCOME_COUNTERS[outcome]] += 1;
    try {
        adoptionDiagnosticsSink?.({ overlayId, outcome });
    }
    catch {
        // Recording must never affect overlay adoption behavior.
    }
}
