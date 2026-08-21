import type { AdvancedWorkspaceSection } from './advanced-workspace-contract.ts';
import styles from './AdvancedWorkspace.module.css';

export function AdvancedSurfaceSections({
    sections
}: Readonly<{ sections: readonly AdvancedWorkspaceSection[]; }>) {
    return (
        <nav
            aria-label="Advanced legacy tools"
            className={styles.catalog}
            data-advanced-catalog
        >
            {sections.map((section) => (
                <section
                    aria-labelledby={`advanced-${section.id}-heading`}
                    className={styles.category}
                    data-advanced-category={section.id}
                    key={section.id}
                >
                    <header className={styles.categoryHeader}>
                        <h2 id={`advanced-${section.id}-heading`}>
                            {section.title}
                        </h2>
                        <p>{section.description}</p>
                    </header>
                    <ul className={styles.surfaceList}>
                        {section.links.map((link) => (
                            <li key={link.id}>
                                <a
                                    className={styles.surfaceLink}
                                    data-advanced-surface-link
                                    data-surface-id={link.id}
                                    href={link.href}
                                >
                                    <span className={styles.surfaceLabel}>
                                        {link.label}
                                    </span>
                                    <span className={styles.routeLabel}>
                                        {link.routeLabel}
                                    </span>
                                </a>
                            </li>
                        ))}
                    </ul>
                </section>
            ))}
        </nav>
    );
}
