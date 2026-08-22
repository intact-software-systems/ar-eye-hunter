import {
    createDistributedRunTuningCandidate,
    type DistributedRunTuningCandidateResult
} from '@shared-test/rallar-bb-test/distributed-run-tuning-candidate.ts';
import { useMemo, useRef, useState } from 'react';
import { tuneCandidateFingerprint } from './tune-candidate-fingerprint.ts';
import { createTuneCandidateKnobIndex, type TuneCandidateKnobIndex } from './tune-candidate-knob-index.ts';
import { tuneNumber } from './tune-format.ts';
import type { TuneInspection } from './tune-inspection.ts';
import type { TuneSourceModel } from './tune-source-model.ts';
import styles from './TuneCandidate.module.css';
import { TuneKnobInventory } from './TuneKnobInventory.tsx';
import { TuneKnobPicker } from './TuneKnobPicker.tsx';

export { tuneCandidateFingerprint } from './tune-candidate-fingerprint.ts';

export function TuneCandidate({
    source,
    onInspect
}: Readonly<{
    source: TuneSourceModel;
    onInspect(selection: TuneInspection, trigger: HTMLButtonElement): void;
}>) {
    const indexBuildCount = useRef(0);
    const index = useMemo(() => {
        indexBuildCount.current += 1;
        return createTuneCandidateKnobIndex(source);
    }, [
        source.decisions,
        source.inventory?.knobs
    ]);
    const resetKey = useMemo(() =>
        tuneCandidateFingerprint(
            source,
            index.revisionKey
        ), [
        index.revisionKey,
        source.controlRun?.runId,
        source.distributedRun?.controlRunId,
        source.distributedRun?.distributedRunId,
        source.identity.controlRunId,
        source.identity.distributedRunId,
        source.identity.quarantined,
        source.provenance.detail,
        source.provenance.source,
        source.retained.relation,
        source.retained.support
    ]);
    return (
        <TuneCandidateState
            index={index}
            indexBuildCount={indexBuildCount.current}
            key={resetKey}
            onInspect={onInspect}
            source={source}
        />
    );
}

