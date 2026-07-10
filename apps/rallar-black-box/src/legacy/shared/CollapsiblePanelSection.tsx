import { type ReactNode, useId, useState } from 'react';

export function CollapsiblePanelSection({
    title,
    meta,
    defaultExpanded = true,
    className,
    contentClassName,
    children,
}: {
    title: string;
    meta?: ReactNode;
    defaultExpanded?: boolean;
    className?: string;
    contentClassName?: string;
    children: ReactNode;
}) {
    const [expanded, setExpanded] = useState(defaultExpanded);
    const contentId = useId();
    const toggleLabel = `${expanded ? 'Hide' : 'Show'} ${title}`;

    return (
        <section
            className={`collapsible-panel-section ${expanded ? 'expanded' : 'collapsed'} ${className ?? ''}`}
        >
            <div className="collapsible-section-heading">
                <h3>{title}</h3>
                {meta && (
                    <span className="collapsible-section-meta">{meta}</span>
                )}
                <button
                    type="button"
                    className="collapsible-toggle"
                    aria-expanded={expanded}
                    aria-controls={contentId}
                    aria-label={toggleLabel}
                    onClick={() => setExpanded((current) => !current)}
                >
                    {expanded ? 'Hide' : 'Show'}
                </button>
            </div>
            <div
                id={contentId}
                className={`collapsible-section-content ${contentClassName ?? ''}`}
                hidden={!expanded}
            >
                {children}
            </div>
        </section>
    );
}
