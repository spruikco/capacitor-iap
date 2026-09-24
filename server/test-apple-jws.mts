/**
 * Regression tests for the Apple StoreKit 2 JWS verifier (src/apple-jws.ts).
 *
 *   npx tsx test-apple-jws.mts
 *
 * Exits non-zero on failure, so it can be wired into CI next to
 * `check:schema` and the end-of-season smoke test.
 *
 * ── Why these tests and not others ──────────────────────────────────────────
 * This file is the only thing standing between a forged payload and free
 * credits, so the tests here are deliberately the ATTACKS, not the happy path.
 * The happy path cannot be tested offline (it needs a payload signed by
 * Apple's private key) and is exercised by a real sandbox purchase from
 * TestFlight instead.
 *
 * Writing these found two real bugs that would each have shipped:
 *   • createPublicKey() wrapped around an already-public KeyObject, which
 *     throws — every genuine purchase would have failed verification.
 *   • A wrong-length signature threw a raw crypto error instead of rejecting
 *     cleanly, turning a hostile request into a 500.
 *
 * Test 4 is the important one: it uses Apple's real (self-signed) root, so root
 * pinning, the chain links, the CA flag and the validity window ALL pass. It is
 * rejected solely because the leaf lacks Apple's App Store signing OID. That
 * check exists because chaining to Apple's root proves almost nothing on its
 * own: Apple's root sits above intermediates that issue end-entity certificates
 * to any developer, so without it an attacker could sign their own payload with
 * a legitimately-issued Apple certificate and mint credits at will.
 */
import { X509Certificate, createSign, generateKeyPairSync } from 'node:crypto';

// Explicit .ts extension so this runs BOTH under tsx and under plain
// `node --experimental-strip-types`, which needs no node_modules at all. That
// lets CI gate the payment path in seconds without an npm install.
import { AppleJwsError, verifyAppleJws } from './src/apple-jws.ts';

/** Apple Root CA - G3, the certificate the verifier pins. */
const APPLE_ROOT_B64 =
  'MIICQzCCAcmgAwIBAgIILcX8iNLFS5UwCgYIKoZIzj0EAwMwZzEbMBkGA1UEAwwSQXBwbGUgUm9vdCBDQSAtIEczMSYwJAYDVQQLDB1BcHBsZSBDZXJ0aWZpY2F0aW9uIEF1dGhvcml0eTETMBEGA1UECgwKQXBwbGUgSW5jLjELMAkGA1UEBhMCVVMwHhcNMTQwNDMwMTgxOTA2WhcNMzkwNDMwMTgxOTA2WjBnMRswGQYDVQQDDBJBcHBsZSBSb290IENBIC0gRzMxJjAkBgNVBAsMHUFwcGxlIENlcnRpZmljYXRpb24gQXV0aG9yaXR5MRMwEQYDVQQKDApBcHBsZSBJbmMuMQswCQYDVQQGEwJVUzB2MBAGByqGSM49AgEGBSuBBAAiA2IABJjpLz1AcqTtkyJygRMc3RCV8cWjTnHcFBbZDuWmBSp3ZHtfTjjTuxxEtX/1H7YyYl3J6YRbTzBPEVoA/VhYDKX1DyxNB0cTddqXl5dvMVztK517IDvYuVTZXpmkOlEKMaNCMEAwHQYDVR0OBBYEFLuw3qFYM4iapIqZ3r6966/ayySrMA8GA1UdEwEB/wQFMAMBAf8wDgYDVR0PAQH/BAQDAgEGMAoGCCqGSM49BAMDA2gAMGUCMQCD6cHEFl4aXTQY2e3v9GwOAEZLuN+yRhHFD/3meoyhpmvOwgPUnPWTxnS4at+qIxUCMG1mihDK1A3UT82NQz60imOlM27jbdoXt2QfyFMm+YhidDkLF1vLUagM6BgD56KyKA==';

/**
 * GlobalSign Root CA — any real, valid, self-signed root that is NOT Apple's.
 * Stands in for "the attacker brought their own perfectly good CA".
 */
