import { X509Certificate, createVerify } from 'node:crypto';

/**
 * Verifies StoreKit 2 signed payloads (JWS) offline.
 *
 * ── Why this replaced verifyReceipt ─────────────────────────────────────────
 * The old endpoint (`buy.itunes.apple.com/verifyReceipt`) is deprecated by
 * Apple, needs a network round-trip to Apple on every purchase, and needs a
 * shared secret in our environment. StoreKit 2 hands the client a JWS that is
 * signed by Apple, so the server can verify it with public-key cryptography
 * alone: no call to Apple, no secret, no outage of theirs blocking a purchase
 * of ours, and no request latency in the buy path.
 *
 * The same function verifies App Store Server Notifications V2, which are
 * signed exactly the same way.
 *
 * ── What "verified" actually means here ─────────────────────────────────────
 * A JWS header carries `x5c`: the certificate chain that signed it, leaf
 * first. Trusting that chain as presented would be worthless, since an
 * attacker can generate their own chain and sign whatever they like. The
 * security comes from the LAST link: we pin Apple's root certificate and
 * require the chain to terminate in exactly it. So we check, in order:
 *
 *   1. the chain's root is byte-identical to our pinned Apple root
 *   2. each certificate is genuinely signed by the next one up
 *   3. every certificate is currently within its validity window
 *   4. the payload signature verifies against the leaf's public key
 *
 * Skipping any one of these makes the whole thing decorative.
 */

/**
 * Apple Root CA - G3. Downloaded from
 * https://www.apple.com/certificateauthority/AppleRootCA-G3.cer and confirmed
 * self-signed, with SHA-256 fingerprint
 * 63:34:3A:BF:B8:9A:6A:03:EB:B5:7E:9B:3F:5F:A7:BE:7C:4F:5C:75:6F:30:17:B3:A8:C4:88:C3:65:3E:91:79
 *
 * Public certificate, so committing it is fine, and pinning it is the entire
 * basis of trust below. Valid until 2039-04-30. Inlined rather than read from
 * disk so Next.js bundling and any serverless target cannot lose the file.
 */
const APPLE_ROOT_CA_G3_PEM = `-----BEGIN CERTIFICATE-----
MIICQzCCAcmgAwIBAgIILcX8iNLFS5UwCgYIKoZIzj0EAwMwZzEbMBkGA1UEAwwS
QXBwbGUgUm9vdCBDQSAtIEczMSYwJAYDVQQLDB1BcHBsZSBDZXJ0aWZpY2F0aW9u
IEF1dGhvcml0eTETMBEGA1UECgwKQXBwbGUgSW5jLjELMAkGA1UEBhMCVVMwHhcN
MTQwNDMwMTgxOTA2WhcNMzkwNDMwMTgxOTA2WjBnMRswGQYDVQQDDBJBcHBsZSBS
b290IENBIC0gRzMxJjAkBgNVBAsMHUFwcGxlIENlcnRpZmljYXRpb24gQXV0aG9y
aXR5MRMwEQYDVQQKDApBcHBsZSBJbmMuMQswCQYDVQQGEwJVUzB2MBAGByqGSM49
AgEGBSuBBAAiA2IABJjpLz1AcqTtkyJygRMc3RCV8cWjTnHcFBbZDuWmBSp3ZHtf
TjjTuxxEtX/1H7YyYl3J6YRbTzBPEVoA/VhYDKX1DyxNB0cTddqXl5dvMVztK517
IDvYuVTZXpmkOlEKMaNCMEAwHQYDVR0OBBYEFLuw3qFYM4iapIqZ3r6966/ayySr
MA8GA1UdEwEB/wQFMAMBAf8wDgYDVR0PAQH/BAQDAgEGMAoGCCqGSM49BAMDA2gA
MGUCMQCD6cHEFl4aXTQY2e3v9GwOAEZLuN+yRhHFD/3meoyhpmvOwgPUnPWTxnS4
at+qIxUCMG1mihDK1A3UT82NQz60imOlM27jbdoXt2QfyFMm+YhidDkLF1vLUagM
6BgD56KyKA==
-----END CERTIFICATE-----`;

