import type { ControlDistributedRunSnapshot } from '@shared-test/rallar-bb-test/control-snapshots.ts';
import type {
    DistributedRecipeCatalogEntryProjection
} from '@shared-test/rallar-bb-test/distributed-recipe-catalog.ts';
import { StatusMark } from '../ui/StatusMark.tsx';
import type { ExecuteManifestDraft } from './execute-manifest.ts';
import { ExecuteInspectorPrerequisites } from './ExecuteInspectorPrerequisites.tsx';
import { ExecuteInspectorSequence } from './ExecuteInspectorSequence.tsx';
import styles from './ExecuteRecipeInspector.module.css';

export type ExecuteRecipeInspectorProps = Readonly<{
    entry?: DistributedRecipeCatalogEntryProjection;
    manifest?: ExecuteManifestDraft;
    run?: ControlDistributedRunSnapshot;
    selectedTargetCount: number;
}>;

export function ExecuteRecipeInspector({
    entry,
    manifest,
    run,
    selectedTargetCount
}: ExecuteRecipeInspectorProps) {
    if (!entry) {
        return (
            <section className={styles.inspector} data-execute-recipe-inspector>
                <h2>Recipe details</h2>
                <p className={styles.empty}>Select an available repository recipe.</p>
            </section>
        );
    }

    const recipe = entry.item.recipe;
    const contextKey = JSON.stringify([
        'execute-inspector-v2',
        recipe.recipeId
    ]);
    return (
        <section
            className={styles.inspector}
            data-execute-recipe-inspector
            data-recipe-id={recipe.recipeId}
        >
            <header className={styles.header}>
                <p className={styles.eyebrow}>Recipe details</p>
                <h2>{entry.item.title}</h2>
                <code>{recipe.recipeId}</code>
                <p>{entry.item.description}</p>
            </header>
            <div className={styles.statuses}>
                <StatusMark
                    label={entry.schema.label}
                    status={entry.schema.ok ? 'passed' : 'failed'}
                />
                <StatusMark
                    label={entry.preflight.errors.length === 0 ? 'Preflight ready' : 'Preflight blocked'}
                    status={entry.preflight.errors.length === 0 ? 'passed' : 'failed'}
                />
            </div>
            <dl className={styles.facts}>
                <Fact label="Provider" value={entry.item.providerMode} />
                <Fact label="Profile" value={entry.item.profiles.join(' · ') || 'None'} />
                <Fact label="Live services" value={entry.item.live ? 'Required' : 'Not required'} />
                <Fact label="Targets" value={String(selectedTargetCount)} />
                <Fact label="Manifest commands" value={String(entry.preflight.manifestCommandCount)} />
                <Fact label="Effective commands" value={String(entry.preflight.effectiveCommandCount)} />
                <Fact label="Group" value={manifest ? groupLabel(manifest) : 'Awaiting manifest'} />
                <Fact
                    label="Run"
                    value={run?.distributedRunId ?? manifest?.manifest.distributedRunId ?? 'Not created'}
                />
            </dl>
            <div className={styles.requirements}>
                <h3>Service requirements</h3>
                {entry.preflight.liveServiceRequirements.length > 0
                    ? (
                        <ul>
                            {entry.preflight.liveServiceRequirements.map((requirement) => (
                                <li key={requirement}>{requirement}</li>
                            ))}
                        </ul>
                    )
                    : <p>No live service dependency.</p>}
            </div>
            <ExecuteInspectorSequence commands={recipe.commands} contextKey={contextKey} />
            <ExecuteInspectorPrerequisites contextKey={contextKey} prerequisites={entry.item.prerequisites} />
        </section>
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

function groupLabel(manifest: ExecuteManifestDraft): string {
    const group = manifest.manifest.group;
    return `${group.applicationId} / ${group.workspaceId} / ${group.groupId}`;
}
