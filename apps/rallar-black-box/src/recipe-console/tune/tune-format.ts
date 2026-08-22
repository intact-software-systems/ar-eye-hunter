const NUMBER = new Intl.NumberFormat('en-US', {
    maximumFractionDigits: 2
});

export function tuneNumber(value: number | undefined): string {
    return value === undefined ? 'Unavailable' : NUMBER.format(value);
}

export function tuneMilliseconds(value: number | undefined): string {
    return value === undefined ? 'Unavailable' : `${NUMBER.format(value)} ms`;
}

export function tuneHertz(value: number | undefined): string {
    return value === undefined ? 'Unavailable' : `${NUMBER.format(value)} Hz`;
}

export function tuneSigned(
    value: number | undefined,
    unit = ''
): string {
    if (value === undefined) {
        return 'Unavailable';
    }
    const sign = value > 0 ? '+' : '';
    return `${sign}${NUMBER.format(value)}${unit ? ` ${unit}` : ''}`;
}

export function tuneList(
    values: readonly string[],
    empty = 'None'
): string {
    return values.length > 0 ? values.join(' · ') : empty;
}
