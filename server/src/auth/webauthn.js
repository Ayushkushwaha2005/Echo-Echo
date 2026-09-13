/* ==========================================================================
   QUAD - WEBAUTHN (PASSKEYS)

   A standards-based verifier for the two ceremonies, using only Node's own
   crypto. No biometric data ever reaches this server: the authenticator
   checks the fingerprint, face or PIN locally and signs with a private key
   that never leaves the device. We keep the public key.

   What is verified, every time (WebAuthn Level 2, sections 7.1 and 7.2):
     - clientDataJSON.type is the expected ceremony
     - clientDataJSON.challenge is a live, unconsumed challenge WE issued for
       this purpose (and account), consumed atomically so it cannot replay
     - clientDataJSON.origin is one of the configured origins
     - authenticatorData.rpIdHash is SHA-256 of our RP ID
     - the User Present AND User Verified flags are set (UV = biometric/PIN)
     - registration: attestation format 'none' is accepted (we do not need a
       vendor attestation to know the key belongs to the person holding the
       session that registered it); the credential public key is parsed from
       COSE and must be ES256 or RS256
     - authentication: the signature over authenticatorData || SHA-256(
       clientDataJSON) verifies with the stored public key, and the signature
       counter, when the authenticator keeps one, has advanced
   ========================================================================== */
import { createHash, createPublicKey, verify as cryptoVerify, randomBytes } from 'node:crypto';
import { BadRequest } from './rbac.js';

export const b64url = (buf) => Buffer.from(buf).toString('base64url');
export const fromB64url = (s) => Buffer.from(String(s || ''), 'base64url');
export const newChallenge = () => b64url(randomBytes(32));

/* ---------- CBOR (RFC 8949), the subset WebAuthn uses --------------------- */
export function cborDecode(buf) {
  let pos = 0;
  const need = (n) => { if (pos + n > buf.length) throw new Error('cbor: truncated'); };
  const readLen = (info) => {
    if (info < 24) return info;
    if (info === 24) { need(1); return buf[pos++]; }
    if (info === 25) { need(2); const v = buf.readUInt16BE(pos); pos += 2; return v; }
    if (info === 26) { need(4); const v = buf.readUInt32BE(pos); pos += 4; return v; }
    if (info === 27) { need(8); const v = Number(buf.readBigUInt64BE(pos)); pos += 8; return v; }
    throw new Error('cbor: indefinite lengths are not used by WebAuthn');
  };
  const item = (depth = 0) => {
    if (depth > 16) throw new Error('cbor: nesting too deep');
    need(1);
    const b = buf[pos++]; const major = b >> 5; const info = b & 31;
    switch (major) {
      case 0: return readLen(info);
      case 1: return -1 - readLen(info);
      case 2: { const n = readLen(info); need(n); const v = buf.subarray(pos, pos + n); pos += n; return v; }
      case 3: { const n = readLen(info); need(n); const v = buf.toString('utf8', pos, pos + n); pos += n; return v; }
      case 4: { const n = readLen(info); const a = []; for (let i = 0; i < n; i++) a.push(item(depth + 1)); return a; }
      case 5: { const n = readLen(info); const m = new Map(); for (let i = 0; i < n; i++) { const k = item(depth + 1); m.set(k, item(depth + 1)); } return m; }
      case 7:
        if (info === 20) return false;
        if (info === 21) return true;
        if (info === 22) return null;
        throw new Error('cbor: unsupported simple value');
      default: throw new Error('cbor: unsupported major type');
    }
  };
  const value = item();
  return { value, length: pos };
}

/* ---------- COSE public key -> Node KeyObject / JWK ------------------------ */
export function coseToJwk(cose) {
  const kty = cose.get(1), alg = cose.get(3);
  if (kty === 2 && alg === -7) {
    if (cose.get(-1) !== 1) throw BadRequest('Unsupported passkey', 'Only P-256 elliptic-curve keys are accepted.');
    const x = cose.get(-2), y = cose.get(-3);
    if (!Buffer.isBuffer(x) || !Buffer.isBuffer(y) || x.length !== 32 || y.length !== 32) throw BadRequest('Malformed passkey public key');
    return { alg: -7, jwk: { kty: 'EC', crv: 'P-256', x: b64url(x), y: b64url(y) } };
  }
  if (kty === 3 && alg === -257) {
    const n = cose.get(-1), e = cose.get(-2);
    if (!Buffer.isBuffer(n) || !Buffer.isBuffer(e) || n.length < 256) throw BadRequest('Malformed passkey public key');
    return { alg: -257, jwk: { kty: 'RSA', n: b64url(n), e: b64url(e) } };
  }
  throw BadRequest('Unsupported passkey', 'The authenticator offered a key type this server does not accept.');
}

