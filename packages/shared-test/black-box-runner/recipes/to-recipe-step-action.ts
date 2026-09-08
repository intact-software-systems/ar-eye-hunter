export function toRecipeStepAction(step: Record<string, unknown>): unknown {
    const type = String(step.type || 'http').toLowerCase();
    const request = step.request !== null && typeof step.request === 'object' && !Array.isArray(step.request)
        ? step.request as Record<string, unknown>
        : {};
    return type.includes('.') ? type.split('.')[1] : request.action || step.action;
}
