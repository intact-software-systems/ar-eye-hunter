import type { ALDeliveryState } from '@shared-web/browser/rallar.ts';

/** The last WS command's receipt state in the diagnostics panel; nothing before the first WS command (D72). */
export function RelicCommandDeliveryRow({
    delivery
}: Readonly<{ delivery: ALDeliveryState | undefined; }>) {
    return delivery === undefined ? null : <small>Last command {delivery}</small>;
}
