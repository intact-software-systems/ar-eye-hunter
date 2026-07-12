import type { ReactNode } from 'react';
import type { DistributedRunFailureEvidenceDestination } from '@shared-test/rallar-bb-test/distributed-run-evidence.ts';
import type { DistributedRunProgressStatus } from '@shared-test/rallar-bb-test/distributed-run-monitor.ts';
import { deriveDistributedRunFailureEvidenceDestinations } from '../../distributed-recipes.ts';
import type { RecipeConsoleUrlState } from '../routing/url-state-contract.ts';
import { StatusMark, type OperationalStatus } from '../ui/StatusMark.tsx';
import {
    MONITOR_ARTIFACT_EVIDENCE_ID,
    deriveMonitorRecipeEvidenceStatus,
    monitorEvidenceSelectionIdentifier,
    type MonitorEvidenceSelection,
} from './monitor-selection.ts';
import { MonitorRecipeEvidence } from './MonitorRecipeEvidence.tsx';
import type { MonitorWorkspaceModel } from './monitor-workspace-model.ts';
import styles from './MonitorInspector.module.css';

export type MonitorInspectorProps = Readonly<{
    model: MonitorWorkspaceModel;
    selection?: MonitorEvidenceSelection;
    legacyHref: string;
    onSelectEvidence(selection: MonitorEvidenceSelection, patch?: Partial<RecipeConsoleUrlState>): void;
}>;

export function MonitorInspector({ model, selection, legacyHref, onSelectEvidence }: MonitorInspectorProps) {
    const active = selection ?? defaultSelection(model);
    const heading = active ? `${labelKind(active.kind)} evidence` : 'Run evidence';
    return (
        <section className={styles.inspector} data-monitor-inspector data-selection-kind={active?.kind ?? 'run'}>
            <header className={styles.header}>
                <p className={styles.eyebrow}>Evidence inspector</p>
                <h2>{heading}</h2>
                <code>{monitorEvidenceSelectionIdentifier(active) ?? model.monitor.distributedRunId}</code>
                <StatusMark label={statusLabel(model, active)} status={selectionStatus(model, active)} />
            </header>
            {active ? selectedEvidence(model, active, onSelectEvidence) : (
                <p className={styles.empty}>No inspectable evidence is available yet.</p>
            )}
            <a className={styles.legacyLink} href={legacyHref}>Open this run in legacy Runs</a>
        </section>
    );
}

function selectedEvidence(model: MonitorWorkspaceModel, selection: MonitorEvidenceSelection,
    onSelect: MonitorInspectorProps['onSelectEvidence']): ReactNode {
    switch (selection.kind) {
        case 'failure': return failureView(model, selection.id, onSelect);
        case 'agent': return agentView(model, selection.id);
        case 'recipe': return <MonitorRecipeEvidence
            model={model}
            onSelectEvidence={onSelect}
            selectionId={selection.id}
        />;
        case 'command': return commandView(model, selection.id, onSelect);
        case 'diagnostic': return diagnosticView(model, selection.id, onSelect);
        case 'timeline': return timelineView(model, selection.id);
        case 'event': return eventView(model, selection.id);
        case 'artifact': return artifactView(model);
    }
}

function failureView(model: MonitorWorkspaceModel, failureKey: string,
    onSelect: MonitorInspectorProps['onSelectEvidence']): ReactNode {
    const failure = model.monitor.failures.find(row => row.key === failureKey);
    if (!failure) return <MissingEvidence kind="failure" id={failureKey} />;
    const explanation = model.report.nextActions.find(action => action.evidence.includes(failure.key));
    const destinations = deriveDistributedRunFailureEvidenceDestinations({ failure, monitor: model.monitor });
    return <>
        <section className={styles.callout} data-minimal-fix>
            <h3>{explanation?.title ?? 'Selected distributed failure'}</h3>
            <p>{failure.message}</p>
            <Facts values={[
                ['Agent', failure.agentId ?? 'Run scope'], ['Recipe', failure.recipeId ?? 'Run rollup'],
                ['Command', failure.commandId ?? 'No command link'], ['Code', failure.code ?? 'No error code'],
                ['Observed', formatEpoch(failure.atEpochMs)],
            ]} />
        </section>
        <section className={styles.section}>
            <h3>Likely cause</h3>
            <p>{explanation?.likelyCause ?? failure.message}</p>
        </section>
        <section className={styles.section}>
            <h3>Next action</h3>
            <p>{explanation?.nextAction ?? fallbackFailureAction(failure)}</p>
        </section>
        <section className={styles.section}>
            <h3>Correlated destinations <span>{destinations.length}</span></h3>
            {destinations.length > 0 ? (
                <div className={styles.destinations}>
                    {destinations.map(destination => <EvidenceDestination
                        destination={destination}
                        key={`${destination.kind}:${destination.id}`}
                        onSelect={onSelect}
                    />)}
                </div>
            ) : <p className={styles.empty}>No directly correlated destination is available.</p>}
        </section>
    </>;
}

