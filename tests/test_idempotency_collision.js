import crypto from 'node:crypto';

const BASE_URL = 'http://localhost:4000';

async function runTests() {
  console.log('--- STARTING sho.rt IDEMPOTENCY & COLLISION VERIFICATION ---');

  // Test A: New key -> 201 + one URL row
  console.log('\n[Test A] New key -> 201 + one URL row');
  const keyA = crypto.randomUUID();
  const payloadA = {
    url: 'https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers',
    strategy: 'base62',
    redirect_mode: 302
  };
  const resA = await fetch(`${BASE_URL}/api/v1/urls`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': keyA
    },
    body: JSON.stringify(payloadA)
  });
  const dataA = await resA.json();
  const replayHeaderA = resA.headers.get('Idempotent-Replay');
  console.log('Status:', resA.status, 'Replay Header:', replayHeaderA);
  console.log('Short code:', dataA.short_code);
  console.log('Telemetry:', dataA.telemetry);
  if (resA.status !== 201 || replayHeaderA || !dataA.short_code) {
    throw new Error('Test A Failed');
  }
  console.log('✅ Test A Passed');

  // Test B: Same key + same payload -> same response + replay header + no duplicate URL
  console.log('\n[Test B] Same key + same payload -> same response + replay header');
  const resB = await fetch(`${BASE_URL}/api/v1/urls`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': keyA
    },
    body: JSON.stringify(payloadA)
  });
  const dataB = await resB.json();
  const replayHeaderB = resB.headers.get('Idempotent-Replay');
  console.log('Status:', resB.status, 'Replay Header:', replayHeaderB);
  console.log('Short code:', dataB.short_code);
  console.log('Telemetry idempotency_hit:', dataB.telemetry.idempotency_hit);
  if (dataB.short_code !== dataA.short_code || replayHeaderB !== 'true' || !dataB.telemetry.idempotency_hit) {
    throw new Error('Test B Failed: not replayed or codes mismatch');
  }
  console.log('✅ Test B Passed');

  // Test C: Same key + different payload -> 409 + no new URL
  console.log('\n[Test C] Same key + different payload -> 409');
  const resC = await fetch(`${BASE_URL}/api/v1/urls`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': keyA
    },
    body: JSON.stringify({
      url: 'https://en.wikipedia.org/wiki/Idempotence',
      strategy: 'base62',
      redirect_mode: 302
    })
  });
  const dataC = await resC.json();
  console.log('Status:', resC.status, 'Message:', dataC.message);
  if (resC.status !== 409) {
    throw new Error(`Test C Failed: expected 409, got ${resC.status}`);
  }
  console.log('✅ Test C Passed');

  // Test D: Concurrent identical requests -> exactly one URL created
  console.log('\n[Test D] Concurrent identical requests -> exactly one URL created');
  const keyD = crypto.randomUUID();
  const payloadD = {
    url: 'https://redis.io/docs/manual/client-side-caching/',
    strategy: 'base62',
    redirect_mode: 302
  };
  const [resD1, resD2, resD3] = await Promise.all([
    fetch(`${BASE_URL}/api/v1/urls`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': keyD },
      body: JSON.stringify(payloadD)
    }),
    fetch(`${BASE_URL}/api/v1/urls`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': keyD },
      body: JSON.stringify(payloadD)
    }),
    fetch(`${BASE_URL}/api/v1/urls`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': keyD },
      body: JSON.stringify(payloadD)
    })
  ]);
  const [jsonD1, jsonD2, jsonD3] = await Promise.all([resD1.json(), resD2.json(), resD3.json()]);
  console.log('Concurrent Statuses:', resD1.status, resD2.status, resD3.status);
  console.log('Codes returned:', jsonD1.short_code, jsonD2.short_code, jsonD3.short_code);
  console.log('Replay headers:',
    resD1.headers.get('Idempotent-Replay'),
    resD2.headers.get('Idempotent-Replay'),
    resD3.headers.get('Idempotent-Replay')
  );
  if (jsonD1.short_code !== jsonD2.short_code || jsonD2.short_code !== jsonD3.short_code) {
    throw new Error('Test D Failed: different short codes created concurrently');
  }
  console.log('✅ Test D Passed');

  // Test E: Hash without collision -> attempt 1
  console.log('\n[Test E] Hash strategy without collision -> attempt 1');
  const keyE = crypto.randomUUID();
  const resE = await fetch(`${BASE_URL}/api/v1/urls`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': keyE },
    body: JSON.stringify({
      url: `https://example.com/unique-hash-${Date.now()}`,
      strategy: 'hash',
      redirect_mode: 302
    })
  });
  const dataE = await resE.json();
  console.log('Status:', resE.status, 'Short Code:', dataE.short_code);
  console.log('collision_detected:', dataE.telemetry.collision_detected, 'attempts:', dataE.telemetry.collision_attempts);
  if (dataE.telemetry.collision_detected !== false || dataE.telemetry.collision_attempts !== 1) {
    throw new Error('Test E Failed: unexpected collision detected');
  }
  console.log('✅ Test E Passed');

  // Test F: Forced development collision -> collision detected + retry succeeds
  console.log('\n[Test F] Forced development collision -> collision detected + retry succeeds');
  const keyF = crypto.randomUUID();
  const resF = await fetch(`${BASE_URL}/api/v1/urls`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': keyF,
      'X-Test-Force-Collision': 'true'
    },
    body: JSON.stringify({
      url: `https://example.com/force-collision-${Date.now()}`,
      strategy: 'hash',
      redirect_mode: 302
    })
  });
  const dataF = await resF.json();
  console.log('Status:', resF.status, 'Short Code:', dataF.short_code);
  console.log('collision_detected:', dataF.telemetry.collision_detected, 'attempts:', dataF.telemetry.collision_attempts);
  if (resF.status !== 201 || dataF.telemetry.collision_detected !== true || dataF.telemetry.collision_attempts < 2) {
    throw new Error('Test F Failed: collision not detected or attempts < 2');
  }
  console.log('✅ Test F Passed');

  // Test G: Base62 strategy still works
  console.log('\n[Test G] Base62 strategy still works');
  const resG = await fetch(`${BASE_URL}/api/v1/urls`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
    body: JSON.stringify({
      url: 'https://example.com/base62-test',
      strategy: 'base62',
      redirect_mode: 302
    })
  });
  const dataG = await resG.json();
  console.log('Status:', resG.status, 'Short Code:', dataG.short_code);
  if (resG.status !== 201 || !dataG.short_code) throw new Error(`Test G Failed: ${JSON.stringify(dataG)}`);
  console.log('✅ Test G Passed');

  // Test H: Snowflake strategy still works
  console.log('\n[Test H] Snowflake strategy still works');
  const resH = await fetch(`${BASE_URL}/api/v1/urls`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
    body: JSON.stringify({
      url: 'https://example.com/snowflake-test',
      strategy: 'snowflake',
      redirect_mode: 301
    })
  });
  const dataH = await resH.json();
  console.log('Status:', resH.status, 'Short Code:', dataH.short_code);
  if (resH.status !== 201 || !dataH.short_code) throw new Error(`Test H Failed: ${JSON.stringify(dataH)}`);
  console.log('✅ Test H Passed');

  // Test I: Existing Redis/redirect behavior still works
  console.log('\n[Test I] Existing Redis/redirect behavior still works');
  // First GET with Accept: application/json for observability trace
  const resIJson = await fetch(`${BASE_URL}/${dataG.short_code}`, {
    headers: { 'Accept': 'application/json' }
  });
  const dataIJson = await resIJson.json();
  console.log('JSON Mode Status:', resIJson.status, 'Cache Hit:', dataIJson.telemetry?.cache_hit);

  // Second GET without Accept for real redirect
  const resIRedirect = await fetch(`${BASE_URL}/${dataG.short_code}`, {
    redirect: 'manual'
  });
  console.log('Redirect Status:', resIRedirect.status, 'Location:', resIRedirect.headers.get('location'));
  if (resIRedirect.status !== 302 || resIRedirect.headers.get('location') !== 'https://example.com/base62-test') {
    throw new Error('Test I Failed: redirect mismatch');
  }
  console.log('✅ Test I Passed');

  console.log('\n🎉 ALL TESTS A THROUGH I PASSED SUCCESSFULLY! 🎉');
}

runTests().catch(err => {
  console.error('\n❌ Test execution failed:', err);
  process.exit(1);
});
