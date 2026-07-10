import type { ReactNode } from 'react';
import { tuneMilliseconds, tuneNumber } from './tune-format.ts';
import type { TuneInspection } from './tune-inspection.ts';
import type { TuneSourceModel } from './tune-source-model.ts';
import styles from './TuneInspector.module.css';

export function TuneInspector({
    selection,
    source,
}: Readonly<{ selection: TuneInspection; source: TuneSourceModel }>) {
    return (
        <section className={styles.inspector} data-tune-inspector>
            <header>
                <p>Evidence inspector</p>
                <h2>{inspectorTitle(selection)}</h2>
                <code>{inspectorIdentity(selection)}</code>
            </header>
            {inspectorContent(selection, source)}
            {source.legacyRunsHref ? (
                <a className={styles.legacyLink} href={source.legacyRunsHref}>
                    Open this run in legacy Runs
                </a>
            ) : (
                <p className={styles.empty}>No safe legacy run handoff is available.</p>
            )}
        </section>
    );
}

function inspectorContent(
    selection: TuneInspection,
    source: TuneSourceModel,
): ReactNode {
    if (selection.kind === 'hint') {
        const hint = source.decisions?.hints.find(row =>
            row.id === selection.hintId
        );
        if (!hint) return <Missing kind="decision" />;
        return (
            <div className={styles.section}>
                <h3>{hint.title}</h3>
                <p>{hint.rationale}</p>
                <p>{hint.nextAction}</p>
                <Facts values={[
                    ['Category', hint.category],
                    ['Priority', String(hint.priority)],
                    ['Knob', hint.knob?.pointer ?? 'No exact knob'],
                    ['Evidence', hint.evidence.join(' · ')],
                ]} />
            </div>
        );
    }
    if (selection.kind === 'knob') {
        const knob = source.inventory?.knobs.find(row =>
            row.pointer === selection.pointer
        );
        if (!knob) return <Missing kind="knob" />;
        return (
            <div className={styles.section}>
                <h3>{knob.name}</h3>
                <Facts values={[
                    ['Path', knob.pointer],
                    ['Current', tuneNumber(knob.currentValue)],
                    ['Availability', knob.availability],
                    ['Effective', knob.effective ? 'Yes' : 'No'],
                    ['Recipe', knob.recipeId ?? 'Manifest scope'],
                    ['Command', knob.commandId ?? 'Manifest scope'],
                    ['Reason', knob.reason ?? 'Inventory-approved numeric knob'],
                ]} />
            </div>
        );
    }
    const command = source.performance?.slowestAgents.find(row =>
        row.agentId === selection.agentId
    );
    const stream = source.performance?.streamTiming?.slowestAgents.find(row =>
        row.agentId === selection.agentId
    );
    const row = selection.channel === 'stream' ? stream : command;
    if (!row) return <Missing kind="agent timing" />;
    return (
        <div className={styles.section}>
            <h3>{selection.agentId}</h3>
            <Facts values={selection.channel === 'stream' ? [
                ['Channel', 'RTC stream'],
                ['P95', tuneMilliseconds(stream?.p95Ms)],
                ['P99', tuneMilliseconds(stream?.p99Ms)],
                ['Max', tuneMilliseconds(stream?.maxMs)],
                ['Completed frames', String(stream?.completedFrames ?? 0)],
            ] : [
                ['Channel', 'Command'],
                ['Average', tuneMilliseconds(command?.averageMs)],
                ['Max', tuneMilliseconds(command?.maxMs)],
                ['Commands', String(command?.commandCount ?? 0)],
            ]} />
        </div>
    );
}

function Facts({ values }: Readonly<{
    values: readonly (readonly [string, string])[];
}>) {
    return (
        <dl className={styles.facts}>
            {values.map(([label, value]) => (
                <div key={label}><dt>{label}</dt><dd>{value}</dd></div>
            ))}
        </dl>
    );
}

function Missing({ kind }: Readonly<{ kind: string }>) {
    return <p className={styles.empty}>The selected {kind} is unavailable.</p>;
}

function inspectorTitle(selection: TuneInspection): string {
    if (selection.kind === 'agent') return 'Agent timing';
    if (selection.kind === 'hint') return 'Tuning decision';
    return 'Tuning knob';
}

function inspectorIdentity(selection: TuneInspection): string {
    if (selection.kind === 'agent') return selection.agentId;
    if (selection.kind === 'hint') return selection.hintId;
    return selection.pointer;
}
