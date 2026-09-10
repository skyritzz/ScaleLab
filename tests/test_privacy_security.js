import crypto from 'node:crypto';

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:4000';

class MockBrowser {
  constructor(name) {
    this.name = name;
    this.cookie = '';
  }

  async fetch(url, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (this.cookie) {
      headers['Cookie'] = this.cookie;
    }
    const res = await fetch(url, { ...options, headers });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) {
      const match = setCookie.match(/sho_rt_session=[^;]+/);
      if (match) {
        this.cookie = match[0];
      }
    }
    return res;
  }

  getSessionId() {
    if (!this.cookie) return null;
    const match = this.cookie.match(/sho_rt_session=([^;]+)/);
    return match ? match[1] : null;
  }
}

async function runSecurityTests() {
  console.log('================================================================');
  console.log('🔒 RUNNING sho.rt ANONYMOUS SESSION & PRIVACY SECURITY TEST SUITE');
  console.log('================================================================');

  // --------------------------------------------------------------------------
  // 1. Session Cookie Issuance & Validation
  // --------------------------------------------------------------------------
  console.log('\n[1. Session] Testing anonymous session cookie issuance...');
  const browserA = new MockBrowser('Browser A');
  const res1 = await browserA.fetch(`${BASE_URL}/api/v1/urls`);
  const setCookieHeader = res1.headers.get('set-cookie');

  console.log('Initial Set-Cookie:', setCookieHeader);
  if (!setCookieHeader || !setCookieHeader.includes('sho_rt_session=')) {
    throw new Error('Test 1 Failed: Server did not issue sho_rt_session cookie');
  }
  if (!setCookieHeader.includes('HttpOnly') || !setCookieHeader.includes('SameSite=Lax')) {
    throw new Error('Test 1 Failed: Cookie is missing HttpOnly or SameSite=Lax attributes');
  }

  const sessionA = browserA.getSessionId();
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!sessionA || !uuidRegex.test(sessionA)) {
    throw new Error(`Test 1 Failed: Session ID '${sessionA}' is not a valid UUID`);
  }
  console.log('✅ Session 1 Passed: Valid secure UUID cookie issued:', sessionA);

  // Subsequent requests retain same session
  const res2 = await browserA.fetch(`${BASE_URL}/api/v1/urls`);
  const sessionA2 = browserA.getSessionId();
  if (sessionA !== sessionA2) {
    throw new Error(`Test 2 Failed: Session changed from ${sessionA} to ${sessionA2}`);
  }
  console.log('✅ Session 2 Passed: Subsequent request retained session ID');

  // Malformed cookie generates new valid session
  const malformedBrowser = new MockBrowser('Malformed Browser');
  malformedBrowser.cookie = 'sho_rt_session=not-a-valid-uuid-attack';
  const resMalformed = await malformedBrowser.fetch(`${BASE_URL}/api/v1/urls`);
  const newSession = malformedBrowser.getSessionId();
  if (!newSession || newSession === 'not-a-valid-uuid-attack' || !uuidRegex.test(newSession)) {
    throw new Error('Test 3 Failed: Malformed cookie was not replaced by a valid random UUID');
  }
  console.log('✅ Session 3 Passed: Malformed session was safely replaced with valid UUID:', newSession);

  // --------------------------------------------------------------------------
  // 2. Ownership & Cross-Browser Privacy Isolation
  // --------------------------------------------------------------------------
  console.log('\n[2. Ownership] Testing cross-browser URL privacy boundary...');
  const secretUrl = `https://example.com/vault-${Date.now()}`;
  const browserB = new MockBrowser('Browser B');

  // Browser A creates URL X
  const createResA = await browserA.fetch(`${BASE_URL}/api/v1/urls`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: secretUrl,
      strategy: 'base62',
      redirect_mode: 302
    })
  });
  const createDataA = await createResA.json();
  const shortCodeX = createDataA.short_code;
  console.log(`Browser A created short link: /${shortCodeX} -> ${secretUrl}`);
  if (createResA.status !== 201 || !shortCodeX) {
    throw new Error(`Test 4 Failed: Browser A failed to create URL: ${JSON.stringify(createDataA)}`);
  }

  // Browser A calls GET /api/v1/urls -> X must be returned
  const historyResA = await browserA.fetch(`${BASE_URL}/api/v1/urls`);
  const historyDataA = await historyResA.json();
  const foundInA = historyDataA.data.find(r => r.short_code === shortCodeX);
  if (!foundInA) {
    throw new Error('Test 5 Failed: Browser A cannot see its own newly created URL in history');
  }
  if (foundInA.is_demo !== false || foundInA.is_owner !== true) {
    throw new Error('Test 5 Failed: Browser A record is not properly flagged as owner');
  }
  console.log('✅ Ownership 5 Passed: Browser A sees its created URL in history');

  // Browser B calls GET /api/v1/urls -> X must NOT be returned!
  const historyResB = await browserB.fetch(`${BASE_URL}/api/v1/urls`);
  const historyDataB = await historyResB.json();
  const foundInB = historyDataB.data.find(r => r.short_code === shortCodeX);
  const foundSecretInB = historyDataB.data.find(r => r.long_url === secretUrl);
  if (foundInB || foundSecretInB) {
    throw new Error('🚨 CRITICAL PRIVACY LEAK: Browser B was able to see Browser A\'s private URL in GET /api/v1/urls!');
  }
  console.log('✅ Ownership 6 Passed: Browser B DOES NOT see Browser A\'s URL in history');

  // Browser B attempts to inspect destination via Accept: application/json
  const debugResB = await browserB.fetch(`${BASE_URL}/${shortCodeX}`, {
    headers: { 'Accept': 'application/json' },
    redirect: 'manual'
  });
  console.log('Browser B JSON inspect status:', debugResB.status);
  if (debugResB.status === 200) {
    const leakedJson = await debugResB.json();
    if (leakedJson.destination) {
      throw new Error(`🚨 CRITICAL PRIVACY LEAK: Browser B retrieved private destination via Accept: application/json: ${leakedJson.destination}`);
    }
  }
  console.log('✅ Ownership 7 Passed: Browser B cannot retrieve destination via Accept: application/json inspection');

  // Browser B attempts to spoof Browser A's session using custom headers
  const spoofRes = await fetch(`${BASE_URL}/api/v1/urls`, {
    headers: {
      'X-Device-Id': sessionA,
      'X-Owner-Id': sessionA,
      'X-Client-Id': sessionA,
      'Cookie': browserB.cookie
    }
  });
  const spoofData = await spoofRes.json();
  const spoofFound = spoofData.data.find(r => r.short_code === shortCodeX);
  if (spoofFound) {
    throw new Error('🚨 CRITICAL SECURITY VULNERABILITY: Header spoofing allowed Browser B to access Browser A history!');
  }
  console.log('✅ Ownership 8 Passed: Custom ownership headers are safely ignored by the server');

  // --------------------------------------------------------------------------
  // 3. Public Redirect Verification
  // --------------------------------------------------------------------------
  console.log('\n[3. Public Redirect] Testing public redirection across sessions...');

  // Browser B visits X's short link without Browser A's cookie
  const redirectResB = await browserB.fetch(`${BASE_URL}/${shortCodeX}`, {
    redirect: 'manual'
  });
  const locationHeaderB = redirectResB.headers.get('location');
  console.log('Redirect Status for Browser B:', redirectResB.status, 'Location:', locationHeaderB);
  if (redirectResB.status !== 302 && redirectResB.status !== 301) {
    throw new Error(`Test 9 Failed: Public redirect failed with status ${redirectResB.status}`);
  }
  if (locationHeaderB !== secretUrl) {
    throw new Error(`Test 9 Failed: Location '${locationHeaderB}' does not match target '${secretUrl}'`);
  }
  console.log('✅ Public Redirect 9 Passed: Browser B successfully redirected to target URL without authentication');

  // Completely anonymous request (no cookies at all)
  const anonymousRes = await fetch(`${BASE_URL}/${shortCodeX}`, {
    redirect: 'manual'
  });
  if (anonymousRes.headers.get('location') !== secretUrl) {
    throw new Error('Test 10 Failed: Cookieless client could not resolve public redirect');
  }
  console.log('✅ Public Redirect 10 Passed: Cookieless client successfully redirected');

  // --------------------------------------------------------------------------
  // 4. Idempotency Isolation
  // --------------------------------------------------------------------------
  console.log('\n[4. Idempotency] Testing cross-session idempotency isolation...');
  const sharedKey = `shared-key-${crypto.randomUUID()}`;

  // Browser A submits with sharedKey
  const resIdempA1 = await browserA.fetch(`${BASE_URL}/api/v1/urls`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': sharedKey },
    body: JSON.stringify({
      url: 'https://example.com/unique-a',
      strategy: 'base62',
      redirect_mode: 302
    })
  });
  const dataIdempA1 = await resIdempA1.json();
  if (resIdempA1.status !== 201) throw new Error('Test 11 Failed: Browser A creation failed');

  // Browser A retries with same sharedKey and same payload -> must receive replay
  const resIdempA2 = await browserA.fetch(`${BASE_URL}/api/v1/urls`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': sharedKey },
    body: JSON.stringify({
      url: 'https://example.com/unique-a',
      strategy: 'base62',
      redirect_mode: 302
    })
  });
  const dataIdempA2 = await resIdempA2.json();
  if (dataIdempA2.short_code !== dataIdempA1.short_code || resIdempA2.headers.get('idempotent-replay') !== 'true') {
    throw new Error('Test 11 Failed: Browser A same-session idempotent retry failed to replay');
  }
  console.log('✅ Idempotency 11 Passed: Browser A correctly received idempotent replay');

  // Browser B uses SAME sharedKey with different payload -> MUST NOT get 409 conflict from A or receive A's URL!
  const resIdempB = await browserB.fetch(`${BASE_URL}/api/v1/urls`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': sharedKey },
    body: JSON.stringify({
      url: 'https://example.com/other-b',
      strategy: 'base62',
      redirect_mode: 302
    })
  });
  const dataIdempB = await resIdempB.json();
  console.log('Browser B with same key status:', resIdempB.status, 'Short code:', dataIdempB.short_code);
  if (resIdempB.status !== 201 || dataIdempB.short_code === dataIdempA1.short_code) {
    throw new Error('🚨 CRITICAL IDEMPOTENCY PRIVACY ISSUE: Browser B received Browser A\'s idempotent response or collided!');
  }
  console.log('✅ Idempotency 12 Passed: Idempotency is isolated per session. Browser B created its own URL safely');

  // --------------------------------------------------------------------------
  // 5. Demo Records & Legacy Records
  // --------------------------------------------------------------------------
  console.log('\n[5. Demo & Legacy Records] Testing demo presence and legacy exclusion...');
  const demoCodes = ['aB92x', 'k9L0z', 'm4X7w'];
  for (const code of demoCodes) {
    const inA = historyDataA.data.find(r => r.short_code === code);
    const inB = historyDataB.data.find(r => r.short_code === code);
    if (!inA || !inB) {
      throw new Error(`Test 13 Failed: Demo record '${code}' was not found in user history`);
    }
    if (inA.is_demo !== true || inB.is_demo !== true) {
      throw new Error(`Test 13 Failed: Record '${code}' is not marked as is_demo = true`);
    }
  }
  console.log('✅ Demo Records 13 Passed: Standard sample records appear with is_demo = true for all sessions');

  // --------------------------------------------------------------------------
  // 6. CORS Privacy & Credential Security
  // --------------------------------------------------------------------------
  console.log('\n[6. CORS Security] Testing CORS boundaries against credentialed scraping...');
  const maliciousOriginRes = await fetch(`${BASE_URL}/api/v1/urls`, {
    headers: {
      'Origin': 'http://evil-tracker.attacker.com',
      'Cookie': browserA.cookie
    }
  });
  const acao = maliciousOriginRes.headers.get('access-control-allow-origin');
  const acac = maliciousOriginRes.headers.get('access-control-allow-credentials');
  console.log('Malicious Origin CORS response - ACAO:', acao, 'ACAC:', acac);
  if (acao === '*' && acac === 'true') {
    throw new Error('🚨 CRITICAL CORS VULNERABILITY: Wildcard origin with credentials enabled!');
  }
  if (acao === 'http://evil-tracker.attacker.com' && acac === 'true') {
    throw new Error('🚨 CRITICAL CORS VULNERABILITY: Reflected arbitrary attacker origin with credentials!');
  }
  console.log('✅ CORS Security 14 Passed: Untrusted origins cannot scrape private history with credentials');

  console.log('\n================================================================');
  console.log('🎉 ALL 14 PRIVACY AND SECURITY TESTS PASSED PERFECTLY! 🎉');
  console.log('================================================================');
}

runSecurityTests().catch(err => {
  console.error('\n❌ Security test suite failed:', err);
  process.exit(1);
});
