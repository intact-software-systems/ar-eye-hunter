import {
    requirePersistedALFields,
    requirePersistedALRecord,
    type PersistedALValue
} from './persisted-al-value-validation.ts';

export function assertPersistedALDelivery(value: PersistedALValue): void {
    const delivery = requirePersistedALRecord(value, 'delivery');
    requirePersistedALFields(
        delivery,
        ['ownership', 'reliability', 'ack'],
        ['reliability', 'ack']
    );
    if (
        delivery.ownership !== undefined &&
        (
            typeof delivery.ownership !== 'string' ||
            !['shared', 'exclusive'].includes(delivery.ownership)
        )
    ) {
        throw new TypeError('Persisted AL delivery ownership is invalid');
    }
    if (
        typeof delivery.reliability !== 'string' ||
        !['best-effort', 'at-least-once'].includes(delivery.reliability)
    ) {
        throw new TypeError('Persisted AL delivery reliability is invalid');
    }
    if (
        typeof delivery.ack !== 'string' ||
        !['none', 'receiver', 'all-logical-recipients', 'group-leader'].includes(delivery.ack)
    ) {
        throw new TypeError('Persisted AL delivery ack is invalid');
    }
}