/* ---------- authenticator data ------------------------------------------- */
export function parseAuthData(buf, { expectCredential = false } = {}) {
  if (!Buffer.isBuffer(buf) || buf.length < 37) throw BadRequest('Malformed authenticator data');
  const rpIdHash = buf.subarray(0, 32);
  const flags = buf[32];
  const signCount = buf.readUInt32BE(33);
  const out = {
    rpIdHash, signCount,
    userPresent: !!(flags & 0x01), userVerified: !!(flags & 0x04),
    backupEligible: !!(flags & 0x08), backedUp: !!(flags & 0x10),
    attested: !!(flags & 0x40),
  };
  if (expectCredential) {
    if (!out.attested || buf.length < 55) throw BadRequest('The passkey response carried no credential');
    const aaguid = buf.subarray(37, 53).toString('hex');
    const idLen = buf.readUInt16BE(53);
    if (idLen < 16 || idLen > 1023 || buf.length < 55 + idLen) throw BadRequest('Malformed credential id');
    const credentialId = buf.subarray(55, 55 + idLen);
    const { value: cose } = cborDecode(buf.subarray(55 + idLen));
    if (!(cose instanceof Map)) throw BadRequest('Malformed credential public key');
    Object.assign(out, { aaguid, credentialId, cose });
  }
  return out;
}

function checkClientData(clientDataB64, { type, origins }) {
  const raw = fromB64url(clientDataB64);
  let data;
  try { data = JSON.parse(raw.toString('utf8')); } catch { throw BadRequest('Malformed passkey response'); }
  if (data.type !== type) throw BadRequest('Unexpected passkey ceremony');
  if (!origins.includes(data.origin)) throw BadRequest('This passkey response came from an unrecognised site');
  if (typeof data.challenge !== 'string' || !data.challenge) throw BadRequest('The passkey response has no challenge');
  return { raw, data };
}

function checkRp(auth, rpId) {
  const expected = createHash('sha256').update(rpId).digest();
  if (!auth.rpIdHash.equals(expected)) throw BadRequest('This passkey belongs to a different site');
  if (!auth.userPresent) throw BadRequest('The authenticator did not confirm your presence');
  if (!auth.userVerified) {
    throw BadRequest('Use your fingerprint, face or device PIN',
      'Administrator passkeys must verify you on the device, not only detect a tap.');
  }
}

/**
 * Registration. `consumeChallenge(challenge)` must atomically consume a live
 * challenge issued for this account and return truthy, or return falsy.
 */
export async function verifyRegistration(credential, { rpId, origins, consumeChallenge }) {
  const resp = credential?.response || {};
  const { data } = checkClientData(resp.clientDataJSON, { type: 'webauthn.create', origins });
  const { value: att } = (() => {
    try { return cborDecode(fromB64url(resp.attestationObject)); } catch { throw BadRequest('Malformed passkey attestation'); }
  })();
  if (!(att instanceof Map)) throw BadRequest('Malformed passkey attestation');
  const fmt = att.get('fmt');
  /* 'none' is what browsers send when attestation: 'none' is requested. Any
     other format is still acceptable to register, because we do not rely on
     attestation; we simply do not inspect its statement. */
  if (typeof fmt !== 'string') throw BadRequest('Malformed passkey attestation');
  const auth = parseAuthData(att.get('authData'), { expectCredential: true });
  checkRp(auth, rpId);
  const { alg, jwk } = coseToJwk(auth.cose);
  createPublicKey({ key: jwk, format: 'jwk' });            // throws on an invalid key
  if (b64url(auth.credentialId) !== credential.id) throw BadRequest('Passkey id mismatch');
  if (!(await consumeChallenge(data.challenge))) throw BadRequest('This passkey request has expired', 'Start again.');
  return {
    credentialId: b64url(auth.credentialId), alg, jwk,
    signCount: auth.signCount, aaguid: auth.aaguid, backedUp: auth.backedUp,
  };
}

/**
 * Authentication. `loadCredential(credentialIdB64)` returns the stored row or
 * null; `consumeChallenge(challenge)` as above.
 */
export async function verifyAssertion(credential, { rpId, origins, loadCredential, consumeChallenge }) {
  const resp = credential?.response || {};
  const { raw, data } = checkClientData(resp.clientDataJSON, { type: 'webauthn.get', origins });
  const authBuf = fromB64url(resp.authenticatorData);
  const auth = parseAuthData(authBuf);
  checkRp(auth, rpId);
  const stored = await loadCredential(String(credential?.id || ''));
  if (!stored) throw BadRequest('This passkey is not registered for ECHO ECHO administration');
  if (stored.revoked_at) throw BadRequest('This passkey has been revoked');

  const key = createPublicKey({ key: stored.public_key_jwk, format: 'jwk' });
  const signed = Buffer.concat([authBuf, createHash('sha256').update(raw).digest()]);
  const sig = fromB64url(resp.signature);
  const ok = stored.algorithm === -7
    ? cryptoVerify('sha256', signed, { key, dsaEncoding: 'der' }, sig)
    : cryptoVerify('sha256', signed, key, sig);
  if (!ok) throw BadRequest('The passkey signature did not verify');

  /* A counter that does not advance suggests a cloned authenticator. Many
     modern passkeys always report 0; that is allowed. */
  if ((auth.signCount > 0 || Number(stored.sign_count) > 0) && auth.signCount <= Number(stored.sign_count)) {
    throw BadRequest('This passkey looks copied', 'Its signature counter went backwards. Contact the other administrator.');
  }
  if (!(await consumeChallenge(data.challenge))) throw BadRequest('This passkey request has expired', 'Start again.');
  return { stored, signCount: auth.signCount, backedUp: auth.backedUp };
}
