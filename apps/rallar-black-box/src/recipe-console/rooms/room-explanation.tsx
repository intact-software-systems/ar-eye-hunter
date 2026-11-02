import type {
    AdminSupportFact,
    AdminSupportJsonValue,
    AdminSupportNarrativeResponse
} from '@shared/api/admin-support/admin-support-types.ts';
import styles from './room-operations.module.css';

export interface RoomExplanationProps {
    readonly narrative: AdminSupportNarrativeResponse;
}

const ROOM_FACT_LABELS = new Set([
    'group.members',
    'group.admission',
    'group.retention',
    'group.schedule',
    'group.gameplayParticipation',
    'group.lifecycleAdmissionForUninvitedPlayer'
]);

export function RoomExplanation({ narrative }: RoomExplanationProps) {
    return (
        <section aria-label="Room explanation" className={styles.stack}>
            <h2>Room explanation</h2>
            {narrative.target.kind === 'group' && (
                <p>
                    Room reference: <strong>{narrative.target.groupRef.groupId}</strong>
                </p>
            )}
            <p>
                Observed{' '}
                {new Date(narrative.generatedAtEpochMs).toISOString()}. Presence and membership do not prove gameplay
                participation.
            </p>
            <p>
                Lifecycle admission describes an uninvited player’s lifecycle window only. Credentials, reservations,
                capacity and account restrictions still apply.
            </p>
            {narrative.warnings.map((warning) => <p key={warning.code}>{warning.message}</p>)}
            <RoomFacts facts={narrative.facts.filter((fact) => ROOM_FACT_LABELS.has(fact.label))} />
            <details>
                <summary>Formation and connectivity evidence</summary>
                <RoomFacts facts={narrative.facts.filter((fact) => !ROOM_FACT_LABELS.has(fact.label))} />
            </details>
            <details>
                <summary>Recent room events</summary>
                {narrative.timeline.length === 0
                    ? <p>No recent events were returned.</p>
                    : (
                        <ol>
                            {narrative.timeline.map((event, index) => (
                                <li key={`${event.rawRef ?? event.eventType}-${index}`}>
                                    {event.atEpochMs === undefined
                                        ? 'Time unknown'
                                        : new Date(event.atEpochMs).toISOString()} — {event.summary}
                                </li>
                            ))}
                        </ol>
                    )}
            </details>
        </section>
    );
}

function RoomFacts({ facts }: { readonly facts: readonly AdminSupportFact[]; }) {
    return (
        <dl className={styles.facts}>
            {facts.map((fact) => (
                <div key={fact.label}>
                    <dt>{fact.label === 'group.members' ? 'Membership and presence' : toEvidenceLabel(fact.label)}</dt>
                    <dd>
                        <span className={styles.certainty}>{fact.certainty} · {fact.source}</span>
                        <EvidenceValue value={fact.value} />
                    </dd>
                </div>
            ))}
        </dl>
    );
}

function EvidenceValue({ value }: { readonly value: AdminSupportJsonValue; }) {
    if (value === null) {
        return <span>Not set</span>;
    }
    if (Array.isArray(value)) {
        return value.length === 0 ? <span>None</span> : (
            <ul>
                {value.map((entry, index) => (
                    <li key={index}>
                        <EvidenceValue value={entry} />
                    </li>
                ))}
            </ul>
        );
    }
    if (typeof value === 'object') {
        return (
            <dl>
                {Object.entries(value).map(([key, entry]) => (
                    <div key={key}>
                        <dt>{toEvidenceLabel(key)}</dt>
                        <dd>
                            <EvidenceValue value={entry} />
                        </dd>
                    </div>
                ))}
            </dl>
        );
    }
    return <span>{String(value)}</span>;
}

function toEvidenceLabel(label: string): string {
    const text = label.replace(/^group\./, '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/\./g, ' / ').toLowerCase();
    return text.charAt(0).toUpperCase() + text.slice(1);
}
