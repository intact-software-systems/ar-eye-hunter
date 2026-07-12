import styles from './ExactIdentifier.module.css';

export function ExactIdentifier({ value }: Readonly<{ value: string }>) {
    return (
        <bdi
            className={styles.identifier}
            data-exact-identifier
            dir="ltr"
        ><code>{value}</code></bdi>
    );
}
