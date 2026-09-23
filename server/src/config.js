/* ==========================================================================
   QUAD — SERVER CONFIGURATION

   Every external dependency is declared here with an explicit `configured`
   flag. Nothing in this codebase pretends a provider is connected when it
   is not: a route whose provider is unconfigured returns 503 with a
   machine-readable `configuration_required` code, and the surfaces render a
   truthful unavailable state. There is no fallback that fakes success.
   ========================================================================== */
const env = (k, d) => (process.env[k] ?? d);
const bool = (k, d = false) => {
  const v = process.env[k];
  if (v === undefined) return d;
  return v === '1' || String(v).toLowerCase() === 'true';
};

export const PLATFORM = {
  name: 'Quad',
  legal: 'Quad Campus Commerce',
  tagline: 'Food from your campus, brought to you on it',
};

export const HTTP = {
  port: Number(env('PORT', 8080)),
  host: env('HOST', '0.0.0.0'),
  origin: env('WEB_ORIGIN', 'http://localhost:3000'),
  cookieSecret: env('COOKIE_SECRET'),
  secureCookies: bool('SECURE_COOKIES', process.env.NODE_ENV === 'production'),
};

export const DB = {
  url: env('DATABASE_URL'),
  poolMax: Number(env('PG_POOL_MAX', 10)),
  idleTimeoutMs: Number(env('PG_IDLE_TIMEOUT_MS', 30_000)),
  connectTimeoutMs: Number(env('PG_CONNECT_TIMEOUT_MS', 10_000)),
  statementTimeoutMs: Number(env('PG_STATEMENT_TIMEOUT_MS', 15_000)),

  /* Managed Postgres almost always requires TLS. `PGSSLMODE=require` is the
     usual switch; `no-verify` is offered because several providers present
     certificates signed by their own CA, and refusing to connect at all is
     worse than connecting without chain verification. Local development
     over a unix socket or localhost needs none of this. */
  get ssl() {
    const mode = env('PGSSLMODE', '').toLowerCase();
    if (mode === 'disable' || mode === '') {
      /* Honour a sslmode already embedded in the URL. */
      return /[?&]sslmode=(require|verify-full|verify-ca)/.test(this.url || '')
        ? { rejectUnauthorized: true } : false;
    }
    if (mode === 'no-verify') return { rejectUnauthorized: false };
    const ca = env('PGSSLROOTCERT_PEM');
    return ca ? { rejectUnauthorized: true, ca } : { rejectUnauthorized: true };
  },

  get configured() { return !!this.url; },

  /* A local embedded/dev database must never be mistaken for production. */
  get looksLocal() {
    return /(^|@)(localhost|127\.0\.0\.1|\[::1\])(:|\/)/.test(this.url || '');
  },
};

/* ---------- OTP ----------------------------------------------------------
   `provider: null` means no SMS gateway is connected. sendOtp() then throws
   ProviderUnavailable — it does NOT log a code to the console and pretend
   delivery, and it does NOT accept a fixed code such as 123456.           */
