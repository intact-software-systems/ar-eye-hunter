import { useMemo } from 'react';
import { ExactIdentifier } from '../ui/ExactIdentifier.tsx';
import type { ExecuteTargetResolutionEvidence } from './execute-manifest.ts';
import { createExecuteWindowRevision } from './execute-window-revision.ts';
import styles from './ExecuteTargets.module.css';
import { ExecuteWindowedList } from './ExecuteWindowedList.tsx';

type ResolutionRow =
    | Readonly<{ kind: 'blocker'; agentId: string; message: string; }>
    | Readonly<{ kind: 'issue'; agentId?: string; message: string; }>;

export function ExecuteResolutionWindow({
    contextKey,
    resolution
}: Readonly<{
    contextKey: string;
    resolution: ExecuteTargetResolutionEvidence;
}>) {
    const rows = useMemo<readonly ResolutionRow[]>(() => [
        ...resolution.resolution.blockers.map((blocker) => ({
            kind: 'blocker' as const,
            agentId: blocker.agentId,
            message: blocker.reason
        })),
        ...resolution.comparison.issues.map((issue) => ({
            kind: 'issue' as const,
            ...(issue.agentId ? { agentId: issue.agentId } : {}),
            message: issue.message
        }))
    ], [resolution.comparison.issues, resolution.resolution.blockers]);
    if (rows.length === 0) {
        return null;
    }
    return (
        <div className={styles.blockers}>
            <h3>Resolution blockers</h3>
            <p data-execute-resolution-live-summary role="alert">
                {rows.length.toLocaleString('en-US')} resolution evidence rows require attention.
            </p>
            <ExecuteWindowedList
                contentId="execute-resolution-window"
                contextKey={contextKey}
                itemKey={(row, index) => `${row.kind}:${row.agentId ?? 'run'}:${index}`}
                itemLabel="evidence rows"
                items={rows}
                label="Resolution evidence"
                renderItem={(row) => (
                    <li data-execute-resolution-row>
                        {row.agentId
                            ? (
                                <>
                                    <ExactIdentifier value={row.agentId} /> ·
                                </>
                            )
                            : null}
                        {row.message}
                    </li>
                )}
                revisionKey={createExecuteWindowRevision(rows, (row) => [
                    row.kind,
                    row.agentId ?? null,
                    row.message
                ])}
                section="resolution"
            />
        </div>
    );
}
