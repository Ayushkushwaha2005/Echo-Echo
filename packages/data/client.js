/* ==========================================================================
   QUAD — BROWSER API CLIENT

   This replaces the in-memory `api` object as the surfaces' data source.
   Every call is an HTTP request to the Quad server with the session cookie
   attached. There is no local fallback: if the server is unreachable, the
   surface shows that it is unreachable rather than quietly serving stale
   or invented data.

   The old packages/data/{api,catalog,campus,auth}.js modules remain in the
   tree only as the prototype's fixtures. They are no longer the source of
   truth and must not be imported by a production surface.
   ========================================================================== */

/* The API base is injected by the page (see each surface's index.html, which
   the build rewrites for the target environment). It is deliberately NOT
   defaulted here: a bundle that shipped without one would otherwise fall
   back to a developer's machine, which is exactly the kind of quiet wrong
   behaviour this codebase avoids. Same-origin is the only fallback, and it
   is correct when the API and the surfaces are served together. */
export const API_BASE = (() => {
  const injected = typeof globalThis !== 'undefined' && globalThis.QUAD_API_BASE;
  if (injected) return String(injected).replace(/\/$/, '');
  if (typeof location !== 'undefined' && location.origin) return location.origin;
  throw new Error('QUAD_API_BASE is not configured for this page.');
})();

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error || `Request failed (${status})`);
    this.status = status;
    this.code = body?.code;
    this.detail = body?.detail;
  }
  /* True when the failure is "an external service is not connected" rather
     than "you did something wrong" — surfaces render these differently. */
  get isConfiguration() { return this.code === 'configuration_required'; }
}

export class Offline extends Error {
  constructor() { super('Cannot reach the ECHO ECHO server'); this.code = 'offline'; }
}

async function call(method, path, body, opts = {}) {
  let res;
  try {
    res = await fetch(API_BASE + path, {
      method,
      credentials: 'include',
      headers: body instanceof FormData ? {} : { 'Content-Type': 'application/json' },
      body: body == null ? undefined : (body instanceof FormData ? body : JSON.stringify(body)),
      signal: opts.signal,
    });
  } catch {
    throw new Offline();
  }
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  if (!res.ok) throw new ApiError(res.status, json || { error: text.slice(0, 200) });
  return json;
}

const get = (p) => call('GET', p);
const post = (p, b) => call('POST', p, b);
const patch = (p, b) => call('PATCH', p, b);
const put = (p, b) => call('PUT', p, b);
const qs = (o) => {
  const s = new URLSearchParams(Object.entries(o || {})
    .filter(([, v]) => v !== undefined && v !== null && v !== '')).toString();
  return s ? '?' + s : '';
};

