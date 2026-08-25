import type { AuthSession } from '@shared/api/api-config.ts';
import { CollapsiblePanelSection } from '../../legacy/shared/CollapsiblePanelSection.tsx';
import { Metric } from '../../legacy/shared/Metric.tsx';
import { formatTime } from '../../legacy/shared/time-format.ts';
import type { CommandCenterGlobalValues } from '../../legacy/shell/global-context-model.ts';
import type { RallarBrowserStatusSummary } from '../../legacy/shell/rallar-browser-status.ts';
import type { QuickRallarTestViewModel } from './quick-rallar-contracts.ts';

interface QuickRallarTestStatusSectionProps {
    readonly authSession?: AuthSession;
    readonly globalValues: CommandCenterGlobalValues;
    readonly browserStatus: RallarBrowserStatusSummary;
    readonly model: QuickRallarTestViewModel;
}

export function QuickRallarTestStatusSection(
    { authSession, globalValues, browserStatus, model }: QuickRallarTestStatusSectionProps
) {
    return (
        <>
            <QuickRallarStatusHeading model={model} />
            <QuickRallarWorkflowStrip model={model} />
            <QuickRallarStatusInfo
                authSession={authSession}
                globalValues={globalValues}
                browserStatus={browserStatus}
                model={model}
            />
        </>
    );
}

function QuickRallarStatusInfo(
    { authSession, globalValues, browserStatus, model }: QuickRallarTestStatusSectionProps
) {
    return (
        <CollapsiblePanelSection title="Quick Test Info" meta={model.subscription ? 'listening' : model.waitStatus}>
            <div className="quick-rallar-summary-grid">
                <Metric
                    label="Provider"
                    value={model.providerMode}
                    tone={model.realBackendReady ? 'good' : 'warn'}
                />
                <Metric label="API" value={globalValues.apiBaseUrl} />
                <Metric
                    label="User"
                    value={authSession?.username ?? 'not logged in'}
                    tone={authSession ? 'good' : 'warn'}
                />
                <Metric
                    label="Session"
                    value={authSession?.sessionId ?? '-'}
                    tone={authSession ? 'good' : 'muted'}
                />
                <Metric
                    label="Group"
                    value={model.activeGroupId || '-'}
                    tone={model.activeGroupId ? 'good' : 'warn'}
                />
                <Metric label="Signal WS" value={browserStatus.signalingLabel} tone={browserStatus.signalingTone} />
                <Metric
                    label="Subscription"
                    value={model.subscription?.label ?? 'not listening'}
                    tone={model.subscription ? 'good' : 'muted'}
                />
                <Metric label="Received" value={String(model.receivedMessages.length)} />
                <Metric label="Wait" value={model.waitStatus} />
                <Metric label="Last action" value={model.lastResult?.status ?? '-'} />
            </div>
            <QuickRallarRouteSummary globalValues={globalValues} model={model} />
        </CollapsiblePanelSection>
    );
}

interface QuickRallarRouteSummaryProps {
    readonly globalValues: CommandCenterGlobalValues;
    readonly model: QuickRallarTestViewModel;
}

function QuickRallarRouteSummary({ globalValues, model }: QuickRallarRouteSummaryProps) {
    return (
        <div className="quick-rallar-route-grid" aria-label="Quick Test route">
            <div>
                <span>Destination</span>
                <strong>{model.activeGroupId ? `Group ${model.activeGroupId}` : 'No group selected'}</strong>
                <small>{globalValues.applicationId || '-'} / {globalValues.workspaceId || '-'}</small>
            </div>
            <div>
                <span>Selector</span>
                <strong>{model.selectorLabel}</strong>
                <small>Context {model.activeContextId}</small>
            </div>
            <div>
                <span>Receive</span>
                <strong>{model.subscription ? 'Subscribed' : 'Not subscribed'}</strong>
                <small>
                    {model.subscription
                        ? formatTime(model.subscription.subscribedAtEpochMs)
                        : 'Subscribe WS before receiving'}
                </small>
            </div>
        </div>
    );
}

interface QuickRallarStatusModelProps {
    readonly model: QuickRallarTestViewModel;
}

function QuickRallarStatusHeading({ model }: QuickRallarStatusModelProps) {
    return (
        <div className="panel-heading">
            <h2>Quick Test</h2>
            <span className={`pill ${model.subscription ? 'good' : model.realBackendReady ? 'muted' : 'warn'}`}>
                {model.subscription ? 'listening' : model.realBackendReady ? 'ready' : 'real backend required'}
            </span>
        </div>
    );
}

function QuickRallarWorkflowStrip({ model }: QuickRallarStatusModelProps) {
    return (
        <div className="quick-workflow-strip" aria-label="Quick Test workflow">
            {model.workflowSteps.map((step, index) => (
                <div className={`quick-workflow-step ${step.state}`} key={step.id}>
                    <span>{index + 1}</span>
                    <strong>{step.label}</strong>
                    <small>{step.detail}</small>
                </div>
            ))}
        </div>
    );
}
