import type {
    RallarAiDiagnosticEvent,
    RallarAiDiagnosticEventKind,
    RallarAiDiagnosticsSink,
} from './rallar-ai-types.ts';

export class RallarAiDiagnosticsCollector {
    readonly events: RallarAiDiagnosticEvent[] = [];

    sink: RallarAiDiagnosticsSink = (event) => {
        this.events.push(event);
    };
}

export function createRallarAiDiagnosticEvent(
    kind: RallarAiDiagnosticEventKind,
    input: Omit<RallarAiDiagnosticEvent, 'kind' | 'createdAtEpochMs'> = {},
): RallarAiDiagnosticEvent {
    return {
        ...input,
        kind,
        createdAtEpochMs: Date.now(),
    };
}

export async function emitRallarAiDiagnostic(
    sink: RallarAiDiagnosticsSink | undefined,
    event: RallarAiDiagnosticEvent,
): Promise<void> {
    await sink?.(event);
}
