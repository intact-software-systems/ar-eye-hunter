import type { RallarBlackBoxDistributedRunState } from
    '@shared-test/rallar-bb-test/distributed-run.ts';
import { useEffect, useRef, type Ref } from 'react';
import type {
    ExecuteAction,
    ExecuteActionPolicy,
    ExecuteConnectionTruth,
} from './execute-action-policy.ts';
import type { ExecuteNextAction } from './execute-next-action.ts';
import { ExecuteLifecycleStrip } from './ExecuteLifecycleStrip.tsx';
import styles from './ExecuteActionRunway.module.css';

type ActionHandler = () => void | Promise<void>;

export function ExecuteActionRunway({
    next,
    policy,
    busyAction,
    runState,
    connection,
    distributedRunId,
    recipeLabel,
    primaryButtonRef,
    refreshButtonRef,
    cancelButtonRef,
    onResolve,
    onCreate,
    onStage,
    onReviewStart,
    onMonitor,
    onCancel,
    onRefresh,
    onExport,
}: Readonly<{
    next: ExecuteNextAction;
    policy: ExecuteActionPolicy;
    busyAction?: ExecuteAction;
    runState?: RallarBlackBoxDistributedRunState;
    connection: ExecuteConnectionTruth;
    distributedRunId?: string;
    recipeLabel?: string;
    primaryButtonRef?: Ref<HTMLButtonElement>;
    refreshButtonRef?: React.Ref<HTMLButtonElement>;
    cancelButtonRef?: React.Ref<HTMLButtonElement>;
    onResolve: ActionHandler;
    onCreate: ActionHandler;
    onStage: ActionHandler;
    onReviewStart: ActionHandler;
    onMonitor: ActionHandler;
    onCancel: ActionHandler;
    onRefresh: ActionHandler;
    onExport: ActionHandler;
}>) {
    const primaryRef = useRef<HTMLButtonElement>(null);
    const advanceFocusRef = useRef(false);
    const previousStepRef = useRef(next.step);
    const handler = primaryHandler(next.step, {
        onResolve,
        onCreate,
        onStage,
        onReviewStart,
        onMonitor,
        onRefresh,
    });
    const showSecondaryRefresh = next.step !== 'refresh-control' &&
        next.step !== 'connect-agents';
    const showSecondaryActions = showSecondaryRefresh ||
        policy.export.enabled || policy.cancel.enabled || busyAction === 'cancel';
    useEffect(() => {
        if (
            previousStepRef.current !== next.step &&
            advanceFocusRef.current && primaryRef.current
        ) {
            primaryRef.current.focus();
        }
        if (previousStepRef.current !== next.step) {
            previousStepRef.current = next.step;
            advanceFocusRef.current = false;
        }
    }, [next.step]);

    return (
        <section
            aria-busy={busyAction !== undefined}
            aria-label="Execute next action"
            className={styles.runway}
            data-execute-action-runway
        >
            <ExecuteLifecycleStrip nextStep={next.step} runState={runState} />
            <div className={styles.current}>
                <div className={styles.summary}>
                    <p>Next</p>
                    <h2>{busyAction ? `${executeActionProgressLabel(busyAction)} in progress` : next.label}</h2>
                    <span>{[
                        distributedRunId,
                        recipeLabel,
                        `${next.targetCount} selected ${next.targetCount === 1 ? 'target' : 'targets'}`,
                        `${connection} control truth`,
                    ].filter(Boolean).join(' · ')}</span>
                </div>
                {handler ? (
                    <button
                        className={styles.primary}
                        disabled={!next.enabled || busyAction !== undefined}
                        onClick={() => {
                            advanceFocusRef.current = document.activeElement === primaryRef.current;
                            void handler();
                        }}
                        ref={node => {
                            primaryRef.current = node;
                            setExternalRef(primaryButtonRef, node);
                        }}
                        type="button"
                    >{next.label}</button>
                ) : (
                    <p aria-live="polite" className={styles.waiting} role="status">
                        <span className={styles.visuallyHidden}>{next.label}. </span>
                        {next.reason ?? next.label}
                    </p>
                )}
            </div>
            {showSecondaryActions ? (
                <div className={styles.secondary}>
                    {showSecondaryRefresh ? (
                        <button
                            disabled={!policy.refresh.enabled || busyAction !== undefined}
                            onClick={() => void onRefresh()}
                            ref={refreshButtonRef}
                            type="button"
                        >Refresh</button>
                    ) : null}
                    {policy.export.enabled ? (
                        <button
                            disabled={busyAction !== undefined}
                            onClick={() => void onExport()}
                            type="button"
                        >Export artifact</button>
                    ) : null}
                    {policy.cancel.enabled || busyAction === 'cancel' ? (
                        <button
                            className={styles.cancel}
                            disabled={!policy.cancel.enabled || busyAction !== undefined}
                            onClick={() => void onCancel()}
                            ref={cancelButtonRef}
                            type="button"
                        >Cancel run</button>
                    ) : null}
                </div>
            ) : null}
            {next.reason && handler ? (
                <details className={styles.reason}>
                    <summary>Why can’t I continue?</summary>
                    <p>{next.reason}</p>
                </details>
            ) : null}
        </section>
    );
}

function setExternalRef<T>(ref: Ref<T> | undefined, value: T | null): void {
    if (typeof ref === 'function') ref(value);
    else if (ref) ref.current = value;
}

function primaryHandler(
    step: ExecuteNextAction['step'],
    handlers: Readonly<{
        onResolve: ActionHandler;
        onCreate: ActionHandler;
        onStage: ActionHandler;
        onReviewStart: ActionHandler;
        onMonitor: ActionHandler;
        onRefresh: ActionHandler;
    }>,
): ActionHandler | undefined {
    switch (step) {
        case 'refresh-control': return handlers.onRefresh;
        case 'resolve': return handlers.onResolve;
        case 'create': return handlers.onCreate;
        case 'stage': return handlers.onStage;
        case 'review-start': return handlers.onReviewStart;
        case 'monitor': return handlers.onMonitor;
        case 'connect-agents':
        case 'registering':
        case 'waiting-for-ack': return undefined;
    }
}

function executeActionProgressLabel(action: ExecuteAction): string {
    return action === 'resolve' ? 'Resolve targets' :
        action === 'create' ? 'Create draft' :
        action === 'stage' ? 'Stage run' :
        action === 'start' ? 'Start run' :
        action === 'cancel' ? 'Cancel run' :
        action === 'export' ? 'Export artifact' : 'Refresh';
}
