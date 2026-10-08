const test = require('node:test');
const assert = require('node:assert/strict');
const { featureSettings } = require('../src/feature-settings');
const { createLLM } = require('../src/llm');
test('Assist selects Smart model without modifying saved mode or Say routing', () => {
  const settings = { provider: 'openai', smart: false, models: { openai: { fast: 'gpt-6.1-sol', smart: 'gpt-6.1-sol', spoken: 'gpt-6-luna' } } };
  const assist = featureSettings(settings, 'assist');
  assert.equal(assist.smart, true);
  assert.equal(settings.smart, false);
  assert.equal(createLLM(assist, { spoken: true }).model, 'gpt-6.1-sol');
  assert.equal(createLLM(featureSettings(settings, 'say'), { spoken: true }).model, 'gpt-6-luna');
});

test('Say uses Fast even when the toolbar is Smart, without changing saved settings', () => {
  const settings = { smart: true };
  assert.equal(featureSettings(settings, 'say').smart, false);
  assert.equal(settings.smart, true);
  assert.equal(featureSettings(settings, 'assist').smart, true);
  assert.equal(featureSettings(settings, 'leetcode'), settings);
});
