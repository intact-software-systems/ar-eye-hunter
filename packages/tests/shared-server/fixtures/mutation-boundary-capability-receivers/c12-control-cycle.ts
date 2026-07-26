export function ignoreCapabilityCycle(): void {
  let first: { ordinary(): void } | undefined = undefined;
  let second: { ordinary(): void } | undefined = undefined;
  first = second;
  second = first;
  first?.ordinary();
}