/**
 * DER encoding of OID 1.2.840.113635.100.6.11.1 — Apple's "App Store server
 * notification / JWS signing" certificate extension. Only certificates Apple
 * issues for signing App Store payloads carry it, which is what distinguishes
 * a genuine signer from any other certificate that merely chains to Apple's
 * root. Computed, not transcribed: 06 0a = OID tag + length, then the arcs.
 */
const APPLE_JWS_SIGNING_OID_DER = Buffer.from('060a2a864886f76364060b01', 'hex');

let cachedRoot: X509Certificate | null = null;
function appleRoot(): X509Certificate {
  if (!cachedRoot) cachedRoot = new X509Certificate(APPLE_ROOT_CA_G3_PEM);
  return cachedRoot;
}

export class AppleJwsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AppleJwsError';
  }
}

function base64UrlDecode(input: string): Buffer {
  return Buffer.from(input.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

/**
 * The decoded transaction. Apple sends numeric fields as epoch MILLISECONDS.
 * Only the fields we actually use are typed; the payload carries more.
 */
export interface AppleTransactionInfo {
  transactionId: string;
  originalTransactionId: string;
  productId: string;
  bundleId: string;
  /** 'Consumable' | 'Non-Consumable' | 'Auto-Renewable Subscription' | 'Non-Renewing Subscription' */
  type: string;
  purchaseDate: number;
  expiresDate?: number;
  /** 'Sandbox' for TestFlight and App Review; 'Production' for the live store. */
  environment: 'Sandbox' | 'Production';
  /** The UUID we stamped on at purchase time, if any. Our account attribution. */
  appAccountToken?: string;
  /** Present once refunded or revoked. A transaction with this must not grant. */
  revocationDate?: number;
  revocationReason?: number;
  quantity?: number;
}

/**
 * Verifies a JWS and returns its payload. Throws {@link AppleJwsError} on any
 * failure — a caller must treat a throw as "this purchase is not real".
 *
 * Generic because the same envelope carries transactions, renewal info, and
 * server notification bodies.
 */
export function verifyAppleJws<T = AppleTransactionInfo>(jws: string): T {
  if (typeof jws !== 'string' || jws.length === 0) {
    throw new AppleJwsError('Empty JWS');
  }

  const parts = jws.split('.');
  if (parts.length !== 3) {
    throw new AppleJwsError('Malformed JWS: expected three dot-separated parts');
  }
  const [headerB64, payloadB64, signatureB64] = parts;

  let header: { alg?: string; x5c?: string[] };
  try {
    header = JSON.parse(base64UrlDecode(headerB64).toString('utf8'));
  } catch {
    throw new AppleJwsError('Malformed JWS header');
  }

  // Apple signs with ES256. Accepting anything else — above all 'none' — would
  // let a caller hand us an unsigned payload and have it believed.
  if (header.alg !== 'ES256') {
    throw new AppleJwsError(`Unexpected JWS algorithm: ${header.alg}`);
  }

  const x5c = header.x5c;
  // Apple always sends exactly leaf -> intermediate -> root. Accepting "at
  // least 2" allowed an attacker to present a chain of any depth of their own
  // making, as long as it happened to terminate in Apple's root.
  if (!Array.isArray(x5c) || x5c.length !== 3) {
    throw new AppleJwsError(
      `JWS certificate chain must be exactly [leaf, intermediate, root]; got ${
        Array.isArray(x5c) ? x5c.length : 0
      }`,
    );
  }

  // x5c is base64 DER, leaf first, root last.
  let chain: X509Certificate[];
  try {
    chain = x5c.map((der) => new X509Certificate(Buffer.from(der, 'base64')));
  } catch {
    throw new AppleJwsError('JWS certificate chain could not be parsed');
  }

  // (1) The chain must terminate in OUR copy of Apple's root, compared by raw
  // bytes. Comparing subject strings instead would be trivially forgeable.
  const presentedRoot = chain[chain.length - 1];
  if (!presentedRoot.raw.equals(appleRoot().raw)) {
    throw new AppleJwsError('JWS chain does not terminate in the pinned Apple root CA');
  }

  // (2) Every certificate must be signed by the next one up.
  for (let i = 0; i < chain.length - 1; i++) {
    if (!chain[i].verify(chain[i + 1].publicKey)) {
      throw new AppleJwsError(`JWS chain broken: certificate ${i} is not signed by certificate ${i + 1}`);
    }
  }

  // (2b) IDENTITY, not just chain shape. Steps 1 and 2 prove "some certificate
  // under Apple's root signed this" — which is far weaker than it sounds.
  // Apple's root sits above intermediates that issue end-entity certificates to
  // anyone with a developer account, so without these two checks an attacker
  // could sign their own transaction payload with a legitimately-issued Apple
  // leaf and mint credits indefinitely.
  //
  // The intermediate must actually be a CA...
  if (!chain[1].ca) {
    throw new AppleJwsError('JWS chain intermediate is not a CA certificate');
  }
  // ...and the leaf must carry Apple's App Store JWS/receipt signing extension.
  // Node's X509Certificate exposes no extension accessor, so this scans the DER
  // for the encoded OID, which is what the extension's presence looks like on
  // the wire. A certificate issued for any other purpose does not carry it.
  if (!chain[0].raw.includes(APPLE_JWS_SIGNING_OID_DER)) {
    throw new AppleJwsError(
      'JWS leaf certificate is not an Apple App Store signing certificate ' +
        '(missing OID 1.2.840.113635.100.6.11.1)',
    );
  }

  // (3) Validity window. An expired Apple intermediate is far more likely to
  // mean a stale chain than an attack, but either way it must not verify.
  const now = Date.now();
  for (const cert of chain) {
    if (now < Date.parse(cert.validFrom) || now > Date.parse(cert.validTo)) {
      throw new AppleJwsError(`JWS chain contains a certificate outside its validity window (${cert.subject})`);
    }
  }

  // (4) The payload signature itself, against the leaf.
  //
  // JWS ES256 signatures are raw r||s (64 bytes). Node's verifier defaults to
  // DER-encoded ECDSA, so without `dsaEncoding: 'ieee-p1363'` every genuine
  // signature fails — which looks exactly like "all purchases are fraudulent".
  const verifier = createVerify('SHA256');
  verifier.update(`${headerB64}.${payloadB64}`);
  verifier.end();

  // `chain[0].publicKey` is ALREADY a public KeyObject. Wrapping it in
  // createPublicKey() throws ERR_CRYPTO_INVALID_KEY_OBJECT_TYPE, because that
  // function derives a public key from a PRIVATE one. Caught by the forged
  // signature test — otherwise it would have failed every real purchase.
  // Node throws (rather than returning false) when the signature is the wrong
  // length for the key's curve, so an attacker sending a P-256 signature for a
  // P-384 key would otherwise surface as an uncaught 500 instead of a clean
  // rejection. Any failure here means the same thing: not a real purchase.
  let ok = false;
  try {
    ok = verifier.verify(
      { key: chain[0].publicKey, dsaEncoding: 'ieee-p1363' },
      base64UrlDecode(signatureB64),
    );
  } catch {
    ok = false;
  }
  if (!ok) {
    throw new AppleJwsError('JWS signature does not verify against the leaf certificate');
  }

  try {
    return JSON.parse(base64UrlDecode(payloadB64).toString('utf8')) as T;
  } catch {
    throw new AppleJwsError('JWS payload is not valid JSON');
  }
}

/** Shape of an App Store Server Notification V2 body (itself a JWS payload). */
export interface AppleNotificationPayload {
  notificationType: string;
  subtype?: string;
  notificationUUID: string;
  data?: {
    bundleId?: string;
    environment?: 'Sandbox' | 'Production';
    /** Nested JWS — verify separately with verifyAppleJws. */
    signedTransactionInfo?: string;
    signedRenewalInfo?: string;
  };
  version?: string;
  signedDate?: number;
}
