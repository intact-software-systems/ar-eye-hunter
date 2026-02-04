export class PartitionRange {
    static partition<V>(
        value: V,
        inputFrom: number,
        inputTo: number,
        maxRangeSize: number,
        partitioner: (from: number, to: number, value: V) => V,
    ): V[] {
        if (inputFrom > inputTo) {
            throw new Error(`From cannot be larger than to: ${inputFrom} > ${inputTo}`);
        }
        if (inputFrom === inputTo) {
            return [value];
        }
        if ((inputTo - inputFrom) <= maxRangeSize) {
            return [value];
        }

        let from = inputFrom;
        let to = Math.min(inputTo, inputFrom + maxRangeSize);

        const newRanges: V[] = [];

        // Mirrors: while (from < to) { ... }
        while (from < to) {
            newRanges.push(partitioner(from, to, value));

            from = Math.min(to + 1, inputTo);
            to = Math.min(from + maxRangeSize, inputTo);
        }

        return newRanges;
    }
}