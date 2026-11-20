import { getEnvConfig } from '../config/env.ts';
import { FulfillmentProviderName, ProductCategory } from '../types.ts';
import { fragmentClient } from './FragmentService.ts';
import { myStarsClient } from './MyStarsService.ts';

/**
 * Resolves the active automatic fulfillment supplier for NEW orders based on
 * `FULFILLMENT_PROVIDER` and configured credentials.
 * - `FULFILLMENT_PROVIDER=fragment` -> Fragment if configured, else manual (NEVER MyStars).
 * - `FULFILLMENT_PROVIDER=mystars` -> MyStars if configured, else manual (NEVER Fragment).
 * - Unset -> Fragment if configured, else MyStars if configured, else manual.
 */
export function resolveActiveSupplierProvider(): FulfillmentProviderName {
  const cfg = getEnvConfig();
  if (cfg.fulfillmentProviderExplicit === 'fragment') {
    return fragmentClient.isConfigured() ? 'fragment' : 'manual';
  }
  if (cfg.fulfillmentProviderExplicit === 'mystars') {
    return myStarsClient.isConfigured() ? 'mystars' : 'manual';
  }
  if (fragmentClient.isConfigured()) {
    return 'fragment';
  }
  if (myStarsClient.isConfigured()) {
    return 'mystars';
  }
  return 'manual';
}

export function isActiveSupplierConfigured(): boolean {
  return resolveActiveSupplierProvider() !== 'manual';
}

/**
 * Validates recipient eligibility before checkout strictly against the currently active
 * supplier (`fragment` or `mystars`). When in manual mode, skips external supplier calls.
 */
export async function validateRecipientWithActiveSupplier(params: {
  category: ProductCategory;
  recipientUsername: string;
  durationMonths?: 3 | 6 | 12;
}): Promise<void> {
  if (params.category !== 'stars' && params.category !== 'premium') {
    return;
  }
  const active = resolveActiveSupplierProvider();
  if (active === 'fragment') {
    await fragmentClient.validateRecipientBeforeCheckout(params);
    return;
  }
  if (active === 'mystars') {
    await myStarsClient.validateRecipientBeforeCheckout(params);
  }
}
