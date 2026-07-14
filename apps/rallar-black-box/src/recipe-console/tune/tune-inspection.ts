export type TuneInspection =
    | Readonly<{
        kind: 'agent';
        agentId: string;
        channel: 'command' | 'stream';
    }>
    | Readonly<{ kind: 'hint'; hintId: string }>
    | Readonly<{ kind: 'knob'; pointer: string }>;

export function tuneInspectionLabel(selection: TuneInspection): string {
    if (selection.kind === 'agent') {
        return `Agent · ${selection.agentId}`;
    }
    if (selection.kind === 'hint') {
        return `Decision · ${selection.hintId}`;
    }
    return `Knob · ${selection.pointer}`;
}

export function tuneInspectionAuthority(source: TuneSourceModel): string {
    return JSON.stringify({
        focusRunId: source.focusRunId,
        distributedRunId: source.distributedRun?.distributedRunId,
        distributedControlRunId: source.distributedRun?.controlRunId,
        controlRunId: source.controlRun?.runId,
        quarantined: source.identity.quarantined,
    });
}
import type { TuneSourceModel } from './tune-source-model.ts';