function agentView(model: MonitorWorkspaceModel, agentId: string): ReactNode {
    const agent = model.monitor.agentProgress.find(row => row.agentId === agentId);
    if (!agent) return <MissingEvidence kind="agent" id={agentId} />;
    const controlAgent = model.source.controlRun.agents.find(row => row.agentId === agentId);
    return <EvidenceSection title="Agent phase truth" description="Live phase and evidence totals for this agent.">
        <Facts values={[
            ['Role', agent.role ?? 'Unassigned'],
            ['Connection', controlAgent ? controlAgent.connected ? 'Connected' : 'Disconnected' : 'Unknown'],
            ['Reconnects', String(controlAgent?.reconnectCount ?? 0)],
            ['Readiness', agent.readiness], ['Barrier', agent.barrier],
            ['Execution', agent.execution], ['Completed', String(agent.completedCommandCount)],
            ['Failed', String(agent.failedCommandCount)], ['Results', String(agent.resultCount)],
            ['Events', String(agent.eventCount)], ['Last activity', formatEpoch(agent.lastActivityAtEpochMs)],
        ]} />
    </EvidenceSection>;
}

function commandView(model: MonitorWorkspaceModel, commandId: string,
    onSelect: MonitorInspectorProps['onSelectEvidence']): ReactNode {
    const timelines = model.monitor.timeline.filter(row => row.commandId === commandId);
    const diagnostics = model.monitor.runtimeDiagnostics.filter(row => row.commandId === commandId);
    const events = model.monitor.events.filter(row => row.commandId === commandId);
    const failures = model.monitor.failures.filter(row => row.commandId === commandId);
    if (timelines.length + diagnostics.length + events.length + failures.length === 0) {
        return <MissingEvidence kind="command" id={commandId} />;
    }
    const links: MonitorEvidenceSelection[] = [
        ...failures.map(row => ({ kind: 'failure' as const, id: row.key })),
        ...diagnostics.map(row => ({ kind: 'diagnostic' as const, id: row.eventId })),
        ...timelines.map(row => ({ kind: 'timeline' as const, id: row.id })),
        ...events.map(row => ({ kind: 'event' as const, id: row.eventId })),
    ].slice(0, 16);
    return <EvidenceSection title="Command evidence" description="Linked outcomes, diagnostics, timeline items, and events.">
        <Facts values={[
            ['Failures', String(failures.length)], ['Diagnostics', String(diagnostics.length)],
            ['Timeline items', String(timelines.length)], ['Events', String(events.length)],
        ]} />
        <EvidenceLinks links={links} onSelect={onSelect} />
    </EvidenceSection>;
}

function diagnosticView(model: MonitorWorkspaceModel, eventId: string,
    onSelect: MonitorInspectorProps['onSelectEvidence']): ReactNode {
    const row = model.monitor.runtimeDiagnostics.find(item => item.eventId === eventId);
    if (!row) return <MissingEvidence kind="diagnostic" id={eventId} />;
    return <EvidenceSection title={row.summary || row.message} description={row.message}>
        <Facts values={[
            ['Severity', row.severity], ['Transport', row.transport ?? 'Runtime'],
            ['Agent', row.agentId], ['Command', row.commandId ?? 'No command link'],
            ['Type', row.diagnosticTypeId], ['Topic', row.topic],
            ['Observed', formatEpoch(row.atEpochMs)], ['Payload', row.payloadSummary],
        ]} />
        <EvidenceLinks links={row.correlatedFailureKeys.map(id => ({ kind: 'failure', id }))} onSelect={onSelect} />
    </EvidenceSection>;
}

function timelineView(model: MonitorWorkspaceModel, id: string): ReactNode {
    const row = model.monitor.timeline.find(item => item.id === id);
    if (!row) return <MissingEvidence kind="timeline item" id={id} />;
    return <EvidenceSection title={row.label} description={row.detail ?? 'No additional detail recorded.'}>
        <Facts values={[
            ['Kind', row.kind], ['Phase', row.phase ?? 'Not phase-scoped'],
            ['Agent', row.agentId ?? 'Run scope'], ['Recipe', row.recipeId ?? 'Run scope'],
            ['Command', row.commandId ?? 'No command link'], ['Observed', formatEpoch(row.atEpochMs)],
        ]} />
    </EvidenceSection>;
}

function eventView(model: MonitorWorkspaceModel, id: string): ReactNode {
    const row = model.monitor.events.find(item => item.eventId === id);
    if (!row) return <MissingEvidence kind="event" id={id} />;
    return <EvidenceSection title={row.summary} description={row.payloadSummary}>
        <Facts values={[
            ['Kind', row.kind], ['Topic', row.topic ?? 'No topic'],
            ['Agent', row.agentId], ['Command', row.commandId ?? 'No command link'],
            ['Observed', formatEpoch(row.atEpochMs)],
        ]} />
    </EvidenceSection>;
}