export const OTP = {
  provider: env('OTP_PROVIDER', null),
  /* Overridable so a deployment can route through its own egress proxy, and
     so the adapter's request construction can be tested against a local
     stub instead of billing a real SMS. Defaults to the real provider. */
  twilioBase: env('TWILIO_BASE_URL', 'https://api.twilio.com'),
  msg91Base: env('MSG91_BASE_URL', 'https://control.msg91.com'),
  ttlSeconds: Number(env('OTP_TTL_SECONDS', 300)),
  length: 6,
  maxAttempts: Number(env('OTP_MAX_ATTEMPTS', 5)),
  resendCooldownSeconds: Number(env('OTP_RESEND_COOLDOWN', 45)),
  maxSendsPerHour: Number(env('OTP_MAX_SENDS_PER_HOUR', 6)),
  /* Only numbers starting with one of these may be sent a code. A campus
     product has no reason to text abroad, and an open allowlist is how SMS
     toll fraud ("pumping") drains a provider balance. Comma-separated. */
  allowedPrefixes: String(env('OTP_ALLOWED_PREFIXES', '+91'))
    .split(',').map((s) => s.trim()).filter(Boolean),
  /* The SMS body for providers that take free text (Twilio). In India this
     must match a DLT-registered template character for character, so it is
     configuration, not code. {code} and {minutes} are substituted. */
  smsText: env('OTP_SMS_TEXT',
    '{code} is your ECHO ECHO verification code. It expires in {minutes} minutes. Do not share it.'),
  twilio: {
    accountSid: env('TWILIO_ACCOUNT_SID'),
    authToken: env('TWILIO_AUTH_TOKEN'),
    from: env('TWILIO_FROM'),
    /* Alternative to a single From number (Twilio Messaging Service). Twilio
       Verify is NOT supported on purpose: it would make Twilio, not this
       server, the party that decides whether a code is correct. */
    messagingServiceSid: env('TWILIO_MESSAGING_SERVICE_SID'),
  },
  msg91: {
    authKey: env('MSG91_AUTH_KEY'),
    templateId: env('MSG91_TEMPLATE_ID'),
    sender: env('MSG91_SENDER'),
    /* The variable name used in the DLT template for the code, e.g. ##otp##. */
    otpVar: env('MSG91_OTP_VAR', 'otp'),
  },
  get configured() {
    if (this.provider === 'twilio') {
      return !!(this.twilio.accountSid && this.twilio.authToken &&
                (this.twilio.from || this.twilio.messagingServiceSid));
    }
    if (this.provider === 'msg91') return !!(this.msg91.authKey && this.msg91.templateId);
    return false;
  },
};

export const SESSION = {
  ttlMinutes: Number(env('SESSION_TTL_MINUTES', 720)),
  cookieName: 'quad_session',
};

/* ---------- per-IP rate limits -------------------------------------------
   Deliberately generous, because on a campus every student shares a handful
   of NAT addresses: a tight per-IP limit on the login endpoints would lock
   out the whole university the moment a lecture ended.

   These exist only to blunt crude enumeration. The limits that actually
   protect an account are per-identity and live in the database — the OTP
   service's per-phone hourly cap and attempt ceiling, and the enrolment
   code's own attempt ceiling — and none of those can be diluted by an
   attacker rotating IP addresses.                                          */
export const RATE_LIMITS = {
  otpSend: Number(env('RL_OTP_SEND', 120)),
  otpVerify: Number(env('RL_OTP_VERIFY', 240)),
  emailSend: Number(env('RL_EMAIL_SEND', 120)),
  emailVerify: Number(env('RL_EMAIL_VERIFY', 240)),
  enrol: Number(env('RL_ENROL', 120)),
  /* Administrator sign-in is not a campus-wide endpoint — a handful of
     people use it — so this one can be genuinely tight. The limit that
     actually protects the account is the per-credential lock-out in
     services/admin-auth.js, which no IP rotation can dilute. */
  adminLogin: Number(env('RL_ADMIN_LOGIN', 20)),
  ai: Number(env('RL_AI', 30)),
  windowMinutes: Number(env('RL_WINDOW_MINUTES', 10)),
};

/* ---------- payments -----------------------------------------------------
   Cash on delivery does not exist in this product. If no gateway is
   configured, checkout returns 503 and no order is ever created.

   Two collection providers are supported and the choice is a deployment
   decision, not a rewrite: services/payment-providers.js holds one adapter
   each and nothing outside that file names a gateway. Cashfree is the
   recommended one for the pilot (see docs/PAYMENTS-PROVIDER.md); Razorpay
   remains fully supported so a stalled KYC at either provider is a config
   change rather than an outage.

   `webhookMaxSkewSeconds` is the replay window for a signed webhook whose
   provider timestamps its signature (Cashfree does; Razorpay does not).
   Outside it the delivery is refused even when the signature is perfect,
   because a captured-and-replayed body is otherwise valid forever.        */
