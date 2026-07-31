/// <reference lib="deno.ns" />

export function readApiV1BlackBoxArgValues(
  args: readonly string[],
): ReadonlyMap<string, string | boolean> {
  const values = new Map<string, string | boolean>();
  for (const arg of args) {
    const [name, value] = arg.includes('=') ? arg.split(/=(.*)/s, 2) : [arg, true];
    values.set(name, value);
  }
  return values;
}
