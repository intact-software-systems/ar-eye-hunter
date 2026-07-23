export function passArbitraryValueToExternal(
  external: (value: unknown) => void,
): void {
  external({ value: 'ordinary' });
}