export const PAYMENTS = {
  provider: env('PAYMENT_PROVIDER', null),          // 'cashfree' | 'razorpay' | null
  currency: 'INR',
  webhookMaxSkewSeconds: Number(env('PAYMENT_WEBHOOK_MAX_SKEW_SECONDS', 300)),
  /* How far back the daily settlement reconciliation re-reads. A rolling
     window rather than "yesterday", because settlement lands days after
     capture and a provider may restate a report. Re-reading a day that is
     already reconciled costs nothing: every line is refused by its unique
     index and no fee is applied twice. */
  reconLookbackDays: Number(env('RECON_LOOKBACK_DAYS', 7)),
  /* Overridable for the same reasons as the SMS base URL: an egress proxy in
     production, and a local stub when verifying request construction.
     Production refuses any non-https value (see the boot guard below). */
  apiBase: env('RAZORPAY_BASE_URL', 'https://api.razorpay.com'),
  cashfreeBase: env('CASHFREE_PG_BASE_URL', 'https://api.cashfree.com'),
  razorpay: {
    keyId: env('RAZORPAY_KEY_ID'),
    keySecret: env('RAZORPAY_KEY_SECRET'),
    webhookSecret: env('RAZORPAY_WEBHOOK_SECRET'),
  },
  /* Cashfree PG signs its webhooks with the SAME secret key that
     authenticates the API, so there is no separate webhook secret to set —
     and no way to configure collection without also being able to verify a
     webhook, which is the mistake worth designing out. */
  cashfree: {
    appId: env('CASHFREE_PG_APP_ID'),
    secretKey: env('CASHFREE_PG_SECRET_KEY'),
    apiVersion: env('CASHFREE_PG_API_VERSION', '2026-01-01'),
    returnUrl: env('CASHFREE_PG_RETURN_URL'),
  },
  get configured() {
    if (this.provider === 'razorpay') {
      return !!(this.razorpay.keyId && this.razorpay.keySecret && this.razorpay.webhookSecret);
    }
    if (this.provider === 'cashfree') {
      return !!(this.cashfree.appId && this.cashfree.secretKey);
    }
    return false;
  },
  /* What the browser is allowed to know. A key id is public by design; a
     secret key never appears here, and nothing in this object is sent to a
     client except through this getter. */
  get publicConfig() {
    if (this.provider === 'razorpay') return { keyId: this.razorpay.keyId };
    if (this.provider === 'cashfree') {
      return { appId: this.cashfree.appId, mode: this.cashfreeBase.includes('sandbox') ? 'sandbox' : 'production' };
    }
    return {};
  },
};

/* ---------- payouts / settlement -----------------------------------------
   Collecting a customer's money and paying cafeterias and delivery partners
   are two different products, and a standard Razorpay account only does the
   first. Money lands in ONE Quad account; nothing about that arrangement
   splits it. The split is Quad's own ledger (services/ledger.js), and the
   disbursement is a separate outbound transfer.

   Two mechanisms are supported, and neither invents a bank transfer:

     razorpayx             — RazorpayX Payouts. Requires a RazorpayX current
                             account and API credentials, and each payee must
                             be provisioned there as a contact + fund account
                             whose ids are stored in payout_destination.
     manual_bank_transfer  — always available. An administrator makes the
                             transfer themselves and records its bank
                             reference (UTR). The ledger moves only when that
                             reference is supplied.

   With no provider configured, the payout routes still work through the
   manual path; they never claim a transfer happened on their own.          */
