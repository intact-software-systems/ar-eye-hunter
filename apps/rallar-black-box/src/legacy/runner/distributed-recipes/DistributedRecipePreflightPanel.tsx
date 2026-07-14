import type { DistributedRecipePreflightSummary } from '../../../distributed-recipes.ts';
import { Metric } from '../../shared/Metric.tsx';
import { formatDuration } from '../../shared/time-format.ts';

export function DistributedRecipePreflightPanel({
    preflight,
    compact = false,
}: {
    preflight: DistributedRecipePreflightSummary;
    compact?: boolean;
}) {
    const treeRows = compact ? preflight.tree.slice(0, 18) : preflight.tree;
    return (
        <div
            className={`distributed-preflight-panel ${compact ? 'compact' : ''}`}
        >
            <div className="distributed-preflight-metrics">
                <Metric
                    label="Top-level"
                    value={String(preflight.manifestCommandCount)}
                />
                <Metric
                    label="Effective ops"
                    value={String(preflight.effectiveCommandCount)}
                    tone="active"
                />
                <Metric label="Max depth" value={String(preflight.maxDepth)} />
                <Metric
                    label="Frames"
                    value={
                        preflight.effectiveFrameCount === undefined
                            ? '-'
                            : String(preflight.effectiveFrameCount)
                    }
                    tone={
                        preflight.effectiveFrameCount === undefined
                            ? 'muted'
                            : 'active'
                    }
                />
                <Metric
                    label="Loops"
                    value={String(preflight.loops.length)}
                    tone={preflight.loops.length > 0 ? 'active' : 'muted'}
                />
                <Metric
                    label="Parallel groups"
                    value={String(
                        preflight.parallelGroups.reduce(
                            (sum, entry) => sum + entry.groupCount,
                            0,
                        ),
                    )}
                    tone={
                        preflight.parallelGroups.length > 0 ? 'active' : 'muted'
                    }
                />
            </div>
            <div className="badge-list distributed-preflight-badges">
                {preflight.serviceBadges.map((badge) => (
                    <span className={`pill ${badge.tone}`} key={badge.label}>
                        {badge.label}
                    </span>
                ))}
                {preflight.commandKinds.map((kind) => (
                    <span className="pill muted" key={kind}>
                        {kind}
                    </span>
                ))}
            </div>
            {(preflight.errors.length > 0 || preflight.warnings.length > 0) && (
                <div className="distributed-preflight-issues">
                    {preflight.errors.map((issue) => (
                        <div
                            className="distributed-preflight-issue error"
                            key={issue}
                        >
                            {issue}
                        </div>
                    ))}
                    {preflight.warnings.map((issue) => (
                        <div
                            className="distributed-preflight-issue warning"
                            key={issue}
                        >
                            {issue}
                        </div>
                    ))}
                </div>
            )}
            {(preflight.loops.length > 0 ||
                preflight.parallelGroups.length > 0 ||
                preflight.waits.length > 0 ||
                preflight.asserts.length > 0) && (
                <div className="distributed-preflight-composites">
                    {preflight.loops.map((loop) => (
                        <div
                            className="distributed-preflight-composite"
                            key={`${loop.path}-loop`}
                        >
                            <strong>{loop.commandId ?? loop.path}</strong>
                            <span>Loop x{loop.estimatedIterations}</span>
                            <small>
                                {[
                                    `${loop.childCommandCount} child`,
                                    `${loop.effectiveCommandCount} ops`,
                                    loop.intervalMs === undefined
                                        ? undefined
                                        : `${loop.intervalMs} ms interval`,
                                    loop.durationMs === undefined
                                        ? undefined
                                        : `${loop.durationMs} ms duration`,
                                    loop.frameCount === undefined
                                        ? undefined
                                        : `${loop.frameCount} frames`,
                                ]
                                    .filter(Boolean)
                                    .join(' - ')}
                            </small>
                        </div>
                    ))}
                    {preflight.parallelGroups.map((parallel) => (
                        <div
                            className="distributed-preflight-composite"
                            key={`${parallel.path}-parallel`}
                        >
                            <strong>
                                {parallel.commandId ?? parallel.path}
                            </strong>
                            <span>
                                {parallel.groupCount} parallel group
                                {parallel.groupCount === 1 ? '' : 's'}
                            </span>
                            <small>
                                concurrency {parallel.maxConcurrency} -{' '}
                                {parallel.effectiveCommandCount} ops -{' '}
                                {parallel.groups.join(', ')}
                            </small>
                        </div>
                    ))}
                    {preflight.waits.map((wait) => (
                        <div
                            className="distributed-preflight-composite"
                            key={`${wait.path}-wait`}
                        >
                            <strong>{wait.commandId ?? wait.path}</strong>
                            <span>Wait/assert guard</span>
                            <small>
                                wait {formatDuration(wait.timeoutMs)} -{' '}
                                {wait.matchSummary}
                            </small>
                        </div>
                    ))}
                    {preflight.asserts.map((assertion) => (
                        <div
                            className="distributed-preflight-composite"
                            key={`${assertion.path}-assert`}
                        >
                            <strong>
                                {assertion.commandId ?? assertion.path}
                            </strong>
                            <span>Assert predicate</span>
                            <small>{assertion.predicate}</small>
                        </div>
                    ))}
                </div>
            )}
            {preflight.liveServiceRequirements.length > 0 && (
                <div className="distributed-preflight-requirements">
                    <strong>Live requirements</strong>
                    <ul>
                        {preflight.liveServiceRequirements.map(
                            (requirement) => (
                                <li key={requirement}>{requirement}</li>
                            ),
                        )}
                    </ul>
                </div>
            )}
            <div
                className="distributed-preflight-tree"
                aria-label="Recipe execution tree"
            >
                {treeRows.map((row) => (
                    <div
                        className="distributed-preflight-tree-row"
                        key={row.path}
                        style={{ paddingLeft: `${row.depth * 14}px` }}
                    >
                        <strong>{row.label}</strong>
                        <span className="pill muted">{row.kind}</span>
                        <span>{row.summary}</span>
                        <small>
                            {row.path} - {row.effectiveCommandCount} op
                            {row.effectiveCommandCount === 1 ? '' : 's'}
                            {row.details.length > 0
                                ? ` - ${row.details.join(' - ')}`
                                : ''}
                        </small>
                    </div>
                ))}
                {compact && preflight.tree.length > treeRows.length && (
                    <div className="distributed-preflight-tree-row muted">
                        <small>
                            {preflight.tree.length - treeRows.length} more
                            command row(s) in the raw manifest
                        </small>
                    </div>
                )}
            </div>
        </div>
    );
}
