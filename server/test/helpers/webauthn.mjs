/* A software platform authenticator built from Node's crypto: real P-256
   keys, real authenticatorData / attestationObject (CBOR, fmt none) and real
   ECDSA assertions. Shared by the passkey and administrator-access suites. */
import { generateKeyPairSync, createHash, sign as cryptoSign, randomBytes } from 'node:crypto';

export const ORIGIN = 'http://localhost:3000';
const b64u = (b) => Buffer.from(b).toString('base64url');

function cbor(v) {
  const head = (major, n) => n < 24 ? Buffer.from([(major << 5) | n])
    : n < 256 ? Buffer.from([(major << 5) | 24, n])
    : Buffer.from([(major << 5) | 25, n >> 8, n & 255]);
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === 'string') { const b = Buffer.from(v); return Buffer.concat([head(3, b.length), b]); }
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  if (v instanceof Map) return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)])]);
  throw new Error('cbor: unsupported');
}

export function authenticator({ rpId = 'localhost' } = {}) {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const id = randomBytes(32);
  let counter = 0;
  const rpHash = createHash('sha256').update(rpId).digest();
  const cd = (type, challenge, origin = ORIGIN) => Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  return {
    id: b64u(id),
    create(challenge, { origin, flags = 0x45 } = {}) {
      const cose = new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]]);
      const len = Buffer.alloc(2); len.writeUInt16BE(id.length);
      const authData = Buffer.concat([rpHash, Buffer.from([flags]), Buffer.alloc(4), Buffer.alloc(16), len, id, cbor(cose)]);
      const att = cbor(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]));
      return { id: b64u(id), rawId: b64u(id), type: 'public-key',
               response: { clientDataJSON: b64u(cd('webauthn.create', challenge, origin)), attestationObject: b64u(att), transports: ['internal'] } };
    },
    get(challenge, { origin, flags = 0x05, count = ++counter } = {}) {
      const c = Buffer.alloc(4); c.writeUInt32BE(count);
      const authData = Buffer.concat([rpHash, Buffer.from([flags]), c]);
      const clientData = cd('webauthn.get', challenge, origin);
      const sig = cryptoSign('sha256', Buffer.concat([authData, createHash('sha256').update(clientData).digest()]), { key: privateKey, dsaEncoding: 'der' });
      return { id: b64u(id), rawId: b64u(id), type: 'public-key',
               response: { clientDataJSON: b64u(clientData), authenticatorData: b64u(authData), signature: b64u(sig) } };
    },
  };
}

export const cookieOf = (res) => [].concat(res.headers['set-cookie'] || [])
  .find((c) => c.startsWith('quad_session='))?.split(';')[0].split('=')[1] || null;