export const PAYOUTS = {
  provider: env('PAYOUT_PROVIDER', null),          // 'razorpayx' | 'cashfree' | null
  apiBase: env('RAZORPAYX_BASE_URL', 'https://api.razorpay.com'),
  cashfreeBase: env('CASHFREE_PAYOUT_BASE_URL', 'https://api.cashfree.com'),
  cashfree: {
    /* Cashfree Payouts authenticates with a client id/secret pair rather
       than a basic-auth key, and identifies a payee by a beneficiary id
       provisioned in their dashboard. As with RazorpayX, Quad stores only
       the opaque id — never a bank account number. */
    clientId: env('CASHFREE_PAYOUT_CLIENT_ID'),
    clientSecret: env('CASHFREE_PAYOUT_CLIENT_SECRET'),
    mode: env('CASHFREE_PAYOUT_MODE', 'imps'),     // imps | neft | upi
    apiVersion: env('CASHFREE_PAYOUT_API_VERSION', '2024-01-01'),
  },
  razorpayx: {
    /* The RazorpayX current account the money leaves from. Not the same
       thing as the Razorpay key that collects payments, even though the
       API credentials may be shared. */
    accountNumber: env('RAZORPAYX_ACCOUNT_NUMBER'),
    keyId: env('RAZORPAYX_KEY_ID') || env('RAZORPAY_KEY_ID'),
    keySecret: env('RAZORPAYX_KEY_SECRET') || env('RAZORPAY_KEY_SECRET'),
    mode: env('RAZORPAYX_MODE', 'IMPS'),           // IMPS | NEFT | RTGS | UPI
  },
  get configured() {
    if (this.provider === 'razorpayx') {
      return !!(this.razorpayx.accountNumber && this.razorpayx.keyId && this.razorpayx.keySecret);
    }
    if (this.provider === 'cashfree' || this.provider === 'cashfree_payouts') {
      return !!(this.cashfree.clientId && this.cashfree.clientSecret);
    }
    return false;
  },
  /* The value written to payout.method when this provider settles one. */
  get method() {
    if (this.provider === 'razorpayx') return 'razorpayx';
    if (this.provider === 'cashfree' || this.provider === 'cashfree_payouts') return 'cashfree_payouts';
    return null;
  },
  /* Recording a transfer an administrator actually made is always possible,
     and is the honest fallback while the provider is being provisioned. */
  get manualAvailable() { return true; },
};

/* ---------- object storage (ID card images, food photos) ----------------- */
export const STORAGE = {
  provider: env('STORAGE_PROVIDER', 'local'),
  localDir: env('STORAGE_LOCAL_DIR', './var/uploads'),
  maxBytes: Number(env('UPLOAD_MAX_BYTES', 8 * 1024 * 1024)),
  allowedMime: ['image/jpeg', 'image/png', 'image/webp'],
  s3: {
    bucket: env('S3_BUCKET'), region: env('S3_REGION'), endpoint: env('S3_ENDPOINT'),
    accessKeyId: env('S3_ACCESS_KEY_ID'), secretAccessKey: env('S3_SECRET_ACCESS_KEY'),
  },
  get configured() {
    if (this.provider === 's3') return !!(this.s3.bucket && this.s3.accessKeyId && this.s3.secretAccessKey);
    return true;
  },
  get productionReady() { return this.provider === 's3' && this.configured; },
};

/* ---------- OCR / document verification ---------------------------------- */
export const OCR = {
  provider: env('OCR_PROVIDER', null),
  gcv: { apiKey: env('GCV_API_KEY') },
  get configured() {
    if (this.provider === 'gcv') return !!this.gcv.apiKey;
    return false;
  },
};

/* ---------- college roster / SSO ----------------------------------------
   The authoritative cross-check for student identity. No public UPES API
   is known to exist; this stays unconfigured until the university supplies
   a roster export or an SSO endpoint.                                     */
export const ROSTER = {
  provider: env('ROSTER_PROVIDER', null),
  csvPath: env('ROSTER_CSV_PATH'),
  apiUrl: env('ROSTER_API_URL'),
  apiKey: env('ROSTER_API_KEY'),
  get configured() {
    if (this.provider === 'csv') return !!this.csvPath;
    if (this.provider === 'api') return !!(this.apiUrl && this.apiKey);
    return false;
  },
};

/* ---------- notifications ------------------------------------------------
   SMS reuses the OTP gateway. Email is separate. Push is not implemented.
   Nothing here fakes delivery: see services/notify.js.                    */
