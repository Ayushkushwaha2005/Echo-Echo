/* ==========================================================================
   QUAD — S3-COMPATIBLE OBJECT STORAGE

   AWS SigV4 implemented directly against fetch, so there is no SDK
   dependency and the signing is inspectable. Works with AWS S3, Cloudflare
   R2, MinIO and Backblaze B2 (all speak the same signature).

   Buckets are PRIVATE. Nothing here ever produces a public URL: reads go
   through a presigned URL with a short expiry, or through the server, which
   is what lets ID-card images stay behind an authorization check.
   ========================================================================== */
import { createHmac, createHash } from 'node:crypto';
import { STORAGE } from '../config.js';

const sha256hex = (d) => createHash('sha256').update(d).digest('hex');
const hmac = (key, data) => createHmac('sha256', key).update(data).digest();

const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) =>
  '%' + c.charCodeAt(0).toString(16).toUpperCase());
const encPath = (p) => p.split('/').map(enc).join('/');

function endpointFor() {
  const { s3 } = STORAGE;
  if (s3.endpoint) return s3.endpoint.replace(/\/$/, '');
  return `https://s3.${s3.region}.amazonaws.com`;
}

/* Path-style addressing: works everywhere, including MinIO where
   virtual-host style needs DNS the operator may not control. */
const objectUrl = (key) => `${endpointFor()}/${enc(STORAGE.s3.bucket)}/${encPath(key)}`;

function signingKey(dateStamp, region, service) {
  const kDate = hmac('AWS4' + STORAGE.s3.secretAccessKey, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, 'aws4_request');
}

const stamps = () => {
  const iso = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  return { amzDate: iso, dateStamp: iso.slice(0, 8) };
};

/* ---------- authenticated request (PUT / DELETE / GET) -------------------- */
async function signedRequest(method, key, { body, contentType } = {}) {
  const { region } = STORAGE.s3;
  const { amzDate, dateStamp } = stamps();
  const url = new URL(objectUrl(key));
  const payloadHash = sha256hex(body || '');

  const headers = {
    host: url.host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  };
  if (contentType) headers['content-type'] = contentType;

  const signedHeaders = Object.keys(headers).sort().join(';');
  const canonicalHeaders = Object.keys(headers).sort()
    .map((h) => `${h}:${String(headers[h]).trim()}\n`).join('');

  const canonicalRequest = [
    method, url.pathname, '', canonicalHeaders, signedHeaders, payloadHash,
  ].join('\n');

  const scope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonicalRequest)].join('\n');
  const signature = hmac(signingKey(dateStamp, region, 's3'), stringToSign).toString('hex');

  headers.authorization =
    `AWS4-HMAC-SHA256 Credential=${STORAGE.s3.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const res = await fetch(url, { method, headers, body });
  if (!res.ok && res.status !== 404) {
    throw new Error(`s3 ${method} ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  return res;
}

export const putObject = (key, body, contentType) =>
  signedRequest('PUT', key, { body, contentType });

export const deleteObject = (key) => signedRequest('DELETE', key);

export async function getObject(key) {
  const res = await signedRequest('GET', key);
  if (res.status === 404) return null;
  return Buffer.from(await res.arrayBuffer());
}

/* ---------- presigned GET ------------------------------------------------
   A short-lived URL, used only for non-sensitive assets (food photos).
   ID-card images are never presigned — they stream through the server so
   the authorization check and the access-log entry cannot be bypassed. */
export function presignGet(key, expiresSeconds = 300) {
  const { region, accessKeyId } = STORAGE.s3;
  const { amzDate, dateStamp } = stamps();
  const url = new URL(objectUrl(key));
  const scope = `${dateStamp}/${region}/s3/aws4_request`;

  const params = new URLSearchParams({
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${accessKeyId}/${scope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(Math.min(expiresSeconds, 604800)),
    'X-Amz-SignedHeaders': 'host',
  });
  /* Query params must be sorted for the canonical request. */
  const canonicalQuery = [...params.entries()].sort(([a], [b]) => a < b ? -1 : 1)
    .map(([k, v]) => `${enc(k)}=${enc(v)}`).join('&');

  const canonicalRequest = [
    'GET', url.pathname, canonicalQuery, `host:${url.host}\n`, 'host', 'UNSIGNED-PAYLOAD',
  ].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonicalRequest)].join('\n');
  const signature = hmac(signingKey(dateStamp, region, 's3'), stringToSign).toString('hex');

  return `${url.origin}${url.pathname}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

/* Readiness probe: proves the credentials and bucket actually work rather
   than assuming they do because the variables are non-empty. */
export async function checkAccess() {
  if (!STORAGE.s3.bucket) return { ok: false, error: 'S3_BUCKET not set' };
  const key = `.quad-healthcheck/${Date.now()}`;
  try {
    await putObject(key, Buffer.from('ok'), 'text/plain');
    const got = await getObject(key);
    await deleteObject(key);
    return { ok: got?.toString() === 'ok' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
