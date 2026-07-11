import styles from '../views/PreviewState.module.css';

const LEGACY_COMPATIBILITY_LINKS = [
    ['Auth', '/?provider=simulated&experience=legacy&tab=auth'],
    ['Groups', '/?provider=simulated&experience=legacy&tab=rooms-clients'],
    ['WebSocket', '/?provider=simulated&experience=legacy&tab=websocket'],
    ['RTC', '/?provider=simulated&experience=legacy&tab=rtc-diagnostics'],
    ['Data', '/?provider=simulated&experience=legacy&tab=rallar-data'],
    ['CRDT', '/?provider=simulated&experience=legacy&tab=crdt-health'],
    ['Media', '/?provider=simulated&experience=legacy&tab=media'],
    ['Server', '/?provider=simulated&experience=legacy&tab=rallar-server'],
    ['Tracing', '/?provider=simulated&experience=legacy&tab=rallar-trace'],
] as const;

export function AdvancedPreview() {
    return (
        <section className={styles.preview} data-preview-view="advanced">
            <div>
                <h2>Legacy compatibility bridge</h2>
                <p className={styles.intro}>
                    These data-only links preserve direct diagnostic routes while Recipe Console replaces workflows through documented cutover proof.
                </p>
            </div>
            <nav aria-label="Legacy diagnostic compatibility" className={styles.legacyLinks}>
                {LEGACY_COMPATIBILITY_LINKS.map(([label, href]) => (
                    <a
                        href={href}
                        key={href}
                    >
                        {label}
                    </a>
                ))}
            </nav>
        </section>
    );
}
