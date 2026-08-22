import type { RunCausalTrailItem } from '../../../distributed-recipes.ts';

export function CausalTrailPanel({
    items
}: {
    items: readonly RunCausalTrailItem[];
}) {
    const copyTrailTarget = (item: RunCausalTrailItem): void => {
        const target = item.targetId ?? item.commandId ?? item.agentId ?? item.evidence[0];
        if (!target || !navigator.clipboard) {
            return;
        }
        void navigator.clipboard.writeText(target);
    };

    return (
        <section className="causal-trail-panel runner-evidence-first">
            <div className="section-heading">
                <h3>Causal Trail</h3>
                <span>{items.length} steps</span>
            </div>
            {items.length === 0
                ? (
                    <div className="empty-state">
                        No failure trail for the selected run.
                    </div>
                )
                : (
                    <div className="causal-trail-list">
                        {items.map((item, index) => (
                            <article
                                className={`causal-trail-item ${item.tone}`}
                                key={`${item.kind}-${index}`}
                            >
                                <span className="causal-trail-index">
                                    {index + 1}
                                </span>
                                <div>
                                    <strong>{item.label}</strong>
                                    <p>{item.detail}</p>
                                    <small>
                                        {[
                                            item.agentId,
                                            item.recipeId,
                                            item.commandId
                                        ].filter(Boolean).join(' / ') || 'no linked id'}
                                    </small>
                                    <div className="causal-trail-actions">
                                        {item.actionLabel && (
                                            <button
                                                type="button"
                                                onClick={() => copyTrailTarget(item)}
                                                title={item.targetId
                                                    ? `Copy ${item.targetKind ?? 'evidence'} ${item.targetId}`
                                                    : 'Copy linked evidence id'}
                                            >
                                                {item.actionLabel}
                                            </button>
                                        )}
                                        {item.evidence.slice(0, 4).map((evidence) => (
                                            <span
                                                className="causal-trail-evidence"
                                                key={evidence}
                                                title={evidence}
                                            >
                                                {evidence}
                                            </span>
                                        ))}
                                    </div>
                                </div>
                                <span className={`pill ${item.tone}`}>
                                    {item.kind.replaceAll('-', ' ')}
                                </span>
                            </article>
                        ))}
                    </div>
                )}
        </section>
    );
}
