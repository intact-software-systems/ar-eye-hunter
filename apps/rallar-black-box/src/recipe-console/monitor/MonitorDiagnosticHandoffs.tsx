import type { RallarBlackBoxDistributedGroupRef } from
    '@shared-test/rallar-bb-test/distributed-run.ts';
import type {
    DistributedRunFailureRow,
    DistributedRunRuntimeDiagnosticRow,
} from '@shared-test/rallar-bb-test/distributed-run-monitor.ts';
import { deriveAdvancedDiagnosticHandoffTargets } from '../../distributed-recipes.ts';
import { createAdvancedLegacyHref } from
    '../advanced/advanced-legacy-href.ts';
import type { RecipeConsoleUrlState } from '../routing/url-state-contract.ts';
import styles from './MonitorDiagnosticHandoffs.module.css';

export type MonitorDiagnosticHandoffsProps = Readonly<{
    controlRunId: string;
    diagnostics: readonly DistributedRunRuntimeDiagnosticRow[];
    distributedRunId: string;
    failure: DistributedRunFailureRow;
    group: RallarBlackBoxDistributedGroupRef;
    sourceSearch?: string;
    state: RecipeConsoleUrlState;
}>;

export function MonitorDiagnosticHandoffs({
    controlRunId,
    diagnostics,
    distributedRunId,
    failure,
    group,
    sourceSearch = '',
    state,
}: MonitorDiagnosticHandoffsProps) {
    const targets = deriveAdvancedDiagnosticHandoffTargets({
        failure,
        diagnostics,
    });
    if (targets.length === 0) {
        return null;
    }

    const contextualState: RecipeConsoleUrlState = {
        ...state,
        view: 'monitor',
        controlRunId,
        distributedRunId,
        agentId: failure.agentId,
        recipeId: failure.recipeId,
        commandId: failure.commandId,
    };
    const contextualSource = sourceSearchWithGroup(sourceSearch, group);
    const links = targets.flatMap(target => {
        const href = createAdvancedLegacyHref({
            surface: target.surface,
            state: contextualState,
            sourceSearch: contextualSource,
        });
        return href ? [{ ...target, href }] : [];
    });
    if (links.length === 0) {
        return null;
    }

    return (
        <nav
            aria-label="Relevant legacy diagnostics"
            className={styles.handoffs}
            data-monitor-diagnostic-handoffs
        >
            <div className={styles.heading}>
                <h3>Relevant diagnostics</h3>
                <p>Open a preserved direct tool with this failure context.</p>
            </div>
            <ul className={styles.links}>
                {links.map(link => (
                    <li key={link.surface}>
                        <a
                            aria-label={`Open ${link.label} with selected failure context`}
                            className={styles.link}
                            data-diagnostic-surface={link.surface}
                            href={link.href}
                        >
                            {link.label}
                        </a>
                    </li>
                ))}
            </ul>
        </nav>
    );
}

function sourceSearchWithGroup(
    sourceSearch: string,
    group: RallarBlackBoxDistributedGroupRef,
): string {
    const params = new URLSearchParams(sourceSearch);
    params.set('applicationId', group.applicationId);
    params.set('workspaceId', group.workspaceId);
    params.set('groupId', group.groupId);
    return params.toString();
}
