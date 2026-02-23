export function findEl<T extends HTMLElement>(root: ParentNode, selector: string): T {
    const el = root.querySelector(selector);
    if (!el) {
        throw new Error(`Missing element: ${selector}`);
    }
    
    return el as T;
}