export const quad = {
  /* ---------- session ---------------------------------------------------- */
  health: () => get('/health'),
  authStatus: () => get('/auth/status'),
  sendOtp: (phone) => post('/auth/otp/send', { phone }),
  verifyOtp: (phone, code) => post('/auth/otp/verify', { phone, code }),
  sendEmailCode: (email) => post('/auth/email/send', { email }),
  verifyEmailCode: (email, code) => post('/auth/email/verify', { email, code }),
  setContactPhone: (phone) => post('/auth/me/contact-phone', { phone }),
  logout: () => post('/auth/logout'),
  /* The provider-free sign-in path: an administrator issues the code out of
     band, so this works with no SMS gateway configured. */
  enrolAvailable: () => get('/auth/enrol/available'),
  enrol: (phone, code) => post('/auth/enrol', { phone, code }),
  me: () => get('/auth/me'),
  /* Administrator passkeys (WebAuthn). */
  passkeyLoginOptions: () => post('/auth/passkey/login/options'),
  passkeyLoginVerify: (credential) => post('/auth/passkey/login/verify', { credential }),
  passkeyReauthOptions: () => post('/auth/passkey/reauth/options'),
  passkeyReauthVerify: (credential) => post('/auth/passkey/reauth/verify', { credential }),
  passkeyStatus: () => get('/auth/passkey/status'),
  passkeyRegisterOptions: (inviteCode) => post('/auth/passkey/register/options', { inviteCode }),
  passkeyRegisterVerify: (credential, { inviteCode, label }) => post('/auth/passkey/register/verify', { credential, inviteCode, label }),
  recoveryVerify: (code) => post('/auth/recovery/verify', { code }),
  revokePasskey: (id) => post(`/auth/passkey/credentials/${id}/revoke`),
  administrators: () => get('/admin/administrators'),
  passkeyInvite: (userId) => post('/admin/passkey-invites', { userId }),

  /* ---------- administrator access (owner-managed) ------------------------ */
  accessCatalog: () => get('/admin/access/catalog'),
  accessAdmins: () => get('/admin/access/admins'),
  accessAdmin: (id) => get(`/admin/access/admins/${id}`),
  accessInvitations: () => get('/admin/access/invitations'),
  inviteAdministrator: (body) => post('/admin/access/invitations', body),
  cancelInvitation: (id) => post(`/admin/access/invitations/${id}/revoke`),
  reissueAdminInvite: (id) => post(`/admin/access/admins/${id}/invite`),
  setAdminPermissions: (id, permissions, reason) => put(`/admin/access/admins/${id}/permissions`, { permissions, reason }),
  suspendAdmin: (id, reason) => post(`/admin/access/admins/${id}/suspend`, { reason }),
  restoreAdmin: (id, reason) => post(`/admin/access/admins/${id}/restore`, { reason }),
  revokeAdmin: (id, reason) => post(`/admin/access/admins/${id}/revoke`, { reason }),
  revokeAdminSessions: (id, reason) => post(`/admin/access/admins/${id}/sessions/revoke`, { reason }),
  confirmLocation: (id, confirmation) => post(`/campus/nodes/${id}/confirm`, { confirmation }),

  /* ---------- catalog ---------------------------------------------------- */
  vendors: (opts) => get('/vendors' + qs(opts)),
  menu: (vendorId) => get(`/vendors/${vendorId}/menu`),
  searchMenu: (q, opts) => get('/menu/search' + qs({ q, ...opts })),
  createVendor: (data) => post('/vendors', data),
  updateVendor: (id, patchBody) => patch(`/vendors/${id}`, patchBody),
  createItem: (vendorId, data) => post(`/vendors/${vendorId}/menu`, data),
  updateItem: (id, patchBody) => patch(`/menu/${id}`, patchBody),
  priceHistory: (id) => get(`/menu/${id}/price-history`),

  /* ---------- campus ----------------------------------------------------- */
  campusChildren: (parent, opts = {}) => get('/campus/destinations' + qs({ parent, ...opts })),
  campusTree: (campusId) => get('/campus/tree' + qs({ campusId })),
  boundaries: (campusId) => get(`/admin/campuses/${campusId}/boundaries`),
  proposeBoundary: (campusId, data) => post(`/admin/campuses/${campusId}/boundaries`, data),
  activateBoundary: (id, confirmation) => post(`/admin/boundaries/${id}/activate`, { confirmation }),
  retireBoundary: (id) => post(`/admin/boundaries/${id}/retire`),
  campusSearch: (q) => get('/campus/search' + qs({ q })),
  campusResolve: (text) => post('/campus/resolve', { text }),
  /* Real browser geolocation. The coordinate is only ever a claim; the
     server decides whether it is inside campus and what it is near. */
  locate: () => new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('This browser cannot share location'));
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve(post('/campus/locate', {
        lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy })),
      (err) => reject(new Error(
        err.code === err.PERMISSION_DENIED ? 'Location permission was denied'
        : err.code === err.POSITION_UNAVAILABLE ? 'Your location is unavailable'
        : 'Timed out finding your location')),
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 30_000 });
  }),
  campusZones: (campusId) => get('/campus/zones' + qs({ campusId })),
  createLocation: (data) => post('/campus/nodes', data),
  updateLocation: (id, patchBody) => patch(`/campus/nodes/${id}`, patchBody),
  archiveLocation: (id) => post(`/campus/nodes/${id}/archive`),
  boundary: () => get('/campus/boundary'),
  setBoundary: (data) => put('/campus/boundary', data),

  /* ---------- ordering --------------------------------------------------- */
  draft: (data) => post('/orders/draft', data),
  orders: (opts) => get('/orders' + qs(opts)),
  order: (id) => get(`/orders/${id}`),
  transition: (id, to, note) => post(`/orders/${id}/transition`, { to, note }),
  review: (data) => post('/reviews', data),
  reviews: (opts) => get('/reviews' + qs(opts)),

  /* ---------- payment ----------------------------------------------------
     There is no cash path. `intent` throws a configuration error when no
     gateway is connected, and the checkout screen must show that rather
     than offering an alternative that does not exist. */
  paymentIntent: (orderId) => post('/payments/intent', { orderId }),
  paymentStatus: (orderId) => get('/payments/status' + qs({ orderId })),
  cancelPayment: (orderId) => post('/payments/cancel', { orderId }),

  /* ---------- verification ----------------------------------------------- */
  submitId: (formData) => call('POST', '/verification/submit', formData),
  myVerification: () => get('/verification/me'),
  linkEmailSend: (email) => post('/verification/email/send', { email }),
  linkEmailVerify: (email, code) => post('/verification/email/verify', { email, code }),
  requestManualVerification: (body) => post('/verification/manual', body),

  /* ---------- partner ---------------------------------------------------- */
  partnerApply: (note) => post('/partner/apply', { note }),
  partnerLeave: () => post('/partner/leave'),
  partnerOnline: (online) => post('/partner/online', { online }),
  offers: () => get('/partner/offers'),
  acceptOffer: (id) => post(`/partner/offers/${id}/accept`),
  handoffCode: (orderId) => get(`/orders/${orderId}/handoff-code`),
  /* The partner confirms collection with the counter's code — the only route
     to picked_up (a plain transition is refused by the server). */
  pickupCode: (orderId) => get(`/orders/${orderId}/pickup-code`),
  pickupWithCode: (orderId, code) => post(`/orders/${orderId}/pickup`, { code }),
  handoff: (orderId, code) => post(`/orders/${orderId}/handoff`, { code }),
  earnings: () => get('/partner/earnings'),
  partnerPolicy: () => get('/partner/policy'),
  partnerApplyWithConsent: (acceptPolicyId) => post('/partner/apply', { acceptPolicyId }),
  uploadPartnerPhoto: (file) => {
    const fd = new FormData();
    fd.append('photo', file);
    return call('POST', '/partner/photo', fd);
  },
  myPartnerPhotoUrl: () => `${API_BASE}/partner/photo/me`,
  orderPartnerPhotoUrl: (path) => path ? `${API_BASE}${path}` : null,
  deposit: () => get('/partner/deposit'),
  disputeDeduction: (id, text) => post(`/partner/deductions/${id}/dispute`, { text }),
  requestDepositRefund: () => post('/partner/deposit/refund-request'),
  partnerRating: () => get('/partner/rating'),

  /* ---------- profile, campus, incidents, reviews ------------------------ */
  campuses: () => get('/campuses'),
  profile: () => get('/me/profile'),
  saveProfile: (data) => put('/me/profile', data),
  reportIncident: (orderId, category, description) => post(`/orders/${orderId}/incidents`, { category, description }),
  orderIncidents: (orderId) => get(`/orders/${orderId}/incidents`),
  reportReview: (id, reason) => post(`/reviews/${id}/report`, { reason }),

  /* ---------- admin ------------------------------------------------------ */
  users: (q2) => get('/admin/users' + qs({ q: q2 })),
  user: (id) => get(`/admin/users/${id}`),
  grantRole: (data) => post('/admin/users/role', data),
  revokeRole: (data) => post('/admin/users/role/revoke', data),
  setUserStatus: (id, status) => post(`/admin/users/${id}/status`, { status }),
  verificationQueue: (state) => get('/admin/verification' + qs({ state })),
  decideVerification: (id, decision, note) =>
    post(`/admin/verification/${id}/decide`, { decision, note }),
  setStudentVerification: (userId, action, note) =>
    post(`/admin/users/${userId}/student-verification`, { action, note }),
  verificationImage:(id, which) => `${API_BASE}/admin/verification/${id}/image/${which}`,
  partners: (status) => get('/admin/partners' + qs({ status })),
  decidePartner: (userId, decision) => post(`/admin/partners/${userId}/decide`, { decision }),
  flags: () => get('/admin/flags'),
  setFlag: (key, enabled) => put(`/admin/flags/${key}`, { enabled }),
  setConfig: (key, value) => put(`/admin/config/${key}`, { value }),
  audit: (action) => get('/admin/audit' + qs({ action })),
  /* Issuing returns the plaintext code ONCE, for the admin to read aloud. */
  issueEnrolment: (userId) => post(`/admin/users/${userId}/enrolment`),
  enrolmentStatus: (userId) => get(`/admin/users/${userId}/enrolment`),
  revokeEnrolment: (userId) => post(`/admin/users/${userId}/enrolment/revoke`),

  /* ---------- finance and settlement --------------------------------------
     Every one of these is scoped on the server. `vendorFinance` returns 403
     for a cafeteria that is not the caller's, and `earnings` reads the
     session's own id — there is no parameter that widens either. */
  financeSummary: (opts) => get('/admin/finance/summary' + qs(opts)),
  financeCafeterias: () => get('/admin/finance/cafeterias'),
  financePartners: () => get('/admin/finance/partners'),
  financeOrder: (id) => get(`/admin/finance/orders/${id}`),
  financeLedger: (kind) => get('/admin/finance/ledger' + qs({ kind })),
  pricing: () => get('/admin/pricing'),
  setPricing: (data) => put('/admin/pricing', data),
  payouts: (state) => get('/admin/payouts' + qs({ state })),
  reconciliation: () => get('/admin/finance/reconciliation'),
  reconcileNow: (body) => post('/admin/finance/reconciliation/import', body || {}),
  resolveReconException: (id, note) =>
    post(`/admin/finance/reconciliation/exceptions/${id}/resolve`, { note }),
  buildPayoutBatch: (data) => post('/admin/payouts/batches', data),
  executePayout: (id) => post(`/admin/payouts/${id}/execute`),
  /* Records a transfer the administrator actually made, with its UTR. There
     is deliberately no "mark as paid" without one. */
  recordPayout: (id, reference) => post(`/admin/payouts/${id}/record`, { reference }),
  cancelPayout: (id, reason) => post(`/admin/payouts/${id}/cancel`, { reason }),
  payoutDestination: (data) => put('/admin/payouts/destination', data),
  adjustment: (data) => post('/admin/finance/adjustments', data),
  vendorFinance: (id) => get(`/vendors/${id}/finance`),
  /* The settlement review workflow: built (by the schedule) → reviewed →
     approved → released. Only `releaseBatch` can move money, and only when a
     payout provider is connected; otherwise it returns the transfers to make
     by hand and marks nothing paid. */
  payoutBatch: (id) => get(`/admin/payouts/batches/${id}`),
  approveBatch: (id) => post(`/admin/payouts/batches/${id}/approve`),
  releaseBatch: (id) => post(`/admin/payouts/batches/${id}/release`),
  retryPayout: (id) => post(`/admin/payouts/${id}/retry`),
  settlementSchedule: () => get('/admin/settlement/schedule'),
  setSettlementSchedule: (data) => put('/admin/settlement/schedule', data),
  runSettlement: () => post('/admin/settlement/run'),

  /* ---------- support, notifications, refunds ----------------------------- */
  notifications: (unread) => get('/notifications' + qs({ unread })),
  markRead: (id) => post('/notifications/read', { id }),
  createSupport: (data) => post('/support/cases', data),
  supportCases: (state) => get('/support/cases' + qs({ state })),
  supportCase: (id) => get(`/support/cases/${id}`),
  supportReply: (id, body) => post(`/support/cases/${id}/messages`, { body }),
  supportState: (id, state) => post(`/support/cases/${id}/state`, { state }),
  vendorContact: (id) => get(`/vendors/${id}/contact`),
  refund: (orderId, reason, amountPaise) => post('/refunds', { orderId, reason, amountPaise }),
  refunds: () => get('/admin/refunds'),
  hideReview: (id, hidden, reason) => post(`/admin/reviews/${id}/hide`, { hidden, reason }),
  adminReviews: (filter) => get('/admin/reviews' + qs({ filter })),
  resolveReviewReport: (id, resolution) => post(`/admin/review-reports/${id}/resolve`, { resolution }),
  adminCampuses: () => get('/admin/campuses'),
  setCampus: (id, data) => patch(`/admin/campuses/${id}`, data),
  incidents: (state) => get('/admin/incidents' + qs({ state })),
  investigateIncident: (id) => post(`/admin/incidents/${id}/investigate`),
  resolveIncident: (id, outcome, note) => post(`/admin/incidents/${id}/resolve`, { outcome, note }),
  deductions: (state) => get('/admin/deductions' + qs({ state })),
  proposeDeduction: (data) => post('/admin/deductions', data),
  reviewDeduction: (id, decision, note) => post(`/admin/deductions/${id}/review`, { decision, note }),
  applyDeduction: (id) => post(`/admin/deductions/${id}/apply`),
  withdrawDeduction: (id, note) => post(`/admin/deductions/${id}/withdraw`, { note }),
  partnerDeposit: (userId) => get(`/admin/partners/${userId}/deposit`),
  recordDeposit: (userId, data) => post(`/admin/partners/${userId}/deposit/receipts`, data),
  setDepositPolicy: (data) => put('/admin/partner-deposit-policy', data),
  depositRefunds: (state) => get('/admin/deposit-refunds' + qs({ state })),
  payDepositRefund: (id, data) => post(`/admin/deposit-refunds/${id}/pay`, data),
  rejectDepositRefund: (id, note) => post(`/admin/deposit-refunds/${id}/reject`, { note }),
  adminPartnerPhotoUrl: (userId) => `${API_BASE}/admin/partners/${userId}/photo`,

  /* ---------- images ------------------------------------------------------
     A real multipart upload. The server validates magic bytes, size and
     dimensions, and returns an asset id the caller attaches to a row. */
  uploadPhoto: (file, kind) => {
    const fd = new FormData();
    fd.append('kind', kind);
    fd.append('photo', file);
    return call('POST', '/assets', fd);
  },
  assetUrl: (id) => id ? `${API_BASE}/assets/${id}` : null,

  /* ---------- assistant --------------------------------------------------- */
  aiStatus: () => get('/ai/status'),
  aiChat: (messages) => post('/ai/chat', { messages }),
};

/* Money formatting in one place, from integer paise. No surface divides by
   100 on its own, and no float ever holds a price. */
export const rupees = (paise) =>
  paise == null ? '—' : `₹${(paise / 100).toFixed(paise % 100 ? 2 : 0)}`;

/* The single place "no ratings" is decided, so no surface can invent a 4.8. */
export const ratingLabel = (rating) =>
  !rating || !rating.count
    ? { text: 'No ratings yet', empty: true }
    : { text: `${rating.average.toFixed(1)}`, count: rating.count, empty: false };