function artifactView(model: MonitorWorkspaceModel): ReactNode {
    const artifact = model.monitor.artifact;
    return <EvidenceSection title="Distributed artifact" description={artifact.message}>
        <Facts values={[
            ['Status', artifact.status], ['Files', String(artifact.fileCount)],
            ['Authority', model.source.freshness === 'current' ? 'Current snapshot' : 'Last-known snapshot'],
        ]} />
    </EvidenceSection>;
}

function EvidenceDestination({ destination, onSelect }: Readonly<{ destination: DistributedRunFailureEvidenceDestination;
    onSelect: MonitorInspectorProps['onSelectEvidence'] }>) {
    return <button
        data-evidence-destination={destination.kind}
        data-evidence-id={destination.id}
        onClick={() => onSelect(
            { kind: destination.kind, id: destination.id }, destinationPatch(destination),
        )}
        type="button"
    >
        <span>{labelKind(destination.kind)}</span>
        <strong>{destination.label}</strong>
    </button>;
}

function EvidenceLinks({ links, onSelect }: Readonly<{ links: readonly MonitorEvidenceSelection[];
    onSelect: MonitorInspectorProps['onSelectEvidence'] }>) {
    if (links.length === 0) return null;
    return <div className={styles.destinations}>{links.map(link => (
        <button key={`${link.kind}:${link.id}`} onClick={() => onSelect(link)} type="button">
            <span>{labelKind(link.kind)}</span><strong>{link.id}</strong>
        </button>
    ))}</div>;
}

function EvidenceSection({ title, description, children }: Readonly<{
    title: string; description: string; children: ReactNode;
}>) {
    return <section className={styles.section}><h3>{title}</h3><p>{description}</p>{children}</section>;
}

function Facts({ values }: Readonly<{ values: readonly (readonly [string, string])[] }>) {
    return <dl className={styles.facts}>{values.map(([label, value]) => (
        <Fact key={label} label={label} value={value} />
    ))}</dl>;
}

function Fact({ label, value }: Readonly<{ label: string; value: string }>) {
    return <div><dt>{label}</dt><dd>{value}</dd></div>;
}

function MissingEvidence({ kind, id }: Readonly<{ kind: string; id: string }>) {
    return <p className={styles.empty}>The selected {kind} <code>{id}</code> is not in this snapshot.</p>;
}

function defaultSelection(model: MonitorWorkspaceModel): MonitorEvidenceSelection | undefined {
    const failure = model.monitor.failures[0];
    if (failure) return { kind: 'failure', id: failure.key };
    const agent = model.monitor.agentProgress[0];
    if (agent) return { kind: 'agent', id: agent.agentId };
    const recipe = model.monitor.recipeProgress[0];
    if (recipe) return { kind: 'recipe', id: recipe.recipeId };
    return { kind: 'artifact', id: MONITOR_ARTIFACT_EVIDENCE_ID };
}

function destinationPatch(destination: DistributedRunFailureEvidenceDestination): Partial<RecipeConsoleUrlState> {
    return { agentId: destination.agentId, recipeId: destination.recipeId, commandId: destination.commandId };
}

function selectionStatus(model: MonitorWorkspaceModel,
    selection?: MonitorEvidenceSelection): OperationalStatus {
    if (!selection) return 'disabled';
    if (selection.kind === 'failure') return 'failed';
    if (selection.kind === 'diagnostic') {
        const severity = model.monitor.runtimeDiagnostics.find(row => row.eventId === selection.id)?.severity;
        return severity === 'error' ? 'failed' : severity === 'warning' ? 'warning' : 'partial';
    }
    if (selection.kind === 'agent') {
        return progressStatus(model.monitor.agentProgress.find(row => row.agentId === selection.id)?.execution);
    }
    if (selection.kind === 'recipe') {
        return deriveMonitorRecipeEvidenceStatus(
            model.monitor.recipeProgress,
            selection.id,
        );
    }
    if (selection.kind === 'artifact') return model.monitor.artifact.status === 'valid' ? 'passed' : 'warning';
    return 'partial';
}

function progressStatus(status?: DistributedRunProgressStatus): OperationalStatus {
    if (status === 'passed' || status === 'ready') return 'passed';
    if (status === 'failed') return 'failed';
    if (status === 'running') return 'running';
    if (status === 'cancelled' || status === 'missing') return 'disabled';
    return 'partial';
}

function statusLabel(model: MonitorWorkspaceModel, selection?: MonitorEvidenceSelection): string {
    if (!selection) return 'No evidence';
    if (selection.kind === 'artifact') return model.monitor.artifact.status;
    return `${labelKind(selection.kind)} selected`;
}

function fallbackFailureAction(failure: MonitorWorkspaceModel['monitor']['failures'][number]): string {
    const scope = failure.commandId ?? failure.recipeId ?? failure.agentId ?? failure.key;
    return `Inspect the correlated destinations for ${scope}, then compare the failing evidence with sibling agents.`;
}

function labelKind(kind: string): string {
    return `${kind[0]?.toUpperCase() ?? ''}${kind.slice(1)}`;
}

function formatEpoch(epochMs?: number): string {
    return epochMs === undefined ? 'Not recorded' : new Date(epochMs).toLocaleString();
}
