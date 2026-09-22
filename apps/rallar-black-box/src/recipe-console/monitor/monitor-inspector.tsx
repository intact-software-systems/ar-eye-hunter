import type { DistributedRunProgressStatus } from '@shared-test/rallar-bb-test/distributed-run-observation/distributed-run-row-contracts.ts';
import type { ReactNode } from 'react';
import type { RecipeConsoleUrlState } from '../routing/url-state-contract.ts';
import { ExactIdentifier } from '../ui/ExactIdentifier.tsx';
import { StatusMark, type OperationalStatus } from '../ui/StatusMark.tsx';
import { MonitorRecipeEvidence } from './monitor-recipe-evidence.tsx';
import {
    computeMonitorRecipeEvidenceStatus,
    MONITOR_ARTIFACT_EVIDENCE_ID,
    toMonitorEvidenceSelectionLabel,
    type MonitorEvidenceSelection
} from './monitor-selection.ts';
import type { MonitorWorkspaceModel } from './monitor-workspace-model.ts';
import { MonitorFailureEvidence } from './MonitorFailureEvidence.tsx';
import styles from './MonitorInspector.module.css';
import { MonitorEvidenceLinksWindow } from './MonitorInspectorWindow.tsx';

export type MonitorInspectorProps = Readonly<{
    model: MonitorWorkspaceModel;
    /** Absent until the operator selects evidence; the run's default evidence is inspected instead. */
    selection?: MonitorEvidenceSelection;
    legacyHref: string;
    sourceSearch: string;
    urlState: RecipeConsoleUrlState;
    onSelectEvidence(selection: MonitorEvidenceSelection, patch?: Partial<RecipeConsoleUrlState>): void;
}>;

export function MonitorInspector({
    model,
    selection,
    legacyHref,
    sourceSearch,
    urlState,
    onSelectEvidence
}: MonitorInspectorProps) {
    const active = selection ?? resolveDefaultSelection(model);
    return (
        <section className={styles.inspector} data-monitor-inspector data-selection-kind={active.kind}>
            <header className={styles.header}>
                <p className={styles.eyebrow}>Evidence inspector</p>
                <h2>{`${toKindLabel(active.kind)} evidence`}</h2>
                <ExactIdentifier value={toMonitorEvidenceSelectionLabel(active)} />
                <StatusMark
                    label={toStatusLabel(model, active)}
                    status={resolveSelectionStatus(model, active)}
                />
            </header>
            <SelectedEvidence
                model={model}
                onSelectEvidence={onSelectEvidence}
                selection={active}
                sourceSearch={sourceSearch}
                urlState={urlState}
            />
            <a className={styles.legacyLink} href={legacyHref}>Open this run in legacy Runs</a>
        </section>
    );
}

function SelectedEvidence({
    model,
    selection,
    onSelectEvidence: onSelect,
    sourceSearch,
    urlState
}: Readonly<{
    model: MonitorWorkspaceModel;
    selection: MonitorEvidenceSelection;
    onSelectEvidence: MonitorInspectorProps['onSelectEvidence'];
    sourceSearch: string;
    urlState: RecipeConsoleUrlState;
}>): ReactNode {
    switch (selection.kind) {
        case 'failure':
            return (
                <MonitorFailureEvidence
                    failureKey={selection.id}
                    model={model}
                    onSelectEvidence={onSelect}
                    sourceSearch={sourceSearch}
                    urlState={urlState}
                />
            );
        case 'agent':
            return <AgentView agentId={selection.id} model={model} />;
        case 'recipe':
            return (
                <MonitorRecipeEvidence
                    model={model}
                    onSelectEvidence={onSelect}
                    selectionId={selection.id}
                />
            );
        case 'command':
            return <CommandView model={model} commandId={selection.id} onSelect={onSelect} />;
        case 'diagnostic':
            return <DiagnosticView model={model} eventId={selection.id} onSelect={onSelect} />;
        case 'timeline':
            return <TimelineView id={selection.id} model={model} />;
        case 'event':
            return <EventView id={selection.id} model={model} />;
        case 'artifact':
            return <ArtifactView model={model} />;
    }
}