export const NOTIFY = {
  email: {
    /* 'resend' needs a DNS-verified domain before it will deliver to anyone
       but its own account holder. 'brevo' delivers to any recipient from a
       single verified sender address, so it works without owning a domain. */
    provider: env('EMAIL_PROVIDER', null),        // 'resend' | 'brevo' | null
    apiKey: env('EMAIL_PROVIDER') === 'brevo' ? env('BREVO_API_KEY') : env('RESEND_API_KEY'),
    from: env('EMAIL_FROM'),
    /* Overridable for an egress proxy and for a local stub in tests, like
       the SMS and payment base URLs. Production refuses non-https. */
    resendBase: env('RESEND_BASE_URL', 'https://api.resend.com'),
    brevoBase: env('BREVO_BASE_URL', 'https://api.brevo.com'),
    /* Stay below the provider's free quota: Resend Free is 100/day and
       3,000/month; Brevo Free is 300/day with no separate monthly cap. */
    dailyBudget: Number(env('EMAIL_DAILY_BUDGET', env('EMAIL_PROVIDER') === 'brevo' ? 290 : 95)),
    monthlyBudget: Number(env('EMAIL_MONTHLY_BUDGET', env('EMAIL_PROVIDER') === 'brevo' ? 8700 : 2900)),
    reserveForAdmin: Number(env('EMAIL_ADMIN_RESERVE', 5)),
    get configured() {
      return ['resend', 'brevo'].includes(this.provider) && !!(this.apiKey && this.from);
    },
  },
};

/* ---------- student verification by institutional mailbox ----------------
   A code sent to an address on the university's STUDENT mail domain proves
   control of a mailbox the university issued. Only exact domains on this
   list are accepted — no subdomains, no lookalikes, no personal mail.

   `emailRequiresAdminReview`: when false (the default), proving the mailbox
   makes the student VERIFIED. When true, it opens an admin review case
   instead. See docs/STUDENT-VERIFICATION.md for why the default is false. */
export const STUDENT_EMAIL = {
  domains: String(env('STUDENT_EMAIL_DOMAINS') || 'stu.upes.ac.in')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
  emailRequiresAdminReview: bool('STUDENT_EMAIL_REQUIRES_ADMIN_REVIEW', false),
  /* 0 = off. When set, a student whose VERIFIED status rests on mailbox proof
     must prove the mailbox again once that proof is older than this many days
     before ordering. Mitigates mailboxes that outlive enrolment only if the
     university deactivates them - see docs/STUDENT-VERIFICATION.md. */
  reverifyDays: Number(env('STUDENT_EMAIL_REVERIFY_DAYS', 0)),
  ttlSeconds: Number(env('EMAIL_CODE_TTL_SECONDS', 600)),
  length: 6,
  maxAttempts: Number(env('EMAIL_CODE_MAX_ATTEMPTS', 5)),
  resendCooldownSeconds: Number(env('EMAIL_CODE_RESEND_COOLDOWN', 60)),
  maxSendsPerHour: Number(env('EMAIL_CODE_MAX_SENDS_PER_HOUR', 5)),
  maxSendsPerDay: Number(env('EMAIL_CODE_MAX_SENDS_PER_DAY', 12)),
  maxSendsPerIpHour: Number(env('EMAIL_CODE_MAX_SENDS_PER_IP_HOUR', 30)),
  get configured() { return NOTIFY.email.configured && this.domains.length > 0; },
};

/* ---------- data retention -----------------------------------------------
   ID-card images are deleted this many days after a case is decided. */
export const RETENTION = {
  idImageDays: Number(env('ID_IMAGE_RETENTION_DAYS', 90)),
};

/* ---------- AI ordering assistant ---------------------------------------- */
export const AI = {
  provider: env('AI_PROVIDER', null),
  model: env('AI_MODEL', 'claude-sonnet-5'),
  apiKey: env('ANTHROPIC_API_KEY'),
  maxTurns: Number(env('AI_MAX_TURNS', 8)),
  get configured() { return this.provider === 'anthropic' && !!this.apiKey; },
};

/* ---------- platform owner ----------------------------------------------
   Identified by phone number, because every login in this product is a
   phone OTP login. Set on the server only. Migration grants this number
   `platform_owner`; nothing in any client can grant that role, and no
   admin can grant it to themselves.                                       */