function TuneCandidateState({
    index,
    indexBuildCount,
    source,
    onInspect
}: Readonly<{
    index: TuneCandidateKnobIndex;
    indexBuildCount: number;
    source: TuneSourceModel;
    onInspect(selection: TuneInspection, trigger: HTMLButtonElement): void;
}>) {
    const initialPointer = index.preferredPointer;
    const initialKnob = initialPointer
        ? index.byPointer.get(initialPointer)
        : undefined;
    const [pointer, setPointer] = useState(initialPointer ?? '');
    const [draft, setDraft] = useState(
        initialKnob?.currentValue === undefined
            ? ''
            : String(initialKnob.currentValue)
    );
    const [preview, setPreview] = useState<DistributedRunTuningCandidateResult>();
    const [status, setStatus] = useState('No candidate preview yet.');
    const knob = index.byPointer.get(pointer);
    const enabled = Boolean(
        source.candidate.allowed && source.manifest && knob
    );

    function selectPointer(nextPointer: string): void {
        const next = index.byPointer.get(nextPointer);
        setPointer(nextPointer);
        setDraft(
            next?.currentValue === undefined
                ? ''
                : String(next.currentValue)
        );
        setPreview(undefined);
        setStatus('Candidate input changed; preview it deliberately.');
    }

    function createPreview(): void {
        if (!enabled || !source.manifest || !knob) {
            setStatus(
                source.candidate.reasons[0] ??
                    'Candidate output is unavailable.'
            );
            return;
        }
        const value = draft.trim() === '' ? Number.NaN : Number(draft);
        const next = createDistributedRunTuningCandidate({
            manifest: source.manifest,
            changes: [{
                pointer: knob.pointer,
                value,
                expectedValue: knob.currentValue ?? null
            }]
        });
        setPreview(next);
        setStatus(
            next.ok
                ? 'Candidate preview ready; source manifest unchanged.'
                : 'Candidate preview is invalid.'
        );
    }

    async function copyPatch(): Promise<void> {
        if (!preview?.ok) {
            return;
        }
        if (!navigator.clipboard?.writeText) {
            setStatus('Clipboard is unavailable; select the patch text manually.');
            return;
        }
        try {
            await navigator.clipboard.writeText(preview.patchJson);
            setStatus('Candidate patch copied');
        }
        catch {
            setStatus('Candidate patch was not copied.');
        }
    }

    return (
        <section
            className={styles.candidate}
            data-tune-candidate
            data-tune-editable-options={index.work.editableOptionsProjected}
            data-tune-blocked-options={index.work.blockedRowsProjected}
            data-tune-knob-index-builds={indexBuildCount}
            data-tune-knob-rows-visited={index.work.knobRowsVisited}
            data-tune-knob-revision-rows={index.work.revisionRowsProjected}
        >
            <header>
                <div>
                    <p>Clone-only output</p>
                    <h2>Knob candidate</h2>
                </div>
                <span>{source.identity.candidateFilename ?? 'No safe filename'}</span>
            </header>
            {index.editableKnobs.length > 0
                ? (
                    <div className={styles.editor}>
                        <TuneKnobPicker
                            contextKey={`tune-knobs-v1:${source.focusRunId ?? 'none'}`}
                            index={index}
                            onSelect={selectPointer}
                            selectedPointer={pointer || undefined}
                        />
                        <div className={styles.path}>
                            <code>{knob?.pointer ?? 'No editable path'}</code>
                            <strong>Current {tuneNumber(knob?.currentValue)}</strong>
                        </div>
                        <label>
                            <span>Candidate value</span>
                            <input
                                inputMode="decimal"
                                onChange={(event) => {
                                    setDraft(event.currentTarget.value);
                                    setPreview(undefined);
                                    setStatus('Candidate input changed; preview it deliberately.');
                                }}
                                step="any"
                                type="number"
                                value={draft}
                            />
                        </label>
                        <div className={styles.actions}>
                            <button disabled={!enabled} onClick={createPreview} type="button">
                                Preview candidate
                            </button>
                            {knob
                                ? (
                                    <button
                                        onClick={(event) =>
                                            onInspect(
                                                { kind: 'knob', pointer: knob.pointer },
                                                event.currentTarget
                                            )}
                                        type="button"
                                    >
                                        Inspect knob
                                    </button>
                                )
                                : null}
                        </div>
                    </div>
                )
                : <p className={styles.empty}>No effective inline tuning knob is available.</p>}
            <TuneKnobInventory index={index} onInspect={onInspect} />
            {!source.candidate.allowed
                ? (
                    <ul className={styles.errors}>
                        {source.candidate.reasons.map((reason) => <li key={reason}>{reason}</li>)}
                    </ul>
                )
                : null}
            {preview && !preview.ok
                ? (
                    <ul className={styles.errors}>
                        {preview.errors.map((error) => (
                            <li key={`${error.code}:${error.path ?? ''}`}>
                                {error.path ? `${error.path}: ` : ''}
                                {error.message}
                            </li>
                        ))}
                    </ul>
                )
                : null}
            {source.candidate.allowed && preview?.ok
                ? (
                    <div className={styles.output}>
                        <p>Source remains {tuneNumber(knob?.currentValue)}</p>
                        <pre data-candidate-patch>{preview.patchJson}</pre>
                        <details>
                            <summary>Readable diff</summary>
                            <pre>{preview.diffText}</pre>
                        </details>
                        <button onClick={() => void copyPatch()} type="button">
                            Copy JSON patch
                        </button>
                    </div>
                )
                : null}
            <p aria-live="polite" className={styles.status} role="status">
                {status}
            </p>
        </section>
    );
}
