/**
 * A refusal the retention API decides on its own, without asking the control server: a preview
 * raised while a confirmation still holds the plan, and a confirmation offered a preview this
 * connection never issued.
 *
 * It lives beside the API rather than inside it because the history workspace folds the refusal
 * while the retention client itself stays a dynamically imported chunk.
 */
export type ControlRetentionRefusal = Readonly<{
    code: 'confirmation-in-progress' | 'foreign-preview';
    message: string;
}>;

export function toControlRetentionRefusalMessage(
    refusal: ControlRetentionRefusal | undefined
): string {
    return refusal?.message ?? 'Retention cleanup was refused.';
}
