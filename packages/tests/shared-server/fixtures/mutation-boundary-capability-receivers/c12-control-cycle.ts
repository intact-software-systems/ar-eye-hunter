declare const provided: { ordinary(): void } | undefined;

export function ignoreCapabilityCycle(): void {
  let first: { ordinary(): void } | undefined = provided;
  let second: { ordinary(): void } | undefined = provided;
  first = second;
  second = first;
  first?.ordinary();
}
