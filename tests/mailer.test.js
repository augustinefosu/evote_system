// Unit tests for the mailer (no SMTP needed).
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const mailer = require('../src/mailer');

describe('mailer', () => {
  it('reports unconfigured when SMTP_HOST is unset', () => {
    assert.equal(mailer.isConfigured(), false);
  });

  it('dev fallback resolves without throwing and includes preview content', async () => {
    const vm = mailer.verificationMail('Test User', 'tok123');
    assert.ok(vm.text.includes('tok123'));
    assert.ok(vm.html.includes('tok123'));
    const r = await mailer.sendMail('t@example.com', vm.subject, vm.text, vm.html);
    assert.equal(r.sent, false);
    assert.equal(r.reason, 'unconfigured');
  });

  it('reset mail contains token and expiry notice', () => {
    const rm = mailer.resetMail('Test User', 'abc');
    assert.ok(rm.text.includes('abc'));
    assert.match(rm.subject, /reset/i);
  });
});
