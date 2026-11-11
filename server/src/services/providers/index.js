/* ==========================================================================
   QUAD — COLLECTION PROVIDER REGISTRY

   One interface, several gateways, so which one Quad collects through is a
   deployment decision rather than a rewrite. Nothing outside this directory
   names a gateway: routes/payments.js, the ledger, the settlement engine and
   the order pipeline all speak the vocabulary below.

   Every adapter exports the same shape:

     id, label, configured, needs
     createOrder(ctx)               -> { providerOrderId, sessionId, checkout }
     verifyWebhook(headers, rawBody)-> { ok, reason, eventId, receivedAtMs }
     eventId(body, headers)         -> the (provider, event_id) idempotency key
     readEvent(body, headers)       -> a NORMALISED event (see below)
     fetchOrder(providerOrderId)    -> the same normalised shape, pulled
     refund(ctx)                    -> { providerRefundId, status, settled }
     fetchSettlements(window)       -> { cursor, entries: [settlement lines] }

   Optional, by capability:

     readRefundEvent(body)          -> { refundId, providerRefundId, status, outcome } | null
     fetchRefund(providerOrderId, refundId, refundRow) -> { status, outcome?, amountPaise }
     terminateOrder(providerOrderId)
     fetchSplitVendor(providerVendorId)

   A settlement line, normalised, all amounts integer paise:

     { providerPaymentId, providerOrderId, settlementId, settlementUtr,
       eventType, paymentAmountPaise, serviceChargePaise, serviceTaxPaise,
       settlementAmountPaise, raw }

   The normalised event/status shape, which is the whole point:

     { outcome, providerOrderId, providerPaymentId, amountPaise, currency,
       feePaise, raw }

     outcome ∈ 'paid' | 'failed' | 'dropped' | 'pending' | 'unknown'

   ── FIVE RULES, because money depends on them ────────────────────────────

   1. `outcome: 'paid'` means the provider states, authoritatively, that it
      holds the customer's money. A browser returning from checkout is not
      evidence of anything and never reaches an adapter.

   2. Amounts come back in integer paise, converted by parsing a STRING,
      never by multiplying a float.

   3. An adapter never decides anything. It reports what the provider said.
      Whether that confirms an order — amount equality, order mapping,
      idempotency, replay — is decided by the caller against the database,
      for every provider identically.

   4. Signature verification is constant-time and operates on the RAW request
      bytes, which is why index.js captures req.rawBody.

   5. No adapter invents a payment. With no credentials `configured` is false
      and the route refuses with `configuration_required` before reaching it.

   ── Isolation ────────────────────────────────────────────────────────────

   Each adapter lives in its own file with its own credentials and its own
   secret. A provider is resolved either by the id recorded on a payment row
   (`adapterFor`) or by the deployment's configured collection provider
   (`activeAdapter`). Both may be configured at once: a deployment that has
   switched collection providers still owes refunds, status pulls and
   reconciliation on the other one's payments, and each of those paths
   resolves the adapter from the row, never from today's setting.
   ========================================================================== */
import { PAYMENTS } from '../../config.js';
import { ProviderUnavailable } from '../../auth/rbac.js';
import { cashfree } from './cashfree.js';
import { razorpay } from './razorpay.js';

export { cashfree, razorpay };

const ADAPTERS = { cashfree, razorpay };

/* What each adapter asks of the shared route, declared here so an adapter
   whose body must not change (Cashfree's, verified in production) still
   has its capabilities stated in one place. An adapter that declares its
   own flags wins. */
const CAPABILITIES = {
  cashfree: { requiresCustomerPhone: true, supportsSplits: true },
  razorpay: { requiresCustomerPhone: false, supportsSplits: false },
};

export function capabilitiesOf(adapter) {
  const declared = CAPABILITIES[adapter?.id] || {};
  return {
    requiresCustomerPhone: adapter?.requiresCustomerPhone ?? declared.requiresCustomerPhone ?? false,
    supportsSplits: adapter?.supportsSplits ?? declared.supportsSplits ?? false,
  };
}

/** Every provider id this build has an adapter for. */
export const PROVIDER_IDS = Object.keys(ADAPTERS);

/**
 * The adapter for a specific provider id, regardless of what this deployment
 * is currently configured to collect through.
 *
 * A refund must go back through the gateway that TOOK the payment, which is
 * not necessarily the gateway configured today: a deployment that switched
 * providers still owes refunds on yesterday's orders. `payment.provider`
 * records which one, and this resolves it.
 */
export function adapterFor(providerId) {
  const a = ADAPTERS[providerId];
  if (!a) {
    throw ProviderUnavailable(`Unknown payment provider "${providerId}"`,
      'This payment was taken by a gateway this build has no adapter for.');
  }
  if (!a.configured) {
    throw ProviderUnavailable(`${a.label} is not configured`,
      `${a.needs} A refund cannot be issued through a gateway this server cannot reach.`);
  }
  return a;
}

/** The adapter for a provider id if it is known AND configured, else null. */
export function configuredAdapter(providerId) {
  const a = ADAPTERS[providerId];
  return a && a.configured ? a : null;
}

/** Every adapter this deployment can actually reach right now. */
export function configuredAdapters() {
  return Object.values(ADAPTERS).filter((a) => a.configured);
}

/** The adapter this deployment is configured to collect through, or null. */
export function activeAdapter() {
  const a = ADAPTERS[PAYMENTS.provider];
  return a && a.configured ? a : null;
}

/** Every adapter, with whether this deployment could actually use it. */
export const availableProviders = () =>
  Object.values(ADAPTERS).map((a) => ({
    id: a.id, label: a.label, configured: a.configured, needs: a.needs,
  }));

/**
 * The configured adapter, or a truthful 503. Every collection caller goes
 * through here, so there is exactly one place that can decide collection is
 * unavailable — and no place at all that can pretend it is available.
 */
export function requireAdapter() {
  const a = activeAdapter();
  if (!a) {
    throw ProviderUnavailable('No payment provider is configured',
      'Set PAYMENT_PROVIDER to one of: cashfree, razorpay — with that provider\'s ' +
      'credentials. No order can be placed until then, and there is no cash option.');
  }
  return a;
}

/* What the browser is allowed to know about an adapter. Cashfree's adapter
   body predates this hook, so its public configuration still comes from
   PAYMENTS.publicConfig; an adapter that declares `publicConfig` wins. */
export function publicConfigOf(adapter) {
  if (adapter && adapter.publicConfig) return adapter.publicConfig;
  if (adapter?.id === PAYMENTS.provider) return PAYMENTS.publicConfig;
  return {};
}
