import type { RallarBlackBoxDistributedRunState } from '@shared-test/rallar-bb-test/distributed-run.ts';
import type { Ref } from 'react';
import type { ControlOperationError } from '../control/control-operation-error.ts';
import type {
    MonitorAction,
    MonitorActionPolicy,
    MonitorCancelArmContext,
    MonitorConnectionTruth,
} from './monitor-action-policy.ts';
import styles from './MonitorActions.module.css';

type ActionHandler = () => void | Promise<void>;

const LABELS: Readonly<Record<MonitorAction, string>> = {
    refresh: 'Refresh',
    'load-artifact': 'Load artifact',
    'export-artifact': 'Export artifact',
    cancel: 'Cancel run',
};
const ACTION_ORDER: readonly MonitorAction[] = [
    'refresh',
    'cancel',
    'load-artifact',
    'export-artifact',
];

export function MonitorActionBand({
    policy,
    armContext,
    armed,
    busyAction,
    connection,
    runState,
    artifactStatus,
    error,
    refreshButtonRef,
    cancelButtonRef,
    onToggleCancelArm,
    onRefresh,
    onLoadArtifact,
    onExportArtifact,
    onCancel,
}: Readonly<{
    policy: MonitorActionPolicy;
    armContext?: MonitorCancelArmContext;
    armed: boolean;
    busyAction?: MonitorAction;
    connection: MonitorConnectionTruth;
    runState?: RallarBlackBoxDistributedRunState;
    artifactStatus: string;
    error?: ControlOperationError;
    refreshButtonRef?: Ref<HTMLButtonElement>;
    cancelButtonRef?: Ref<HTMLButtonElement>;
    onToggleCancelArm(): void;
    onRefresh: ActionHandler;
    onLoadArtifact: ActionHandler;
    onExportArtifact: ActionHandler;
    onCancel: ActionHandler;
}>) {
    const handlers: Readonly<Record<MonitorAction, ActionHandler>> = {
        refresh: onRefresh,
        'load-artifact': onLoadArtifact,
        'export-artifact': onExportArtifact,
        cancel: onCancel,
    };
    const canReviewCancel = armContext && (
        policy.cancel.enabled || policy.cancel.code === 'arming-required'
    );
    return (
        <section
            aria-busy={busyAction !== undefined}
            aria-label="Monitor actions"
            className={styles.band}
            data-monitor-section="actions"
        >
            <div className={styles.status}>
                <span className={styles.connection} data-connection={connection} />
                <span>
                    <strong>{busyAction ? `${LABELS[busyAction]} in progress` : `Authoritative state · ${runState ?? 'no run'}`}</strong>
                    <small>{connectionLabel(connection)} · artifact {artifactStatus}</small>
                </span>
            </div>
            {canReviewCancel ? (
                <div className={styles.armRow}>
                    <p><strong>{armed ? 'Cancel armed' : 'Review destination'}</strong><span>{armContext.label}</span></p>
                    <button
                        aria-pressed={armed}
                        disabled={busyAction !== undefined}
                        onClick={onToggleCancelArm}
                        type="button"
                    >{armed ? 'Cancel armed' : 'Arm Cancel'}</button>
                </div>
            ) : null}
            <div className={styles.actions}>
                {ACTION_ORDER.map(action => (
                    <ActionButton
                        action={action}
                        buttonRef={action === 'refresh'
                            ? refreshButtonRef
                            : action === 'cancel'
                            ? cancelButtonRef
                            : undefined}
                        handler={handlers[action]}
                        key={action}
                        policy={policy}
                    />
                ))}
            </div>
            <div aria-label="Action requirements" className={styles.reasons}>
                {ACTION_ORDER.map(action => {
                    const decision = policy[action];
                    return decision.enabled ? null : (
                        <p id={`monitor-${action}-reason`} key={action}>
                            <strong>{LABELS[action]}:</strong> {decision.reason}
                        </p>
                    );
                })}
            </div>
            {error && error.kind !== 'aborted' ? (
                <div aria-live="assertive" className={styles.error} data-operation-error={error.kind} role="alert">
                    <strong>{errorTitle(error)}</strong><span>{error.message}</span>
                    {error.status ? <code>HTTP {error.status}{error.statusText ? ` · ${error.statusText}` : ''}</code> : null}
                </div>
            ) : null}
        </section>
    );
}

function ActionButton({
    action,
    policy,
    handler,
    buttonRef,
}: Readonly<{
    action: MonitorAction;
    policy: MonitorActionPolicy;
    handler: ActionHandler;
    buttonRef?: Ref<HTMLButtonElement>;
}>) {
    const decision = policy[action];
    return (
        <button
            aria-describedby={decision.enabled ? undefined : `monitor-${action}-reason`}
            data-destructive={action === 'cancel' || undefined}
            data-monitor-action={action}
            data-primary-action={action === 'refresh' || undefined}
            disabled={!decision.enabled}
            onClick={() => void handler()}
            ref={buttonRef}
            type="button"
        >{LABELS[action]}</button>
    );
}

function connectionLabel(connection: MonitorConnectionTruth): string {
    if (connection === 'auth-required') return 'authorization required';
    if (connection === 'credential-trust') return 'credential trust required';
    if (connection === 'error') return 'control response error';
    return `${connection.replace('-', ' ')} control truth`;
}

function errorTitle(error: ControlOperationError): string {
    if (error.kind === 'credential-trust') return 'Trust the control endpoint before retrying';
    if (error.kind === 'authorization') return 'Control authorization required';
    if (error.kind === 'protocol') return 'Unexpected control response';
    if (error.kind === 'network') return 'Control endpoint unreachable';
    return 'Monitor action failed';
}
