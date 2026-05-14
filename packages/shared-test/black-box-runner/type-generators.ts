type RandomType =
    | 'iban'
    | 'int'
    | 'integer'
    | 'float'
    | 'floating'
    | 'floatingPoint'
    | 'date'
    | 'dateTime'
    | 'uuid'

function toRandomInteger(min: number, max: number): number {
    return Math.floor(Math.random() * (max - min)) + min
}

function toDateSplit(date: string): [number, number, number] {
    const dateSplit = date.split('-')

    return [
        Number.parseInt(dateSplit[0]),
        Number.parseInt(dateSplit[1]),
        Number.parseInt(dateSplit[2]),
    ]
}

function toRandomYear(min: string, max: string): number {
    return toRandomInteger(
        toDateSplit(min)[0],
        toDateSplit(max)[0],
    )
}

function toDateRangeForMonth(month: number): [number, number] {
    switch (month) {
        case 1:
        case 3:
        case 5:
        case 7:
        case 8:
        case 10:
        case 12:
            return [1, 31]
        case 2:
            return [1, 28]
        case 4:
        case 6:
        case 9:
        case 11:
        default:
            return [1, 30]
    }
}

function toRandomMonthInYear(year: number, min: string, max: string): number {
    const start = toDateSplit(min)
    const end = toDateSplit(max)

    if (year > start[0] && year < end[0]) {
        return toRandomInteger(1, 12)
    }

    if (year === start[0] && year < end[0]) {
        return toRandomInteger(start[1], 12)
    }

    if (year === start[0] && year === end[0]) {
        return toRandomInteger(start[1], end[1])
    }

    return toRandomInteger(1, 12)
}

function toRandomDayInMonth(month: number, min: string, max: string): number {
    const start = toDateSplit(min)
    const end = toDateSplit(max)

    const dateRange = toDateRangeForMonth(month)

    if (month > start[1] && month < end[1]) {
        return toRandomInteger(dateRange[0], dateRange[1])
    }

    if (month === start[1] && month < end[1]) {
        return toRandomInteger(start[2], dateRange[1])
    }

    if (month === start[1] && month === end[1]) {
        return toRandomInteger(start[2], end[2])
    }

    return toRandomInteger(1, 12)
}

function toRandomDateTimeIsoString(min: string, max: string): string {
    if (max === 'now') {
        max = new Date(Date.now())
            .toISOString()
            .slice(0, 10)
    }

    const year = toRandomYear(min, max)
    const month = toRandomMonthInYear(year, min, max)
    const day = toRandomDayInMonth(month, min, max)

    return new Date(year, month - 1, day)
        .toISOString()
}

function toRandomFloat(min: number, max: number, decimals?: number): number {
    const num = Math.random() * (max - min) + min
    return roundToDecimals(num, decimals || 2)
}

function roundToDecimals(num: number, decimals: number): number {
    if (decimals < 0) {
        decimals = 0
    }

    return +(Math.round(Number(num + 'e+' + decimals)) + 'e-' + decimals)
}

function toRandomIban(countryCode: string, technicalOrgNum: string): string {
    return countryCode + toRandomInteger(20, 90) + technicalOrgNum + toRandomInteger(1000000, 9999999)
}

function toRandomIbans(countryCode: string, technicalOrgNum: string, numberOf: number): string[] {
    return new Array(numberOf)
        .fill(0)
        .map(() => toRandomIban(countryCode, technicalOrgNum))
}

function toRandomIntegers(min: number, max: number, numberOf: number): number[] {
    return new Array(numberOf)
        .fill(0)
        .map(() => toRandomInteger(min, max))
}

function toRandomFloats(min: number, max: number, numberOf: number, decimals?: number): number[] {
    return new Array(numberOf)
        .fill(0)
        .map(() => toRandomFloat(min, max, decimals))
}

function toRandomDates(min: string, max: string, numberOf: number): string[] {
    return new Array(numberOf)
        .fill(0)
        .map(() => {
            const dateTimeAsString = toRandomDateTimeIsoString(min, max)
            return dateTimeAsString
                .slice(0, 10)
        })
}

function toRandomDateTimes(min: string, max: string, numberOf: number): string[] {
    return new Array(numberOf)
        .fill(0)
        .map(() => {
            const dateTimeAsString = toRandomDateTimeIsoString(min, max)
            return dateTimeAsString
                .slice(0, dateTimeAsString.length - 1)
        })
}

function toUuids(numberOf: number): string[] {
    return new Array(numberOf)
        .fill(0)
        .map(() => crypto.randomUUID())
}

function toRandomTechnicalOrgNum(): string {
    return toRandomInteger(1000, 9999999).toString()
}

export function toRandomFromType(
    type: RandomType | string,
    min: string | number,
    max: string | number,
    numberOf: number,
    decimals?: number,
): Array<string | number> {
    switch (type) {
        case 'iban':
            return toRandomIbans('NO', toRandomTechnicalOrgNum(), numberOf)
        case 'int':
        case 'integer':
            return toRandomIntegers(Number(min), Number(max), numberOf)
        case 'float':
        case 'floating':
        case 'floatingPoint':
            return toRandomFloats(Number(min), Number(max), numberOf, decimals)
        case 'date':
            return toRandomDates(String(min), String(max), numberOf)
        case 'dateTime':
            return toRandomDateTimes(String(min), String(max), numberOf)
        case 'uuid':
            return toUuids(numberOf)
    }

    return []
}