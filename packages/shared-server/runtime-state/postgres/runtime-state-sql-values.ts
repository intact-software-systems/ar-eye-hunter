export function toExclusivePrefixEnd(prefix: string): string {
    if (prefix.length === 0) {
        throw new Error('Runtime state prefix must not be empty.');
    }

    const lastIndex = prefix.length - 1;
    const lastCode = prefix.charCodeAt(lastIndex);
    if (lastCode >= 0xffff) {
        throw new Error(`Runtime state prefix has no safe upper bound: ${prefix}`);
    }
    return `${prefix.slice(0, lastIndex)}${String.fromCharCode(lastCode + 1)}`;
}

export function toPgDate(timestamp: number): Date {
    if (!Number.isFinite(timestamp)) {
        throw new Error('expireAtTimestamp must be a finite number');
    }

    return new Date(timestamp);
}
