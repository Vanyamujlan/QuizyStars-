import { getEnvConfig } from '../config/env.ts';
import { ActiveFulfillmentProviderType, ProductCategory } from '../types.ts';
import { myStarsClient } from './MyStarsService.ts';

/**
 * Resolves the active automatic fulfillment supplier for NEW orders.
 * QuizyStars uses MyStars as the sole automatic fulfillment supplier:
 * - `FULFILLMENT_PROVIDER=mystars` (or unset) -> `'mystars'` when `MYSTARS_API_KEY` is configured, else `'manual'`.
 * - `FULFILLMENT_PROVIDER=manual` (or any unsupported/legacy value) -> `'manual'`.
 */
export function resolveActiveSupplierProvider(): ActiveFulfillmentProviderType {
  const cfg = getEnvConfig();
  if (cfg.invalidFulfillmentProvider || cfg.fulfillmentProvider === 'manual') {
    return 'manual';
  }
  if (myStarsClient.isConfigured()) {
    return 'mystars';
  }
  return 'manual';
}

export function isActiveSupplierConfigured(): boolean {
  return resolveActiveSupplierProvider() === 'mystars';
}

/**
 * Validates recipient eligibility before checkout against MyStars when active.
 * In manual mode, skips external supplier calls.
 */
export async function validateRecipientWithActiveSupplier(params: {
  category: ProductCategory;
  recipientUsername: string;
  durationMonths?: 3 | 6 | 12;
}): Promise<void> {
  if (params.category !== 'stars' && params.category !== 'premium') {
    return;
  }
  if (resolveActiveSupplierProvider() === 'mystars') {
    await myStarsClient.validateRecipientBeforeCheckout(params);
  }
}
