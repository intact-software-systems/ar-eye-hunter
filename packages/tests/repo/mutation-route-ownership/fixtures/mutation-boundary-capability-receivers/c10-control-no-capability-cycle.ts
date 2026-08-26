export function ignoreNoCapabilityCycle(): void {
    const run = first({});
    run();

    function first(value: unknown): () => void {
        return second({ first: first(value) });
    }
    function second(value: unknown): () => void {
        return first({ second: second(value) });
    }
}