const FOREIGN_ROOT_B64 =
  'MIIDdTCCAl2gAwIBAgILBAAAAAABFUtaw5QwDQYJKoZIhvcNAQEFBQAwVzELMAkGA1UEBhMCQkUxGTAXBgNVBAoTEEdsb2JhbFNpZ24gbnYtc2ExEDAOBgNVBAsTB1Jvb3QgQ0ExGzAZBgNVBAMTEkdsb2JhbFNpZ24gUm9vdCBDQTAeFw05ODA5MDExMjAwMDBaFw0yODAxMjgxMjAwMDBaMFcxCzAJBgNVBAYTAkJFMRkwFwYDVQQKExBHbG9iYWxTaWduIG52LXNhMRAwDgYDVQQLEwdSb290IENBMRswGQYDVQQDExJHbG9iYWxTaWduIFJvb3QgQ0EwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQDaDuaZjc6j40+Kfvvxi4Mla+pIH/EqsLmVEQS98GPR4mdmzxzdzxtIK+6NiY6arymAZavpxy0Sy6scTHAHoT0KMM0VjU/43dSMUBUc71DuxC73/OlS8pF94G3VNTCOXkNz8kHp1Wrjsok6Vjk4bwY8iGlbKk3Fp1S4bInMm/k8yuX9ifUSPJJ4ltbcdG6TRGHRjcdGsnUOhugZitVtbNV4FpWi6cgKOOvyJBNPc1STE4U6G7weNLWLBYy5d4ux2x8gkasJU26Qzns3dLlwR5EiUWMWea6xrkEmCMgZK9FGqkjWZCrXgzT/LCrBbBlDSgeF59N89iFo7+ryUp9/k5DPAgMBAAGjQjBAMA4GA1UdDwEB/wQEAwIBBjAPBgNVHRMBAf8EBTADAQH/MB0GA1UdDgQWBBRge2YaRQ2XyolQL30EzTSo//z9SzANBgkqhkiG9w0BAQUFAAOCAQEA1nPnfE920I2/7LqivjTFKDK1fPxsnCwrvQmeU79rXqoRSLblCKOzyj1hTdNGCbM+w6DjY1Ub8rrvrTnhQ7k4o+YviiY776BQVvnGCv04zcQLcFGUl5gE38NflNUVyRRBnMRddWQVDf9VMOyGj/8N7yy5Y0b2qvzfvGn9LhJIZJrglfCm7ymPAbEVtQwdpf5pLGkkeB6zpxxxYu7KyJesF12KwvhHhm4qxFYxldBniYUr+WymXUadDKqC5JlR3XC321Y9YeRq4VzW9v493kHMB65jUr9TU/Qr6cf9tveCX4XSQRjbgbMEHMUfpIBvFSDJ3gyICh3WZlXi/EjJKSZp4A==';

const b64u = (b: Buffer | string) =>
  Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });

function forgeJws(header: object, payload: object): string {
  const h = b64u(JSON.stringify(header));
  const p = b64u(JSON.stringify(payload));
  const signer = createSign('SHA256');
  signer.update(`${h}.${p}`);
  signer.end();
  return `${h}.${p}.${b64u(signer.sign({ key: privateKey, dsaEncoding: 'ieee-p1363' }))}`;
}

let failures = 0;

function mustReject(name: string, jws: string, expectFragment: string) {
  try {
    verifyAppleJws(jws);
    failures++;
    console.error(`FAIL  ${name}\n      ACCEPTED a payload that must have been rejected.`);
  } catch (err) {
    const message = err instanceof AppleJwsError ? err.message : `${err}`;
    if (!(err instanceof AppleJwsError)) {
      failures++;
      console.error(`FAIL  ${name}\n      rejected, but with ${message} instead of AppleJwsError.`);
      return;
    }
    if (!message.toLowerCase().includes(expectFragment.toLowerCase())) {
      failures++;
      console.error(`FAIL  ${name}\n      expected "${expectFragment}", got "${message}".`);
      return;
    }
    console.log(`pass  ${name}`);
  }
}

// Sanity: the pinned root really is self-signed, so test 4 means what it says.
const appleRoot = new X509Certificate(Buffer.from(APPLE_ROOT_B64, 'base64'));
if (!appleRoot.verify(appleRoot.publicKey)) {
  failures++;
  console.error('FAIL  pinned Apple root is not self-signed — test 4 proves nothing');
} else {
  console.log('pass  pinned Apple root is self-signed');
}

// 1. The classic JWS bypass: claim there is no signature algorithm.
mustReject('alg=none is rejected', forgeJws({ alg: 'none', x5c: [APPLE_ROOT_B64] }, { a: 1 }), 'algorithm');

// 2. No chain at all.
mustReject('missing x5c is rejected', forgeJws({ alg: 'ES256' }, { a: 1 }), 'exactly [leaf, intermediate, root]');

// 3. THE one that matters. The attacker presents a real, valid, internally
//    consistent chain that simply is not Apple's. Only root pinning stops this;
//    every other check in the verifier would happily pass it.
mustReject(
  'a valid but foreign root is rejected (root pinning)',
  forgeJws({ alg: 'ES256', x5c: [FOREIGN_ROOT_B64, FOREIGN_ROOT_B64, FOREIGN_ROOT_B64] }, { a: 1 }),
  'pinned Apple root',
);

// 4. Apple's genuine root, self-signed so root pinning, the chain links, the
//    CA flag and the validity window ALL pass. It is rejected only because the
//    leaf lacks Apple's signing OID — which is the check that stops an attacker
//    signing with a legitimately-issued Apple certificate of their own.
mustReject(
  'Apple root but leaf is not an App Store signing cert',
  forgeJws({ alg: 'ES256', x5c: [APPLE_ROOT_B64, APPLE_ROOT_B64, APPLE_ROOT_B64] }, { transactionId: '1' }),
  'not an Apple App Store signing certificate',
);

// 4b. A short chain must be refused outright rather than 'at least 2'.
mustReject(
  'a two-certificate chain is rejected',
  forgeJws({ alg: 'ES256', x5c: [APPLE_ROOT_B64, APPLE_ROOT_B64] }, { a: 1 }),
  'exactly [leaf, intermediate, root]',
);

// 5. Structural nonsense must reject cleanly rather than throw.
mustReject('malformed JWS is rejected', 'not.a.jws', 'header');
mustReject('empty JWS is rejected', '', 'empty');

if (failures > 0) {
  console.error(`\n${failures} test(s) failed.`);
  process.exit(1);
}
console.log('\nAll Apple JWS verifier tests passed.');
