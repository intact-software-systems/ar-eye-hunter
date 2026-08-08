// prettier-ignore
import {
  type OverlayAdoptionDiagnosticsEvent,
  setOverlayAdoptionDiagnosticsSink,
} from '@shared/repository/overlays-repository.ts';

export type RallarOverlayAdoptionDiagnostics = Readonly<{
  initialSetCount: number;
  adoptedCount: number;
  equalCount: number;
  dominatedDroppedCount: number;
  incomparableConflictCount: number;
}>;

type MutableOverlayAdoptionDiagnostics = {
  -readonly [K in keyof RallarOverlayAdoptionDiagnostics]: number;
};

// One process-wide counter object keeps the browser surface additive and opt-in.
const counters: MutableOverlayAdoptionDiagnostics = emptyCounters();

export function initOverlayAdoptionDiagnostics(): void {
  setOverlayAdoptionDiagnosticsSink(recordOverlayAdoption);
}

export function readOverlayAdoptionDiagnostics(): RallarOverlayAdoptionDiagnostics {
  return { ...counters };
}

export function resetOverlayAdoptionDiagnostics(): void {
  Object.assign(counters, emptyCounters());
}

function recordOverlayAdoption(event: OverlayAdoptionDiagnosticsEvent): void {
  if (event.outcome === 'initial-set') {
    counters.initialSetCount += 1;
  } else if (event.outcome === 'adopted') {
    counters.adoptedCount += 1;
  } else if (event.outcome === 'equal') {
    counters.equalCount += 1;
  } else if (event.outcome === 'dominated-dropped') {
    counters.dominatedDroppedCount += 1;
  } else if (event.outcome === 'incomparable-conflict') {
    counters.incomparableConflictCount += 1;
  }
}

function emptyCounters(): MutableOverlayAdoptionDiagnostics {
  return {
    initialSetCount: 0,
    adoptedCount: 0,
    equalCount: 0,
    dominatedDroppedCount: 0,
    incomparableConflictCount: 0,
  };
}
