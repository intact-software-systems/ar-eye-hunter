export interface OutboundTestPayload {
    readonly [field: string]: string;
}

/** Test transport frames are flat string maps; reject a malformed persisted frame. */
export function decodeOutboundTestPayload(value: unknown): OutboundTestPayload {
    if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
        throw new TypeError('Stored test transport frame must be a plain string map');
    }
    const entries: [string, string][] = [];
    for (const key of Reflect.ownKeys(value)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (
            typeof key !== 'string' || !descriptor?.enumerable ||
            !Object.prototype.hasOwnProperty.call(descriptor, 'value') || typeof descriptor.value !== 'string'
        ) {
            throw new TypeError('Stored test transport frame must contain only string data fields');
        }
        entries.push([key, descriptor.value]);
    }
    return Object.fromEntries(entries);
}
