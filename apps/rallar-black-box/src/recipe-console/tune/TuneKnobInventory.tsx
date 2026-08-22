import { useMemo } from 'react';
import { ExactIdentifier } from '../ui/ExactIdentifier.tsx';
import { ExplicitWindowControls } from '../ui/ExplicitWindowControls.tsx';
import type { TuneCandidateKnobIndex } from './tune-candidate-knob-index.ts';
import { tuneNumber } from './tune-format.ts';
import type { TuneInspection } from './tune-inspection.ts';
import styles from './TuneKnobInventory.module.css';
import { useTuneBlockedKnobWindow } from './use-tune-window.ts';

export function TuneKnobInventory({
    index,
    onInspect
}: Readonly<{
    index: TuneCandidateKnobIndex;
    onInspect(selection: TuneInspection, trigger: HTMLButtonElement): void;
}>) {
    const revision = useMemo(() => Object.freeze({}), [index.revisionKey]);
    const blocked = index.blockedKnobs;
    const window = useTuneBlockedKnobWindow(revision, blocked.length);
    const visible = blocked.slice(
        window.model.startIndex,
        window.model.endIndexExclusive
    );
    if (blocked.length === 0) {
        return null;
    }
    const outside = blocked.length - visible.length;
    return (
        <section
            className={styles.inventory}
            data-tune-blocked-knobs
            data-tune-blocked-mounted-count={visible.length}
            data-tune-blocked-total={blocked.length}
            {...window.contentFocusProps}
        >
            <header>
                <h3>Non-editable knob evidence</h3>
                <p>Visible for inspection, excluded from candidate edits.</p>
            </header>
            {blocked.length > window.model.windowSize
                ? (
                    <ExplicitWindowControls
                        contentId="tune-blocked-knob-evidence"
                        itemLabel="blocked knobs"
                        label="Non-editable knob evidence"
                        model={window.model}
                        onNext={window.next}
                        onPrevious={window.previous}
                    />
                )
                : null}
            {outside > 0
                ? (
                    <p
                        className={styles.truth}
                        data-tune-blocked-knobs-outside
                    >
                        {outside.toLocaleString('en-US')} blocked knobs outside this window and browseable.
                    </p>
                )
                : null}
            <span
                className={styles.focusAnchor}
                data-tune-blocked-focus-anchor
                ref={window.focusFallbackRef}
                tabIndex={-1}
            >
                {`Showing ${window.model.displayStart.toLocaleString('en-US')}–${
                    window.model.displayEnd.toLocaleString('en-US')
                } of ${blocked.length.toLocaleString('en-US')} blocked knobs.`}
            </span>
            <ul id="tune-blocked-knob-evidence">
                {visible.map(({ key, knob }) => (
                    <li data-tune-blocked-knob key={key}>
                        <ExactIdentifier value={knob.pointer} />
                        <strong>Current {tuneNumber(knob.currentValue)}</strong>
                        <span>{knob.reason ?? 'This knob is not effective.'}</span>
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
                    </li>
                ))}
            </ul>
        </section>
    );
}
