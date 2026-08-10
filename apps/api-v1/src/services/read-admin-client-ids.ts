export function readAdminClientIds(): readonly string[] {
  return (Deno.env.get('AUTH_ADMIN_CLIENT_IDS') ?? 'admin')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}
