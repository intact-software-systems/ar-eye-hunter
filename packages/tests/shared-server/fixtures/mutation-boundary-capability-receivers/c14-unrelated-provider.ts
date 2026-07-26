export function createRepository(): { readonly read: () => void } {
  return { read: () => undefined };
}
