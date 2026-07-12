import type {
    ControlDistributedRunSnapshot,
} from '@shared-test/rallar-bb-test/control-snapshots.ts';
import type {
    RallarBlackBoxDistributedRunState,
} from '@shared-test/rallar-bb-test/distributed-run.ts';
import { StatusMark, type OperationalStatus } from '../ui/StatusMark.tsx';
import type { ExecuteConnectionTruth } from './execute-action-policy.ts';
import type { ExecuteOperationError } from './execute-operation-error.ts';
import styles from './ExecuteRunStatus.module.css';

export type ExecuteRunStatusProps = Readonly<{
    run?: ControlDistributedRunSnapshot;
    requestedDistributedRunId?: string;
    unknownDistributedRunId: boolean;
    mutationError?: ExecuteOperationError;
    connection: ExecuteConnectionTruth;
}>;

export function ExecuteRunStatus({
    run,
    requestedDistributedRunId,
    unknownDistributedRunId,
    mutationError,
    connection,
}: ExecuteRunStatusProps) {
    const state = run?.state;
    return (
        <section
            aria-labelledby="execute-run-status-heading"
            aria-live="polite"
            className={styles.runStatus}
            data-execute-run-status
            data-run-state={state ?? 'uncreated'}
        >
            <header className={styles.header}>
                <div>
                    <p className={styles.eyebrow}>Authoritative control truth</p>
                    <h2 id="execute-run-status-heading">Run status</h2>
                </div>
                <StatusMark
                    label={state ? stateLabel(state) : 'Not created'}
                    status={state ? stateTone(state) : 'disabled'}
                />
            </header>
            {unknownDistributedRunId ? (
                <p className={styles.error} role="alert">
                    Distributed run <code>{requestedDistributedRunId}</code> is not available in current control truth.
                </p>
            ) : null}
            {mutationError ? (
                <div className={styles.error} data-error-kind={mutationError.kind} role="alert">
                    <strong>{operationErrorLabel(mutationError)}</strong>
                    <span>{mutationError.message}</span>
                    <span>{operationErrorProvenance(mutationError)}</span>
                </div>
            ) : null}
            {run?.error ? (
                <div className={styles.error} role="alert">
                    <strong>{run.error.code}</strong>
                    <span>{run.error.message}</span>
                    {run.error.details === undefined ? null : (
                        <pre>{safeJson(run.error.details)}</pre>
                    )}
                </div>
            ) : null}
            {run ? (
                <>
                    <dl className={styles.facts}>
                        <Fact label="Distributed run" value={run.distributedRunId} machine />
                        <Fact label="Control run" value={run.controlRunId} machine />
                        <Fact label="Updated" value={formatEpoch(run.updatedAtEpochMs)} />
                        <Fact label="Targets" value={String(run.targetAgentIds.length)} />
                        <Fact
                            label="Ready participants"
                            value={`${run.rollup.summary.readyParticipants}/${run.rollup.summary.requiredParticipants}`}
                        />
                        <Fact
                            label="Blocking failures"
                            value={String(run.rollup.summary.blockingFailures)}
                        />
                    </dl>
                    <ol aria-label="Distributed run lifecycle" className={styles.lifecycle}>
                        {LIFECYCLE.map(step => (
                            <li
                                aria-current={step.states.includes(run.state) ? 'step' : undefined}
                                data-complete={lifecycleComplete(run, step.label)}
                                key={step.label}
                            >
                                <span aria-hidden="true" />
                                <strong>{step.label}</strong>
                            </li>
                        ))}
                    </ol>
                </>
            ) : (
                <p className={styles.empty}>
                    {connection === 'live'
                        ? 'Resolve targets and create a draft to begin the guided lifecycle.'
                        : `No run is available while control truth is ${connectionLabel(connection)}.`}
                </p>
            )}
        </section>
    );
}

const LIFECYCLE: readonly Readonly<{
    label: string;
    states: readonly RallarBlackBoxDistributedRunState[];
}>[] = [
    { label: 'Draft', states: ['draft', 'resolving-targets'] },
    { label: 'Staged', states: ['staging', 'waiting-for-ack', 'waiting-for-barrier'] },
    { label: 'Ready', states: ['ready'] },
    { label: 'Running', states: ['running'] },
    { label: 'Terminal', states: ['passed', 'failed', 'cancelled', 'timed-out'] },
];

function Fact({ label, value, machine = false }: Readonly<{
    label: string;
    value: string;
    machine?: boolean;
}>) {
    return <div><dt>{label}</dt><dd>{machine ? <code>{value}</code> : value}</dd></div>;
}

function stateLabel(state: RallarBlackBoxDistributedRunState): string {
    return state.split('-').map(part =>
        `${part.charAt(0).toUpperCase()}${part.slice(1)}`
    ).join(' ');
}

function stateTone(state: RallarBlackBoxDistributedRunState): OperationalStatus {
    if (state === 'passed') return 'passed';
    if (state === 'failed' || state === 'timed-out') return 'failed';
    if (state === 'running') return 'running';
    if (state === 'cancelled') return 'stale';
    if (state === 'ready') return 'passed';
    if (state === 'draft') return 'partial';
    return 'warning';
}

function lifecycleComplete(
    run: ControlDistributedRunSnapshot,
    step: string,
): boolean {
    if (step === 'Draft') {
        return run.state !== 'draft' && run.state !== 'resolving-targets';
    }
    if (step === 'Staged') {
        return run.stagedAtEpochMs !== undefined &&
            !['staging', 'waiting-for-ack', 'waiting-for-barrier'].includes(run.state);
    }
    if (step === 'Ready') {
        return run.startedAtEpochMs !== undefined;
    }
    if (step === 'Running') {
        return run.startedAtEpochMs !== undefined &&
            ['passed', 'failed', 'cancelled', 'timed-out'].includes(run.state);
    }
    return false;
}

function connectionLabel(connection: ExecuteConnectionTruth): string {
    return connection === 'auth-required'
        ? 'authorization required'
        : connection.replace('-', ' ');
}

function formatEpoch(epochMs: number): string {
    return new Date(epochMs).toLocaleString();
}

function safeJson(value: unknown): string {
    try {
        return JSON.stringify(value, null, 2);
    } catch {
        return 'Error details could not be serialized.';
    }
}

function operationErrorLabel(error: ExecuteOperationError): string {
    return error.kind.split('-').map(part =>
        `${part.charAt(0).toUpperCase()}${part.slice(1)}`
    ).join(' ');
}

function operationErrorProvenance(error: ExecuteOperationError): string {
    return [
        error.controlStatus === undefined
            ? undefined
            : `Control ${error.controlStatus} ${error.controlStatusText ?? ''}`.trim(),
        error.brokerStatus === undefined
            ? undefined
            : `Broker ${error.brokerStatus} ${error.brokerStatusText ?? ''}`.trim(),
        error.status === undefined
            ? undefined
            : `HTTP ${error.status} ${error.statusText ?? ''}`.trim(),
        error.credentialTrustRequired ? 'Credential trust required' : undefined,
        error.authorizationRequired ? 'Authorization required' : undefined,
    ].filter(Boolean).join(' · ');
}
