interface NumberExtrema {
    readonly min: number;
    readonly max: number;
}

/** Absent for no values. */
export function computeNumberExtrema(values: readonly number[]): NumberExtrema | undefined {
    if (values.length === 0) {
        return undefined;
    }
    let min = values[0];
    let max = values[0];
    for (let index = 1; index < values.length; index += 1) {
        const value = values[index];
        if (value < min) {
            min = value;
        }
        if (value > max) {
            max = value;
        }
    }
    return { min, max };
}
