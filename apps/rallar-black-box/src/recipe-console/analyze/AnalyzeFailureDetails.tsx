import type { DistributedArtifactEvidenceFailureDetails } from
    '@shared-test/rallar-bb-test/mod.ts';
import styles from './AnalyzeFailureDetails.module.css';

type AnalyzeFailureDetailsDensity = 'verdict' | 'row' | 'inspector';

export function AnalyzeFailureDetails({
    density,
    details,
    onInspect,
}: Readonly<{
    density: AnalyzeFailureDetailsDensity;
    details: DistributedArtifactEvidenceFailureDetails;
    onInspect?(trigger: HTMLButtonElement): void;
}>) {
    if (density === 'row') {
        return (
            <span
                className={styles.row}
                data-analyze-failure-details="row"
            >
                <FailureMarkers details={details} />
                {details.message ? (
                    <span className={styles.rowMessage}>{details.message}</span>
                ) : null}
            </span>
        );
    }

    const frame = density === 'verdict'
        ? firstRetainedStackFrame(details.stack)
        : undefined;
    return (
        <section
            className={density === 'verdict' ? styles.verdict : styles.inspector}
            data-analyze-failure-details={density}
        >
            <div className={styles.heading}>
                <div>
                    <p className={styles.eyebrow}>Result failure</p>
                    <FailureMarkers details={details} />
                </div>
                {density === 'verdict' && onInspect ? (
                    <button
                        onClick={event => onInspect(event.currentTarget)}
                        type="button"
                    >
                        Inspect result
                    </button>
                ) : null}
            </div>
            {details.message ? (
                <p className={styles.message}>{details.message}</p>
            ) : null}
            {frame ? <code className={styles.frame}>{frame}</code> : null}
            {density === 'inspector' && details.stack ? (
                <pre className={styles.stack}>{details.stack}</pre>
            ) : null}
        </section>
    );
}

function FailureMarkers({
    details,
}: Readonly<{ details: DistributedArtifactEvidenceFailureDetails }>) {
    if (!details.code && !details.name) return null;
    return (
        <span className={styles.markers}>
            {details.code ? (
                <code><span>Code</span>{details.code}</code>
            ) : null}
            {details.name ? (
                <code><span>Runtime</span>{details.name}</code>
            ) : null}
        </span>
    );
}

function firstRetainedStackFrame(stack: string | undefined): string | undefined {
    if (!stack) return undefined;
    const lines = stack.split(/\r?\n/u).map(line => line.trim()).filter(Boolean);
    return lines.find(line => /^at\b/u.test(line)) ?? lines[0];
}
