export function dateInputStartEpoch(value: string): number | undefined {
    if (!value) {
        return undefined;
    }
    const epochMs = new Date(`${value}T00:00:00`).getTime();
    return Number.isFinite(epochMs) ? epochMs : undefined;
}

export function dateInputEndEpoch(value: string): number | undefined {
    if (!value) {
        return undefined;
    }
    const epochMs = new Date(`${value}T23:59:59.999`).getTime();
    return Number.isFinite(epochMs) ? epochMs : undefined;
}