function AgentView({ model, agentId }: Readonly<{
    model: MonitorWorkspaceModel;
    agentId: string;
}>) {
    const agent = model.monitor.agentProgress.find((row) => row.agentId === agentId);
    if (!agent) {
        return <MissingEvidence kind="agent" id={agentId} />;
    }
    const controlAgent = model.source.controlRun.agents.find((row) => row.agentId === agentId);
    return (
        <EvidenceSection title="Agent phase truth" description="Live phase and evidence totals for this agent.">
            <Facts
                values={[
                    ['Role', agent.role ?? 'Unassigned'],
                    ['Connection', controlAgent ? controlAgent.connected ? 'Connected' : 'Disconnected' : 'Unknown'],
                    ['Reconnects', String(controlAgent?.reconnectCount ?? 0)],
                    ['Readiness', agent.readiness],
                    ['Barrier', agent.barrier],
                    ['Execution', agent.execution],
                    ['Completed', String(agent.completedCommandCount)],
                    ['Failed', String(agent.failedCommandCount)],
                    ['Results', String(agent.resultCount)],
                    ['Events', String(agent.eventCount)],
                    ['Last activity', toEpochLabel(agent.lastActivityAtEpochMs)]
                ]}
            />
        </EvidenceSection>
    );
}

function CommandView({ model, commandId, onSelect }: Readonly<{
    model: MonitorWorkspaceModel;
    commandId: string;
    onSelect: MonitorInspectorProps['onSelectEvidence'];
}>) {
    const timelines = model.monitor.timeline.filter((row) => row.commandId === commandId);
    const diagnostics = model.monitor.runtimeDiagnostics.filter((row) => row.commandId === commandId);
    const events = model.monitor.events.filter((row) => row.commandId === commandId);
    const failures = model.monitor.failures.filter((row) => row.commandId === commandId);
    if (timelines.length + diagnostics.length + events.length + failures.length === 0) {
        return <MissingEvidence kind="command" id={commandId} />;
    }
    const links: MonitorEvidenceSelection[] = [
        ...failures.map((row) => ({ kind: 'failure' as const, id: row.key })),
        ...diagnostics.map((row) => ({ kind: 'diagnostic' as const, id: row.eventId })),
        ...timelines.map((row) => ({ kind: 'timeline' as const, id: row.id })),
        ...events.map((row) => ({ kind: 'event' as const, id: row.eventId }))
    ];
    return (
        <EvidenceSection
            title="Command evidence"
            description="Linked outcomes, diagnostics, timeline items, and events."
        >
            <Facts
                values={[
                    ['Failures', String(failures.length)],
                    ['Diagnostics', String(diagnostics.length)],
                    ['Timeline items', String(timelines.length)],
                    ['Events', String(events.length)]
                ]}
            />
            <MonitorEvidenceLinksWindow
                contentClassName={styles.destinations}
                contentId="monitor-inspector-command-evidence"
                contextKey={model.source.contextKey}
                itemLabel="linked items"
                label="Command evidence"
                links={links}
                onSelect={onSelect}
                scope={{ kind: 'command', id: commandId }}
                section="commandEvidence"
            />
        </EvidenceSection>
    );
}

function DiagnosticView({ model, eventId, onSelect }: Readonly<{
    model: MonitorWorkspaceModel;
    eventId: string;
    onSelect: MonitorInspectorProps['onSelectEvidence'];
}>) {
    const row = model.monitor.runtimeDiagnostics.find((item) => item.eventId === eventId);
    if (!row) {
        return <MissingEvidence kind="diagnostic" id={eventId} />;
    }
    return (
        <EvidenceSection title={row.summary || row.message} description={row.message}>
            <Facts
                values={[
                    ['Severity', row.severity],
                    ['Transport', row.transport ?? 'Runtime'],
                    ['Agent', row.agentId],
                    ['Command', row.commandId ?? 'No command link'],
                    ['Type', row.diagnosticTypeId],
                    ['Topic', row.topic],
                    ['Observed', toEpochLabel(row.atEpochMs)],
                    ['Payload', row.payloadSummary]
                ]}
            />
            <MonitorEvidenceLinksWindow
                contentClassName={styles.destinations}
                contentId="monitor-inspector-diagnostic-failure-links"
                contextKey={model.source.contextKey}
                itemLabel="failure links"
                label="Diagnostic failure links"
                links={row.correlatedFailureKeys.map((id) => ({ kind: 'failure' as const, id }))}
                onSelect={onSelect}
                scope={{ kind: 'diagnostic', id: eventId }}
                section="diagnosticFailureLinks"
            />
        </EvidenceSection>
    );
}

function TimelineView({ model, id }: Readonly<{ model: MonitorWorkspaceModel; id: string; }>) {
    const row = model.monitor.timeline.find((item) => item.id === id);
    if (!row) {
        return <MissingEvidence kind="timeline item" id={id} />;
    }
    return (
        <EvidenceSection title={row.label} description={row.detail ?? 'No additional detail recorded.'}>
            <Facts
                values={[
                    ['Kind', row.kind],
                    ['Phase', row.phase ?? 'Not phase-scoped'],
                    ['Agent', row.agentId ?? 'Run scope'],
                    ['Recipe', row.recipeId ?? 'Run scope'],
                    ['Command', row.commandId ?? 'No command link'],
                    ['Observed', toEpochLabel(row.atEpochMs)]
                ]}
            />
        </EvidenceSection>
    );
}

