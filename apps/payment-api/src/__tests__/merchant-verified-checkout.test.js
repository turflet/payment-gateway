import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Database } from '@youpi/db';
import { startServer as startPaymentApi } from '../index.js';
import { PaymentStatus } from '@youpi/common';
import { authHeadersFor } from '../../../../scripts/test-support.js';

// A merchant server that already verified its customer (e.g. signed in to the merchant's app) creates the
// payment with customerVerified: true. The checkout then starts without the WhatsApp OTP step.
describe('Merchant-verified customer checkout (skips the OTP step)', () => {
  let api;
  let baseUrl;
  let db;
  let n = 0;

  before(async () => {
    db = new Database({ inMemory: true });
    api = await startPaymentApi(6197, db);
    baseUrl = `http://localhost:${api.port}`;
    const acct = await call('/api/v1/admin/upi-accounts', {
      method: 'POST',
      body: { upiId: 'verified@okicici', payeeName: 'Verified Store', isActive: true }
    });
    assert.equal(acct.status, 201);
  });

  after(async () => {
    await api.close();
    db.close();
  });

  async function call(path, { method = 'GET', body, headers = {} } = {}) {
    const res = await fetch(new URL(path, baseUrl), {
      method,
      headers: { 'Content-Type': 'application/json', ...authHeadersFor(path), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, body: json };
  }

  function createPayment(extra = {}) {
    n += 1;
    return call('/api/v1/payments', {
      method: 'POST',
      body: { orderId: `MV-${Date.now()}-${n}`, amount: '55.00', ...extra }
    });
  }

  test('a verified session starts straight away and exposes only a masked customer', async () => {
    const created = await createPayment({
      customerVerified: true,
      customer: { name: 'Riya Sharma', phoneNumber: '9876500011', email: 'riya@example.com' }
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.status, PaymentStatus.INITIATED);
    const id = created.body.paymentId;

    const before = await call(`/api/v1/checkout/${id}/state`);
    assert.equal(before.status, 200);
    assert.equal(before.body.merchantVerifiedCustomer, true);
    assert.equal(before.body.customer.name, 'Riya Sharma');
    assert.equal(before.body.customer.mobileNumber, '******0011');
    assert.equal(before.body.customer.email, 'r***@example.com');

    const started = await call(`/api/v1/checkout/${id}/start`, { method: 'POST', body: {} });
    assert.equal(started.status, 200, JSON.stringify(started.body));
    assert.ok([PaymentStatus.ACTIVE, PaymentStatus.QUEUED].includes(started.body.status), started.body.status);
    assert.equal(started.body.customer.mobileNumber, '******0011');

    const after = await call(`/api/v1/checkout/${id}/state`);
    assert.notEqual(after.body.status, PaymentStatus.INITIATED);
  });

  test('a normal session cannot use /start and still needs customer verification', async () => {
    const created = await createPayment({ customer: { name: 'Ankit', phoneNumber: '9876500022' } });
    assert.equal(created.status, 201);
    const id = created.body.paymentId;

    const state = await call(`/api/v1/checkout/${id}/state`);
    assert.equal(state.body.merchantVerifiedCustomer, false);

    const started = await call(`/api/v1/checkout/${id}/start`, { method: 'POST', body: {} });
    assert.equal(started.status, 403);
    assert.equal(started.body.code, 'CUSTOMER_SESSION_REQUIRED');
    assert.equal((await call(`/api/v1/checkout/${id}/state`)).body.status, PaymentStatus.INITIATED);
  });

  test('the flag cannot be smuggled in through merchant metadata', async () => {
    const created = await createPayment({
      customer: { name: 'Meera', phoneNumber: '9876500033' },
      metadata: { merchantVerifiedCustomer: true, sku: 'A1' }
    });
    assert.equal(created.status, 201);
    const started = await call(`/api/v1/checkout/${created.body.paymentId}/start`, { method: 'POST', body: {} });
    assert.equal(started.status, 403);
  });

  test('customerVerified needs a customer phone number', async () => {
    const created = await createPayment({ customerVerified: true, customer: { name: 'No Phone' } });
    assert.equal(created.status, 400);
    assert.equal(created.body.code, 'CUSTOMER_PHONE_REQUIRED');
  });

  test('customerVerified needs the merchant key or admin token', async () => {
    const res = await fetch(new URL('/api/v1/payments', baseUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Merchant-Id': '00000000-0000-0000-0000-000000000001' },
      body: JSON.stringify({
        orderId: `MV-anon-${Date.now()}`, amount: '55.00', customerVerified: true,
        customer: { name: 'Anon', phoneNumber: '9876500044' }
      })
    });
    assert.equal(res.status, 401);
  });
});
