/* ==========================================================================
   QUAD — COLLECTION PROVIDER ADAPTERS (compatibility surface)

   The adapters now live one per file under ./providers/:

     providers/common.js     money conversion, error shaping, constant-time compare
     providers/cashfree.js   Cashfree Payment Gateway (moved verbatim)
     providers/razorpay.js   Razorpay Payment Gateway
     providers/index.js      the registry: adapterFor, activeAdapter, requireAdapter

   Every import of this path keeps working unchanged; new code should import
   from ./providers/index.js directly.
   ========================================================================== */
export {
  cashfree, razorpay,
  PROVIDER_IDS, capabilitiesOf, publicConfigOf,
  adapterFor, configuredAdapter, configuredAdapters, activeAdapter,
  availableProviders, requireAdapter,
} from './providers/index.js';
export { paiseToRupeeString, rupeesToPaise, orderNote } from './providers/common.js';
