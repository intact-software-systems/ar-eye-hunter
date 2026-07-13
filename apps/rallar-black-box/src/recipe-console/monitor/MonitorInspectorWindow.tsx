import { Fragment, type ReactNode } from 'react';
import type { DistributedRunFailureEvidenceDestination } from
    '@shared-test/rallar-bb-test/distributed-run-evidence.ts';
import type { RecipeConsoleUrlState } from '../routing/url-state-contract.ts';
import { ExactIdentifier } from '../ui/ExactIdentifier.tsx';
import { ExplicitWindowControls } from '../ui/ExplicitWindowControls.tsx';
import type { MonitorEvidenceSelection } from './monitor-selection.ts';
import type { MonitorWindowSection } from './monitor-window-contract.ts';
import { MonitorWindowTruth } from './MonitorWindowTruth.tsx';
import { useMonitorWindow } from './use-monitor-window.ts';

export type MonitorInspectorWindowProps<Item> = Readonly<{
    contentClassName: string;
    contentId: string;
    contextKey: string;
    itemKey(item: Item, absoluteIndex: number): string;
    itemLabel: string;
    items: readonly Item[];
    label: string;
    renderItem(item: Item, absoluteIndex: number): ReactNode;
    scope: Readonly<{ kind: string; id: string }>;
    section: MonitorWindowSection;
}>;

export function MonitorInspectorWindow<Item>({
    contentClassName,
    contentId,
    contextKey,
    itemKey,
    itemLabel,
    items,
    label,
    renderItem,
    scope,
    section,
}: MonitorInspectorWindowProps<Item>) {
    const window = useMonitorWindow({
        contextKey: JSON.stringify([
            'monitor-inspector', 1, contextKey, scope.kind, scope.id,
        ]),
        section,
        total: items.length,
    });
    if (items.length === 0) return null;
    const visibleItems = items.slice(
        window.model.startIndex,
        window.model.endIndexExclusive,
    );
    const exceedsBudget = items.length > window.model.windowSize;
    return <>
        {exceedsBudget ? (
            <div data-monitor-window-controls {...window.controlsFocusProps}>
                <ExplicitWindowControls
                    contentId={contentId}
                    itemLabel={itemLabel}
                    label={label}
                    model={window.model}
                    onNext={window.next}
                    onPrevious={window.previous}
                />
            </div>
        ) : null}
        <MonitorWindowTruth itemLabel={itemLabel} label={label} window={window} />
        <div
            className={contentClassName}
            data-monitor-inspector-window={section}
            id={contentId}
            {...window.contentFocusProps}
        >
            {visibleItems.map((item, offset) => {
                const absoluteIndex = window.model.startIndex + offset;
                return <Fragment key={itemKey(item, absoluteIndex)}>
                    {renderItem(item, absoluteIndex)}
                </Fragment>;
            })}
        </div>
    </>;
}

type SelectEvidence = (
    selection: MonitorEvidenceSelection,
    patch?: Partial<RecipeConsoleUrlState>,
) => void;

export function MonitorFailureDestinationsWindow({
    contentClassName,
    contextKey,
    destinations,
    onSelect,
    scopeId,
}: Readonly<{
    contentClassName: string;
    contextKey: string;
    destinations: readonly DistributedRunFailureEvidenceDestination[];
    onSelect: SelectEvidence;
    scopeId: string;
}>) {
    return <MonitorInspectorWindow
        contentClassName={contentClassName}
        contentId="monitor-inspector-failure-destinations"
        contextKey={contextKey}
        itemKey={(destination, index) =>
            `${destination.kind}:${destination.id}:${index}`}
        itemLabel="destinations"
        items={destinations}
        label="Failure destinations"
        renderItem={destination => <EvidenceDestination
            destination={destination}
            onSelect={onSelect}
        />}
        scope={{ kind: 'failure', id: scopeId }}
        section="failureDestinations"
    />;
}

export function MonitorEvidenceLinksWindow({
    contentClassName,
    contentId,
    contextKey,
    itemLabel,
    label,
    links,
    onSelect,
    scope,
    section,
}: Readonly<{
    contentClassName: string;
    contentId: string;
    contextKey: string;
    itemLabel: string;
    label: string;
    links: readonly MonitorEvidenceSelection[];
    onSelect: SelectEvidence;
    scope: Readonly<{ kind: string; id: string }>;
    section: Extract<MonitorWindowSection, 'commandEvidence' | 'diagnosticFailureLinks'>;
}>) {
    return <MonitorInspectorWindow
        contentClassName={contentClassName}
        contentId={contentId}
        contextKey={contextKey}
        itemKey={(link, index) => `${link.kind}:${link.id}:${index}`}
        itemLabel={itemLabel}
        items={links}
        label={label}
        renderItem={link => <EvidenceLink link={link} onSelect={onSelect} />}
        scope={scope}
        section={section}
    />;
}

function EvidenceDestination({ destination, onSelect }: Readonly<{
    destination: DistributedRunFailureEvidenceDestination;
    onSelect: SelectEvidence;
}>) {
    return <button
        data-evidence-destination={destination.kind}
        data-evidence-id={destination.id}
        onClick={() => onSelect(
            { kind: destination.kind, id: destination.id },
            {
                agentId: destination.agentId,
                recipeId: destination.recipeId,
                commandId: destination.commandId,
            },
        )}
        type="button"
    >
        <span>{labelKind(destination.kind)}</span>
        <strong>{destination.label}</strong>
        <ExactIdentifier value={destination.id} />
    </button>;
}

function EvidenceLink({ link, onSelect }: Readonly<{
    link: MonitorEvidenceSelection;
    onSelect: SelectEvidence;
}>) {
    return <button onClick={() => onSelect(link)} type="button">
        <span>{labelKind(link.kind)}</span><strong><ExactIdentifier value={link.id} /></strong>
    </button>;
}

function labelKind(kind: string): string {
    return `${kind[0]?.toUpperCase() ?? ''}${kind.slice(1)}`;
}
