import type { DistributedRunTuningKnob } from
    '@shared-test/rallar-bb-test/distributed-run-tuning.ts';
import type { SearchableListboxOption } from
    '../ui/searchable-listbox-model.ts';
import type { TuneSourceModel } from './tune-source-model.ts';

export type TuneCandidateKnobWork = Readonly<{
    knobRowsVisited: number;
    editableOptionsProjected: number;
    blockedRowsProjected: number;
    uniquePointersIndexed: number;
    revisionRowsProjected: number;
    hintRowsVisited: number;
}>;

export type TuneBlockedKnobRow = Readonly<{
    key: string;
    knob: DistributedRunTuningKnob;
}>;

export type TuneCandidateKnobIndex = Readonly<{
    byPointer: ReadonlyMap<string, DistributedRunTuningKnob>;
    editableKnobs: readonly DistributedRunTuningKnob[];
    blockedKnobs: readonly TuneBlockedKnobRow[];
    options: readonly SearchableListboxOption[];
    preferredPointer?: string;
    revisionKey: string;
    work: TuneCandidateKnobWork;
}>;

export function createTuneCandidateKnobIndex(
    source: TuneSourceModel,
): TuneCandidateKnobIndex {
    const knobs = source.inventory?.knobs ?? [];
    const byPointer = new Map<string, DistributedRunTuningKnob>();
    const editableKnobs: DistributedRunTuningKnob[] = [];
    const editablePointers = new Set<string>();
    const blockedKnobs: TuneBlockedKnobRow[] = [];
    const blockedOccurrences = new Map<string, number>();
    const options: SearchableListboxOption[] = [];
    let revisionKey = 'tune-candidate-knob-index-v1:';
    let revisionRowsProjected = 0;
    let configuredRate: string | undefined;
    let configuredInterval: string | undefined;
    let configured: string | undefined;
    let effective: string | undefined;
    for (const knob of knobs) {
        const revisionRow = JSON.stringify([
            knob.pointer,
            knob.name,
            knob.scope,
            knob.currentValue,
            knob.availability,
            knob.effective,
            knob.commandId,
            knob.recipeId,
            knob.reason,
            knob.constraint,
        ]);
        revisionKey += `${revisionRow.length}:${revisionRow}`;
        revisionRowsProjected += 1;
        if (!byPointer.has(knob.pointer)) byPointer.set(knob.pointer, knob);
        if (knob.effective && effective === undefined) effective = knob.pointer;
        if (knob.effective && knob.availability === 'configured') {
            configured ??= knob.pointer;
            if (knob.name === 'rateHz') configuredRate ??= knob.pointer;
            if (knob.name === 'intervalMs') configuredInterval ??= knob.pointer;
        }
        if (!knob.effective || knob.availability === 'blocked') {
            const occurrence = blockedOccurrences.get(knob.pointer) ?? 0;
            blockedOccurrences.set(knob.pointer, occurrence + 1);
            blockedKnobs.push({
                key: JSON.stringify([knob.pointer, occurrence]),
                knob,
            });
            continue;
        }
        editableKnobs.push(knob);
        editablePointers.add(knob.pointer);
        options.push({
            key: knob.pointer,
            value: knob.pointer,
            label: `${knob.name} · ${knob.availability}`,
            exactIdentifier: knob.pointer,
            searchText: [
                knob.pointer,
                knob.name,
                knob.scope,
                knob.availability,
                knob.commandId ?? '',
                knob.recipeId,
            ].join(' '),
            detail: `${knob.scope} · recipe ${knob.recipeId}`,
        });
    }
    let hintRowsVisited = 0;
    let recommended: string | undefined;
    for (const hint of source.decisions?.hints ?? []) {
        hintRowsVisited += 1;
        if (hint.knob && editablePointers.has(hint.knob.pointer)) {
            recommended = hint.knob.pointer;
            break;
        }
    }
    return {
        byPointer,
        editableKnobs,
        blockedKnobs,
        options,
        preferredPointer: recommended ?? configuredRate ?? configuredInterval ??
            configured ?? effective,
        revisionKey,
        work: {
            knobRowsVisited: knobs.length,
            editableOptionsProjected: options.length,
            blockedRowsProjected: blockedKnobs.length,
            uniquePointersIndexed: byPointer.size,
            revisionRowsProjected,
            hintRowsVisited,
        },
    };
}
