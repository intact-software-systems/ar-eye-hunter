export function serializeGroupStateValue(value: object): string {
    const serialized = JSON.stringify(value);
    if (typeof serialized !== 'string') {
        throw new TypeError('Group state value is not JSON serializable');
    }
    return serialized;
}