export const PLATFORM_OWNER = {
  phone: env('PLATFORM_OWNER_PHONE') || null,
  /* The owner may instead be identified by a verified institutional email.
     The role is granted when that mailbox is proven by the email-code flow;
     nothing else can grant it. */
  email: String(env('PLATFORM_OWNER_EMAIL') || '').trim().toLowerCase() || null,
  name: env('PLATFORM_OWNER_NAME', 'Platform Owner'),
  get phoneValid() { return !!this.phone && /^\+[1-9]\d{7,14}$/.test(this.phone); },
  get emailValid() { return !!this.email && /^[a-z0-9._-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(this.email); },
  get configured() { return this.phoneValid || this.emailValid; },
};

/* ---------- administrators and passkeys ----------------------------------
   PLATFORM_ADMIN_EMAILS: further administrators, by verified institutional
   email. Being listed grants `platform_admin` once the mailbox is proven.
   It does NOT grant the ability to act: every administrator power needs a
   passkey-verified session (below), and the first passkey needs a one-time
   invite issued from the server's shell or by the platform owner. */
export const ADMIN = {
  emails: String(env('PLATFORM_ADMIN_EMAILS', '')).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
  get passkeyRequired() {
    const v = process.env.ADMIN_PASSKEY_REQUIRED;
    if (v === undefined || v === '') return process.env.NODE_ENV !== 'test';
    return v === '1' || v.toLowerCase() === 'true';
  },
  reauthMinutes: Number(env('ADMIN_REAUTH_MINUTES', 10)),
  inviteTtlHours: Number(env('ADMIN_PASSKEY_INVITE_TTL_HOURS', 24)),
};

/* ---------- administrator sign-in ----------------------------------------
   Email + password + a code from an authenticator app. All three are
   verified on this server: TOTP is computed locally from a shared secret
   (RFC 6238), so there is no provider to configure and no provider that can
   be missing. The only piece of environment it needs is a key to encrypt
   the stored secrets with, and COOKIE_SECRET is an acceptable source for a
   deployment that has not set a dedicated one. */
export const ADMIN_AUTH = {
  totpKey: env('ADMIN_TOTP_KEY') || null,
  totpIssuer: env('ADMIN_TOTP_ISSUER', 'ECHO ECHO Campus Control'),
  totpPeriodSeconds: Number(env('ADMIN_TOTP_PERIOD_SECONDS', 30)),
  /* Steps of clock drift tolerated either way. 1 = ±30 seconds, which is
     what every authenticator app assumes. */
  totpWindow: Number(env('ADMIN_TOTP_WINDOW', 1)),
  maxAttempts: Number(env('ADMIN_LOGIN_MAX_ATTEMPTS', 5)),
  lockMinutes: Number(env('ADMIN_LOGIN_LOCK_MINUTES', 15)),
  /* How long an administrator session lasts. Shorter than a student's,
     because it can change money and permissions. */
  sessionMinutes: Number(env('ADMIN_SESSION_MINUTES', 480)),
  /* How long the gap between the password screen and the authenticator
     screen may be. Long enough to open the app and read a code, short enough
     that a proven password left on a walked-away-from browser goes stale. */
  loginChallengeSeconds: Number(env('ADMIN_LOGIN_CHALLENGE_SECONDS', 300)),
  /* A verified email code buys this long to actually choose a new password. */
  resetTokenMinutes: Number(env('ADMIN_RESET_TOKEN_MINUTES', 15)),
  get configured() {
    const material = this.totpKey || HTTP.cookieSecret;
    return !!material && material.length >= 32;
  },
};

export const WEBAUTHN = {
  get rpId() {
    const explicit = env('WEBAUTHN_RP_ID');
    if (explicit) return explicit;
    try { return new URL(HTTP.origin.split(',')[0].trim()).hostname; } catch { return 'localhost'; }
  },
  rpName: env('WEBAUTHN_RP_NAME', 'ECHO ECHO Campus Control'),
  get origins() {
    return String(env('WEBAUTHN_ORIGINS') || HTTP.origin).split(',').map((s) => s.trim()).filter(Boolean);
  },
  challengeTtlSeconds: 300,
};

/* ---------- feature flags ------------------------------------------------
   Defaults are DERIVED from whether the provider is actually configured, so
   a flag can never advertise a capability the deployment cannot perform.
   Admins may turn a flag OFF; turning one ON past an unconfigured provider
   is rejected by the flags route.                                         */
export const FLAG_DEFAULTS = {
  auth: true,
  ai_ordering: AI.configured,
  online_payment: PAYMENTS.configured,
  delivery: true,
  student_verification: true,
  partner_onboarding: true,
  live_location: true,
};

/* Which provider must be configured before a flag may be enabled. */
export const FLAG_REQUIRES = {
  ai_ordering: () => AI.configured,
  online_payment: () => PAYMENTS.configured,
};

export function providerStatus() {
  return {
    database: { provider: 'postgres', configured: DB.configured },
    otp: { provider: OTP.provider, configured: OTP.configured },
    payments: { provider: PAYMENTS.provider, configured: PAYMENTS.configured },
    /* Named separately from `payments` because collecting and disbursing are
       different products with different eligibility, and conflating them is
       exactly the mistake that makes a marketplace think its gateway is
       paying its vendors. */
    payouts: { provider: PAYOUTS.provider, configured: PAYOUTS.configured,
               manualAvailable: PAYOUTS.manualAvailable },
    storage: { provider: STORAGE.provider, configured: STORAGE.configured, productionReady: STORAGE.productionReady },
    ocr: { provider: OCR.provider, configured: OCR.configured },
    roster: { provider: ROSTER.provider, configured: ROSTER.configured },
    ai: { provider: AI.provider, configured: AI.configured },
    email: { provider: NOTIFY.email.provider, configured: NOTIFY.email.configured },
    student_email: { configured: STUDENT_EMAIL.configured, domains: STUDENT_EMAIL.domains,
                     requiresAdminReview: STUDENT_EMAIL.emailRequiresAdminReview },
    push: { provider: null, configured: false },
    platform_owner: { configured: PLATFORM_OWNER.configured },
    admin_passkeys: { required: ADMIN.passkeyRequired, rpId: WEBAUTHN.rpId, configured: true },
  };
}

/* Boot guard. Refuses to start in a state that would silently misbehave. */
export function assertBootable() {
  const fatal = [];
  const warnProd = [];
  if (!DB.configured) fatal.push('DATABASE_URL is not set.');
  if (!PLATFORM_OWNER.configured) {
    fatal.push('No platform owner: set PLATFORM_OWNER_EMAIL (institutional email) or PLATFORM_OWNER_PHONE (E.164). Refusing to start without one.');
  }
  if (PLATFORM_OWNER.email && !PLATFORM_OWNER.emailValid) fatal.push('PLATFORM_OWNER_EMAIL is not a valid email address.');
  if (process.env.NODE_ENV === 'production') {
    /* A local database in production almost always means someone shipped
       with the dev connection string still in place. */
    if (DB.looksLocal) {
      fatal.push('DATABASE_URL points at localhost in production. Use the managed database URL.');
    }
    if (!DB.ssl && !/[?&]sslmode=/.test(DB.url || '')) {
      fatal.push('TLS to the database is not configured. Set PGSSLMODE=require (or no-verify ' +
                 'if your provider uses a private CA).');
    }
    /* Base-URL overrides exist for egress proxies and for pointing an
       adapter at a local stub in tests. A stub must never be reachable
       from a production deployment. */
    for (const [name, value] of [['TWILIO_BASE_URL', OTP.twilioBase],
                                 ['MSG91_BASE_URL', OTP.msg91Base],
                                 ['RAZORPAY_BASE_URL', PAYMENTS.apiBase],
                                 ['CASHFREE_PG_BASE_URL', PAYMENTS.cashfreeBase],
                                 ['RAZORPAYX_BASE_URL', PAYOUTS.apiBase],
                                 ['CASHFREE_PAYOUT_BASE_URL', PAYOUTS.cashfreeBase],
                                 ['RESEND_BASE_URL', NOTIFY.email.resendBase],
                                 ['BREVO_BASE_URL', NOTIFY.email.brevoBase],
                                 ...(STORAGE.s3.endpoint ? [['S3_ENDPOINT', STORAGE.s3.endpoint]] : [])]) {
      if (!/^https:\/\//.test(value)) {
        fatal.push(`${name} must be an https URL in production (got "${value}").`);
      }
    }
    /* Production refuses anything that would make the product lie or leak.
       These are the items on the readiness gate that can be checked at boot. */
    if (!HTTP.cookieSecret || HTTP.cookieSecret.length < 32) {
      fatal.push('COOKIE_SECRET must be set to at least 32 random characters in production.');
    }
    if (!HTTP.secureCookies) fatal.push('SECURE_COOKIES must be true in production (HTTPS only).');
    /* Students need SOME way in. Institutional email (zero-cost) or SMS OTP
       both qualify; staff always have enrolment codes, which need nothing. */
    if (!OTP.configured && !STUDENT_EMAIL.configured) {
      fatal.push('Production requires a student sign-in provider — set EMAIL_PROVIDER ' +
                 '(institutional email verification) or an OTP provider. No student could sign in.');
    }
    if (!PAYMENTS.configured) {
      /* Deploying before payment KYC is a legitimate stage, but it must be a
         stated decision, not an accident: without the acknowledgement the
         server still refuses to start. With it, checkout stays honestly
         unavailable (503) and /ready reports it. */
      if (bool('PAYMENTS_DEFERRED')) {
        warnProd.push('PAYMENTS_DEFERRED=true: no payment provider is configured, so no order can be placed. Remove this once the gateway is live.');
      } else {
        fatal.push('Production requires a configured payment provider — no order could be placed. ' +
                   'To deploy before payment KYC, set PAYMENTS_DEFERRED=true to acknowledge that ordering is unavailable.');
      }
    }
    if (PAYMENTS.configured && bool('PAYMENTS_DEFERRED')) {
      warnProd.push('PAYMENTS_DEFERRED is still set although a payment provider is configured; remove it.');
    }
    if (!STORAGE.productionReady) fatal.push('Production requires S3-compatible storage (STORAGE_PROVIDER=s3).');
    if (HTTP.origin.includes('localhost')) fatal.push('WEB_ORIGIN still points at localhost.');
    if (HTTP.origin.split(',').some((o) => !/^https:\/\//.test(o.trim()))) {
      fatal.push('Every WEB_ORIGIN must be https in production.');
    }
    if (!ADMIN.passkeyRequired) {
      fatal.push('ADMIN_PASSKEY_REQUIRED cannot be disabled in production: administrator powers require a passkey.');
    }
    if (!process.env.WEBAUTHN_RP_ID) {
      fatal.push('WEBAUTHN_RP_ID must be set in production (the registrable domain administrators sign in on, e.g. echoecho.in).');
    } else if (!WEBAUTHN.origins.every((o) => { try { const h = new URL(o).hostname; return h === WEBAUTHN.rpId || h.endsWith('.' + WEBAUTHN.rpId); } catch { return false; } })) {
      fatal.push('Every WEBAUTHN_ORIGINS entry must be on WEBAUTHN_RP_ID or a subdomain of it.');
    }
    if (process.env.TRUST_PROXY !== 'true') {
      warnProd.push('TRUST_PROXY is not true. Behind a load balancer every request shares one IP, which collapses per-IP rate limits and audit IPs.');
    }
  }
  if (fatal.length) return { ok: false, fatal };
  const warn = [...warnProd];
  if (!STUDENT_EMAIL.configured) {
    warn.push('No email provider configured — students cannot sign in or verify with their ' +
              'institutional email. POST /auth/email/send returns 503.');
  }
  if (!OTP.configured) warn.push('No OTP provider configured — phone sign-in is unavailable (institutional email and enrolment codes are unaffected).');
  if (!PAYMENTS.configured) warn.push('No payment provider configured — checkout returns 503 and no order can be placed.');
  if (!AI.configured) warn.push('No AI provider configured — the ordering assistant is unavailable.');
  if (!PAYOUTS.configured) {
    warn.push('No payout provider configured — cafeteria and partner settlements must be ' +
              'transferred by an administrator and recorded with their bank reference. ' +
              'The ledger tracks what is owed either way.');
  }
  if (!OCR.configured) warn.push('No OCR provider — ID submissions go straight to manual admin review.');
  if (!ROSTER.configured) warn.push('No college roster source — roster cross-check is skipped and flagged on every case.');
  if (!STORAGE.productionReady) warn.push('Storage is local disk — not suitable for production.');
  if (!NOTIFY.email.configured) warn.push('No email provider — email notifications record as unsent.');
  return { ok: true, warn };
}