function EventView({ model, id }: Readonly<{ model: MonitorWorkspaceModel; id: string; }>) {
    const row = model.monitor.events.find((item) => item.eventId === id);
    if (!row) {
        return <MissingEvidence kind="event" id={id} />;
    }
    return (
        <EvidenceSection title={row.summary} description={row.payloadSummary}>
            <Facts
                values={[
                    ['Kind', row.kind],
                    ['Topic', row.topic ?? 'No topic'],
                    ['Agent', row.agentId],
                    ['Command', row.commandId ?? 'No command link'],
                    ['Observed', toEpochLabel(row.atEpochMs)]
                ]}
            />
        </EvidenceSection>
    );
}

function ArtifactView({ model }: Readonly<{ model: MonitorWorkspaceModel; }>) {
    const artifact = model.monitor.artifact;
    return (
        <EvidenceSection title="Distributed artifact" description={artifact.message}>
            <Facts
                values={[
                    ['Status', artifact.status],
                    ['Files', String(artifact.fileCount)],
                    ['Authority', model.source.freshness === 'current' ? 'Current snapshot' : 'Last-known snapshot']
                ]}
            />
        </EvidenceSection>
    );
}

function EvidenceSection({ title, description, children }: Readonly<{
    title: string;
    description: string;
    children: ReactNode;
}>) {
    return (
        <section className={styles.section}>
            <h3>{title}</h3>
            <p>{description}</p>
            {children}
        </section>
    );
}

function Facts({ values }: Readonly<{ values: readonly (readonly [string, string])[]; }>) {
    return (
        <dl className={styles.facts}>
            {values.map(([label, value]) => <Fact key={label} label={label} value={value} />)}
        </dl>
    );
}

function Fact({ label, value }: Readonly<{ label: string; value: string; }>) {
    return (
        <div>
            <dt>{label}</dt>
            <dd>{value}</dd>
        </div>
    );
}

function MissingEvidence({ kind, id }: Readonly<{ kind: string; id: string; }>) {
    return (
        <p className={styles.empty}>
            The selected {kind} <code>{id}</code> is not in this snapshot.
        </p>
    );
}

function resolveDefaultSelection(model: MonitorWorkspaceModel): MonitorEvidenceSelection {
    const failure = model.monitor.failures[0];
    if (failure) {
        return { kind: 'failure', id: failure.key };
    }
    const agent = model.monitor.agentProgress[0];
    if (agent) {
        return { kind: 'agent', id: agent.agentId };
    }
    const recipe = model.monitor.recipeProgress[0];
    if (recipe) {
        return { kind: 'recipe', id: recipe.recipeId };
    }
    return { kind: 'artifact', id: MONITOR_ARTIFACT_EVIDENCE_ID };
}

function resolveSelectionStatus(
    model: MonitorWorkspaceModel,
    selection: MonitorEvidenceSelection
): OperationalStatus {
    if (selection.kind === 'failure') {
        return 'failed';
    }
    if (selection.kind === 'diagnostic') {
        const severity = model.monitor.runtimeDiagnostics.find((row) => row.eventId === selection.id)?.severity;
        return severity === 'error' ? 'failed' : severity === 'warning' ? 'warning' : 'partial';
    }
    if (selection.kind === 'agent') {
        return toOperationalStatus(model.monitor.agentProgress.find((row) => row.agentId === selection.id)?.execution);
    }
    if (selection.kind === 'recipe') {
        return computeMonitorRecipeEvidenceStatus(
            model.monitor.recipeProgress,
            selection.id
        );
    }
    if (selection.kind === 'artifact') {
        return model.monitor.artifact.status === 'valid' ? 'passed' : 'warning';
    }
    return 'partial';
}

function toOperationalStatus(status?: DistributedRunProgressStatus): OperationalStatus {
    if (status === 'passed' || status === 'ready') {
        return 'passed';
    }
    if (status === 'failed') {
        return 'failed';
    }
    if (status === 'running') {
        return 'running';
    }
    if (status === 'cancelled' || status === 'missing') {
        return 'disabled';
    }
    return 'partial';
}

function toStatusLabel(
    model: MonitorWorkspaceModel,
    selection: MonitorEvidenceSelection
): string {
    if (selection.kind === 'artifact') {
        return model.monitor.artifact.status;
    }
    return `${toKindLabel(selection.kind)} selected`;
}

function toKindLabel(kind: string): string {
    return `${kind[0]?.toUpperCase() ?? ''}${kind.slice(1)}`;
}

function toEpochLabel(epochMs?: number): string {
    return epochMs === undefined ? 'Not recorded' : new Date(epochMs).toLocaleString();
}
