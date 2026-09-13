/* Server-side feature flags. A flag can be turned OFF by an admin, but it
   cannot be turned ON past an unconfigured provider — the product must not
   advertise a capability the deployment cannot perform. */
import { q, one } from '../db/index.js';
import { FLAG_DEFAULTS, FLAG_REQUIRES } from '../config.js';
import { BadRequest, ProviderUnavailable } from '../auth/rbac.js';

export async function flag(key) {
  const r = await one(`SELECT enabled FROM feature_flag WHERE key = $1`, [key]);
  const enabled = r ? r.enabled : (FLAG_DEFAULTS[key] ?? false);
  if (!enabled) return false;
  const requires = FLAG_REQUIRES[key];
  return requires ? requires() : true;    // a stale "on" row cannot fake a provider
}

export async function allFlags() {
  const { rows } = await q(`SELECT key, enabled FROM feature_flag`);
  const stored = Object.fromEntries(rows.map((r) => [r.key, r.enabled]));
  const out = {};
  for (const key of Object.keys(FLAG_DEFAULTS)) {
    const wanted = stored[key] ?? FLAG_DEFAULTS[key];
    const requires = FLAG_REQUIRES[key];
    const available = requires ? requires() : true;
    out[key] = {
      enabled: wanted && available,
      requested: wanted,
      providerConfigured: available,
      blockedBy: wanted && !available ? 'provider_not_configured' : null,
    };
  }
  return out;
}

export async function setFlag(key, enabled, actorId) {
  if (!(key in FLAG_DEFAULTS)) throw BadRequest(`Unknown feature flag "${key}"`);
  if (enabled && FLAG_REQUIRES[key] && !FLAG_REQUIRES[key]()) {
    throw ProviderUnavailable(`"${key}" cannot be enabled`,
      'Its provider is not configured on this server. Configure it first.');
  }
  await q(
    `INSERT INTO feature_flag (key, enabled, updated_by) VALUES ($1,$2,$3)
     ON CONFLICT (key) DO UPDATE SET enabled = $2, updated_by = $3, updated_at = now()`,
    [key, !!enabled, actorId]);
  return { key, enabled: !!enabled };
}
