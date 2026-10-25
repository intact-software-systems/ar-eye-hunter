/** `gc` exists on a scope only where the runtime was started with its collector exposed (`--expose-gc`). */
export function resolveExposedGarbageCollector(scope: object): (() => void) | undefined {
    const gc = 'gc' in scope ? scope.gc : undefined;
    return typeof gc === 'function' ? () => gc() : undefined;
}
