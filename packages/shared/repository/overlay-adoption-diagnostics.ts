export type OverlayAdoptionOutcome =
    | 'initial-set'
    | 'adopted'
    | 'equal'
    | 'dominated-dropped'
    | 'membership-ineligible-dropped'
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
    readonly incomparableConflictCount: number;
    readonly serverSupersededBootstrapCount: number;
    readonly bootstrapDroppedOverServerCount: number;
}

interface MutableOverlayAdoptionDiagnostics {
    initialSetCount: number;
    adoptedCount: number;
    equalCount: number;
    dominatedDroppedCount: number;
    incomparableConflictCount: number;
    serverSupersededBootstrapCount: number;
    bootstrapDroppedOverServerCount: number;
}

// One process-wide sink and counter object keep the adoption surface additive and opt-in.
let adoptionDiagnosticsSink: OverlayAdoptionDiagnosticsSink | undefined;
const adoptionCounters: MutableOverlayAdoptionDiagnostics = emptyOverlayAdoptionDiagnostics();

export function setOverlayAdoptionDiagnosticsSink(
    sink: OverlayAdoptionDiagnosticsSink | undefined
): void {
    adoptionDiagnosticsSink = sink;
}

export function readOverlayAdoptionDiagnostics(): RallarOverlayAdoptionDiagnostics {
    return { ...adoptionCounters };
}

export function resetOverlayAdoptionDiagnostics(): void {
    Object.assign(adoptionCounters, emptyOverlayAdoptionDiagnostics());
}

function emptyOverlayAdoptionDiagnostics(): MutableOverlayAdoptionDiagnostics {
    return {
        initialSetCount: 0,
        adoptedCount: 0,
        equalCount: 0,
        dominatedDroppedCount: 0,
        incomparableConflictCount: 0,
        serverSupersededBootstrapCount: 0,
        bootstrapDroppedOverServerCount: 0
    };
}

export function emitOverlayAdoption(
    overlayId: string,
    outcome: OverlayAdoptionOutcome
): void {
    if (outcome === 'membership-ineligible-dropped') {
        // Membership eligibility is a routing/lifecycle admission decision, not
        // a repository adoption aggregate. Slice 8a emits the sink event but
        // adds no public diagnostics-facade counter for this outcome.
    }
    else if (outcome === 'initial-set') {
        adoptionCounters.initialSetCount += 1;
    }
    else if (outcome === 'adopted') {
        adoptionCounters.adoptedCount += 1;
    }
    else if (outcome === 'equal') {
        adoptionCounters.equalCount += 1;
    }
    else if (outcome === 'dominated-dropped') {
        adoptionCounters.dominatedDroppedCount += 1;
    }
    else if (outcome === 'server-superseded-bootstrap') {
        adoptionCounters.serverSupersededBootstrapCount += 1;
    }
    else if (outcome === 'bootstrap-dropped-over-server') {
        adoptionCounters.bootstrapDroppedOverServerCount += 1;
    }
    else {
        adoptionCounters.incomparableConflictCount += 1;
    }
    try {
        adoptionDiagnosticsSink?.({ overlayId, outcome });
    }
    catch {
        // Recording must never affect overlay adoption behavior.
    }
}
