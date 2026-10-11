/**
 * Global application utility functions.
 */

/**
 * Checks if a value is truthy (active, true, "true", "active", "1", non-zero number).
 */
export function isTruthy(val: any): boolean {
  if (val === undefined || val === null) return false;
  if (typeof val === 'string') {
    const s = val.trim().toLowerCase();
    return s === 'true' || s === '1' || s === 'yes' || s === 'active' || s === 'on' || s === 'enabled' || s === 'active';
  }
  if (typeof val === 'boolean') return val;
  if (typeof val === 'number') return val !== 0;
  return !!val;
}

/**
 * Helper to dynamically delay action.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
