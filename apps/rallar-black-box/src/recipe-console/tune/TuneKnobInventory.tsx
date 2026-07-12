import type { DistributedRunTuningKnob } from
    '@shared-test/rallar-bb-test/distributed-run-tuning.ts';
import { tuneNumber } from './tune-format.ts';
import type { TuneInspection } from './tune-inspection.ts';
import styles from './TuneKnobInventory.module.css';

export function TuneKnobInventory({
    knobs,
    onInspect,
}: Readonly<{
    knobs: readonly DistributedRunTuningKnob[];
    onInspect(selection: TuneInspection, trigger: HTMLButtonElement): void;
}>) {
    const blocked = knobs.filter(knob =>
        !knob.effective || knob.availability === 'blocked'
    );
    if (blocked.length === 0) return null;
    return (
        <section className={styles.inventory} data-tune-blocked-knobs>
            <header>
                <h3>Non-editable knob evidence</h3>
                <p>Visible for inspection, excluded from candidate edits.</p>
            </header>
            <ul>
                {blocked.map(knob => (
                    <li data-tune-blocked-knob key={knob.pointer}>
                        <code>{knob.pointer}</code>
                        <strong>Current {tuneNumber(knob.currentValue)}</strong>
                        <span>{knob.reason ?? 'This knob is not effective.'}</span>
                        <button
                            onClick={event => onInspect(
                                { kind: 'knob', pointer: knob.pointer },
                                event.currentTarget,
                            )}
                            type="button"
                        >Inspect knob</button>
                    </li>
                ))}
            </ul>
        </section>
    );
}
