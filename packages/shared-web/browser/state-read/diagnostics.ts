import type { StateSnapshotReadSource } from '@shared/api/state-snapshot-read.ts';

export type BrowserStateReadDiagnosticEvent = Readonly<{
  name: 'rallar.browser.state-read';
  feature: 'client' | 'group';
  operation: 'point' | 'heartbeat' | 'collection';
  result: 'found' | 'not-found' | 'error' | 'removed' | 'preserved';
  source?: StateSnapshotReadSource;
  durationMs: number;
}>;

export type BrowserStateReadDiagnosticsSink = (
  event: BrowserStateReadDiagnosticEvent,
) => void;

// One process-wide sink keeps the public surface additive and opt-in.
let diagnosticsSink: BrowserStateReadDiagnosticsSink | undefined;

export function setBrowserStateReadDiagnosticsSink(
  sink: BrowserStateReadDiagnosticsSink | undefined,
): void {
  diagnosticsSink = sink;
}

export function emitBrowserStateReadDiagnostic(
  event: BrowserStateReadDiagnosticEvent,
): void {
  try {
    diagnosticsSink?.(event);
  } catch {
    // Diagnostics must never change state-read behavior.
  }
}
