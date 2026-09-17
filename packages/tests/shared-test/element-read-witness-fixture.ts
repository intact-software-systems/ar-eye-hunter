export interface ElementReadWitness<Value> {
    readonly values: readonly Value[];
    readonly readsPerElement: () => readonly number[];
}

/** Hands a derivation a copy of the values that counts every read of each element by index. */
export function createElementReadWitness<Value>(values: readonly Value[]): ElementReadWitness<Value> {
    const reads = values.map(() => 0);
    return {
        values: new Proxy([...values], {
            get(target, property, receiver) {
                if (typeof property === 'string' && /^(0|[1-9]\d*)$/.test(property)) {
                    const position = Number(property);
                    reads[position] = (reads[position] ?? 0) + 1;
                }
                return Reflect.get(target, property, receiver);
            }
        }),
        readsPerElement: () => [...reads]
    };
}
