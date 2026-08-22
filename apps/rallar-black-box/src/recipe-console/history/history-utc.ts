export function historyUtcIso(epochMs: number): string | undefined {
    const date = new Date(epochMs);
    if (!Number.isFinite(date.getTime())) {
        return undefined;
    }
    try {
        return date.toISOString();
    }
    catch {
        return undefined;
    }
}

export function historyUtcDisplay(epochMs: number): string {
    return historyUtcIso(epochMs) ??
        `${epochMs} ms (outside display range)`;
}

export function historyUtcInputValue(epochMs: number | undefined): string {
    if (epochMs === undefined) {
        return '';
    }
    return historyUtcIso(epochMs)?.slice(0, -1) ?? '';
}

export function historyUtcInputEpoch(value: string): number | undefined {
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/.exec(value);
    if (!match) {
        return undefined;
    }
    const [, yearText, monthText, dayText, hourText, minuteText, secondText, msText] = match;
    const [year, month, day, hour, minute, second] = [
        yearText,
        monthText,
        dayText,
        hourText,
        minuteText,
        secondText ?? '0'
    ].map(Number);
    const millisecond = Number((msText ?? '').padEnd(3, '0'));
    const date = new Date(0);
    date.setUTCFullYear(year, month - 1, day);
    date.setUTCHours(hour, minute, second, millisecond);
    const epoch = date.getTime();
    return Number.isSafeInteger(epoch) && epoch >= 0 &&
            date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 &&
            date.getUTCDate() === day && date.getUTCHours() === hour &&
            date.getUTCMinutes() === minute && date.getUTCSeconds() === second &&
            date.getUTCMilliseconds() === millisecond
        ? epoch
        : undefined;
}
