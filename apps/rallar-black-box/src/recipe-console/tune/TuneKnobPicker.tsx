import { useMemo } from 'react';
import { SearchableWindowedListbox } from '../ui/SearchableWindowedListbox.tsx';
import type { TuneCandidateKnobIndex } from './tune-candidate-knob-index.ts';

export function TuneKnobPicker({
    contextKey,
    index,
    onSelect,
    selectedPointer
}: Readonly<{
    contextKey: string;
    index: TuneCandidateKnobIndex;
    onSelect(pointer: string): void;
    selectedPointer?: string;
}>) {
    const revision = useMemo(() => Object.freeze({}), [index.revisionKey]);
    return (
        <div data-tune-knob-picker>
            <SearchableWindowedListbox
                contextKey={contextKey}
                id="tune-knob"
                label="Exact knob path"
                onSelect={(option) => onSelect(option.value)}
                options={index.options}
                placeholder="Select an editable knob"
                revision={revision}
                selectedKey={selectedPointer}
            />
        </div>
    );
}
