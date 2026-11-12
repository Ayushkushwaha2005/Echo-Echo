/* ==========================================================================
   CASHFREE PAYMENT GATEWAY — RETIRED (12 November 2026)

   Cashfree no longer collects for ECHO ECHO. The merchant account was closed
   by Cashfree on 3 November 2026 and the platform collects through another
   gateway. This file is deliberately NOT a working adapter:

     · `configured` is always false, whatever the environment holds. No
       CASHFREE_* variable is read anywhere in the server any more, so no
       deployment setting can bring collection, webhooks, status pulls,
       refunds or settlement pulls back.
     · Every method fails closed with a 503 `configuration_required` that
       names the retirement, so a caller that somehow reaches one records a
       refusal rather than a guess.
     · The id stays `cashfree`, because payment, refund, webhook and
       settlement rows written while Cashfree was live carry it, and the
       registry resolves those rows to THIS adapter: a historical row is
       recognised (not "unknown provider") and refused honestly (not
       re-processed).

   Historical data is untouched: nothing here reads, rewrites or deletes a
   row. The retirement decision and what it covers are in
   docs/CASHFREE-RETIREMENT.md.
   ========================================================================== */
import { ProviderUnavailable } from '../../auth/rbac.js';

export const CASHFREE_RETIRED_ON = '2026-11-12';

const WHY = 'Cashfree was retired from ECHO ECHO on 12 November 2026 and cannot be configured, ' +
  'collect, verify a webhook, pull a status or refund. Payments it took remain on record; ' +
  'any money still to be returned on one is refunded by bank transfer and recorded by an ' +
  'administrator. See docs/CASHFREE-RETIREMENT.md.';

const retired = () => ProviderUnavailable('Cashfree is retired', WHY);

export const cashfree = Object.freeze({
  id: 'cashfree',
  label: 'Cashfree Payment Gateway (retired)',
  retired: true,
  retiredOn: CASHFREE_RETIRED_ON,
  get configured() { return false; },
  needs: WHY,

  /* Capabilities, declared so the registry never falls back to the flags
     the live adapter once had: no split settlement can be requested. */
  requiresCustomerPhone: true,
  supportsSplits: false,
  publicConfig: Object.freeze({}),

  async createOrder() { throw retired(); },
  verifyWebhook() { return { ok: false, reason: 'provider_retired' }; },
  eventId() { return null; },
  readEvent() { throw retired(); },
  readRefundEvent() { return null; },
  async fetchOrder() { throw retired(); },
  async terminateOrder() { throw retired(); },
  async refund() { throw retired(); },
  async fetchRefund() { throw retired(); },
  async fetchSettlements() { throw retired(); },
  async fetchSplitVendor() { throw retired(); },
});
