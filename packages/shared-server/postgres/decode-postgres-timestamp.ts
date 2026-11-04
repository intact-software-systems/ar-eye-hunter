export function decodePostgresTimestamp(value: string | Date, label: string): Date {
    if (typeof value === 'string') {
        const match = POSTGRES_TIMESTAMP_PATTERN.exec(value);
        if (!match || !isValidTimestampMatch(match)) {
            throw new Error(`Invalid ${label} string`);
        }
        const timestamp = Date.parse(value);
        if (!Number.isFinite(timestamp)) {
            throw new Error(`Invalid ${label} string`);
        }
        return new Date(timestamp);
    }

    if (Number.isFinite(value.getTime())) {
        return new Date(value.getTime());
    }

    throw new Error(`Invalid ${label} driver value`);
}

const POSTGRES_TIMESTAMP_PATTERN =
    /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}(?::?\d{2})?)$/u;

function isValidTimestampMatch(match: RegExpExecArray): boolean {
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const hour = Number(match[4]);
    const minute = Number(match[5]);
    const second = Number(match[6]);
    if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) {
        return false;
    }
    const daysInMonth = month === 2
        ? (isLeapYear(year) ? 29 : 28)
        : [4, 6, 9, 11].includes(month)
        ? 30
        : 31;
    if (day < 1 || day > daysInMonth) {
        return false;
    }
    const zone = match[8];
    if (zone === 'Z') {
        return true;
    }
    const zoneDigits = zone.slice(1).replace(':', '');
    const zoneHour = Number(zoneDigits.slice(0, 2));
    const zoneMinute = zoneDigits.length > 2 ? Number(zoneDigits.slice(2)) : 0;
    return zoneHour <= 23 && zoneMinute <= 59;
}

function isLeapYear(year: number): boolean {
    return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}
