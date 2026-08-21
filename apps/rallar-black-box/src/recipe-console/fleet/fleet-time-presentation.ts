const UTC_DATE_TIME = new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeStyle: 'medium',
    timeZone: 'UTC'
});

export function fleetUtcTime(value: number | undefined): string {
    if (value === undefined || !Number.isFinite(value)) {
        return 'unavailable';
    }
    const date = new Date(value);
    return Number.isFinite(date.getTime())
        ? UTC_DATE_TIME.format(date)
        : 'unavailable';
}
