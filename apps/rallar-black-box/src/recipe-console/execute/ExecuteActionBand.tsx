import type {
    RallarBlackBoxDistributedRunState,
} from '@shared-test/rallar-bb-test/distributed-run.ts';
import type { Ref } from 'react';
import type {
    ExecuteAction,
    ExecuteActionArmContext,
    ExecuteActionPolicy,
    ExecuteArmedAction,
    ExecuteConnectionTruth,
} from './execute-action-policy.ts';
import styles from './ExecuteActionBand.module.css';

type ActionHandler = () => void | Promise<void>;

export type ExecuteActionBandProps = Readonly<{
    policy: ExecuteActionPolicy;
    armContexts: Partial<Readonly<Record<ExecuteArmedAction, ExecuteActionArmContext>>>;
    armedKey?: string;
    busyAction?: ExecuteAction;
    runState?: RallarBlackBoxDistributedRunState;
    connection: ExecuteConnectionTruth;
    selectedTargetCount: number;
    refreshButtonRef?: Ref<HTMLButtonElement>;
    cancelButtonRef?: Ref<HTMLButtonElement>;
    onArm(action: ExecuteArmedAction): void;
    onResolve: ActionHandler;
    onCreate: ActionHandler;
    onStage: ActionHandler;
    onStart: ActionHandler;
    onCancel: ActionHandler;
    onRefresh: ActionHandler;
    onExport: ActionHandler;
}>;

const ACTION_LABELS: Readonly<Record<ExecuteAction, string>> = {
    resolve: 'Resolve targets',
    create: 'Create draft',
    stage: 'Stage run',
    start: 'Start run',
    cancel: 'Cancel run',
    refresh: 'Refresh',
    export: 'Export artifact',
};

const ARMED_ACTIONS: readonly ExecuteArmedAction[] = [
    'create',
    'stage',
    'start',
    'cancel',
];

export function ExecuteActionBand({
    policy,
    armContexts,
    armedKey,
    busyAction,
    runState,
    connection,
    selectedTargetCount,
    refreshButtonRef,
    cancelButtonRef,
    onArm,
    onResolve,
    onCreate,
    onStage,
    onStart,
    onCancel,
    onRefresh,
    onExport,
}: ExecuteActionBandProps) {
    const handlers: Readonly<Record<ExecuteAction, ActionHandler>> = {
        resolve: onResolve,
        create: onCreate,
        stage: onStage,
        start: onStart,
        cancel: onCancel,
        refresh: onRefresh,
        export: onExport,
    };
    const primary = primaryAction(runState, policy);
    const armingActions = ARMED_ACTIONS.filter(action => {
        const context = armContexts[action];
        return context !== undefined && (
            policy[action].code === 'arming-required' ||
            policy[action].enabled ||
            armedKey === context.key
        );
    });

    return (
        <section
            aria-busy={busyAction !== undefined}
            aria-label="Execute actions"
            className={styles.band}
            data-execute-action-band
        >
            <div className={styles.status}>
                <span className={styles.statusShape} data-connection={connection} />
                <span>
                    <strong>{statusTitle(runState, busyAction)}</strong>
                    <small>{selectedTargetCount} selected target{selectedTargetCount === 1 ? '' : 's'} · {connectionLabel(connection)}</small>
                </span>
            </div>
            {armingActions.length > 0 ? (
                <div aria-label="Live action arming" className={styles.arming}>
                    {armingActions.map(action => {
                        const context = armContexts[action];
                        if (!context) return null;
                        const armed = armedKey === context.key;
                        return (
                            <div className={styles.armRow} key={action}>
                                <p><strong>{armed ? 'Armed' : 'Review destination'}</strong><span>{context.label}</span></p>
                                <button
                                    aria-pressed={armed}
                                    className={styles.armButton}
                                    disabled={busyAction !== undefined}
                                    onClick={() => onArm(action)}
                                    type="button"
                                >{armed ? `${ACTION_LABELS[action]} armed` : `Arm ${ACTION_LABELS[action]}`}</button>
                            </div>
                        );
                    })}
                </div>
            ) : null}
            <div className={styles.actions}>
                {(['resolve', 'create', 'stage', 'start'] as const).map(action => (
                    <ActionButton
                        action={action}
                        handler={handlers[action]}
                        key={action}
                        policy={policy}
                        primary={primary === action}
                    />
                ))}
                <span className={styles.divider} />
                {(['refresh', 'export', 'cancel'] as const).map(action => (
                    <ActionButton
                        action={action}
                        destructive={action === 'cancel'}
                        handler={handlers[action]}
                        key={action}
                        policy={policy}
                        primary={primary === action}
                        buttonRef={action === 'refresh'
                            ? refreshButtonRef
                            : action === 'cancel'
                            ? cancelButtonRef
                            : undefined}
                    />
                ))}
            </div>
            <div className={styles.reasons} aria-label="Action requirements">
                {(Object.keys(ACTION_LABELS) as ExecuteAction[]).map(action => {
                    const decision = policy[action];
                    return decision.enabled ? null : (
                        <p id={`execute-${action}-reason`} key={action}>
                            <strong>{ACTION_LABELS[action]}:</strong> {decision.reason}
                        </p>
                    );
                })}
            </div>
        </section>
    );
}

function ActionButton({
    action,
    destructive = false,
    handler,
    policy,
    primary,
    buttonRef,
}: Readonly<{
    action: ExecuteAction;
    destructive?: boolean;
    handler: ActionHandler;
    policy: ExecuteActionPolicy;
    primary: boolean;
    buttonRef?: Ref<HTMLButtonElement>;
}>) {
    const decision = policy[action];
    return (
        <button
            aria-describedby={decision.enabled ? undefined : `execute-${action}-reason`}
            className={styles.action}
            data-destructive={destructive || undefined}
            data-primary-action={primary || undefined}
            disabled={!decision.enabled}
            onClick={() => void handler()}
            ref={buttonRef}
            type="button"
        >{ACTION_LABELS[action]}</button>
    );
}

function primaryAction(
    runState: RallarBlackBoxDistributedRunState | undefined,
    policy: ExecuteActionPolicy,
): ExecuteAction {
    if (!runState) {
        return policy.create.enabled || policy.create.code === 'arming-required'
            ? 'create'
            : 'resolve';
    }
    if (runState === 'draft') return 'stage';
    if (runState === 'ready') return 'start';
    if (runState === 'running') return 'cancel';
    return 'refresh';
}

function statusTitle(
    runState: RallarBlackBoxDistributedRunState | undefined,
    busyAction: ExecuteAction | undefined,
): string {
    if (busyAction) return `${executeBandActionLabel(busyAction)} in progress`;
    if (!runState) return 'Prepare a distributed run';
    return `Authoritative state · ${runState.replaceAll('-', ' ')}`;
}

function executeBandActionLabel(action: ExecuteAction): string {
    return ACTION_LABELS[action].toLowerCase();
}

function connectionLabel(connection: ExecuteConnectionTruth): string {
    return connection === 'auth-required'
        ? 'authorization required'
        : `${connection} control truth`;
}
