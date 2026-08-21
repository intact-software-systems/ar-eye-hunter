export function invokeRecursiveNoWrite(): void {
    recurse();

    function recurse(): void {
        recurse();
    }
}
