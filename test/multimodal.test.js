const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { createLLM } = require('../src/llm');
const originalLoad = Module._load;
const originalFetch = global.fetch;
let captured;
class OpenAIStub {
  constructor() { this.chat = { completions: { create: async request => { captured = request; return [{ choices: [{ delta: { content: 'ok' } }] }]; } } }; }
}
OpenAIStub.AzureOpenAI = OpenAIStub;
Module._load = function(request, parent, isMain) {
  if (request === 'openai') return OpenAIStub;
  if (request === '@anthropic-ai/sdk') return class { constructor() { this.messages = { create: async request => { captured = request; return []; } }; } };
  if (request === '@google/genai') return { GoogleGenAI: class { constructor() { this.models = { generateContentStream: async request => { captured = request; return []; } }; } } };
  return originalLoad.call(this, request, parent, isMain);
};
test.after(() => { Module._load = originalLoad; global.fetch = originalFetch; });
const images = ['data:image/png;base64,Y29kZTE=', 'data:image/jpeg;base64,Y29kZTI='];
const turns = [{ role: 'user', text: 'Original question' }, { role: 'assistant', text: 'Original solution' }, { role: 'user', text: 'What about memory?' }];

for (const provider of ['openai', 'custom', 'azure', 'anthropic', 'gemini', 'ollama']) {
  test(`${provider}: sends ordered images with current question and retains prior Q&A roles`, async () => {
    global.fetch = async (_url, options) => { captured = JSON.parse(options.body); return { ok: true, body: [] }; };
    const llm = createLLM({ provider, apiKeys: { [provider]: provider === 'ollama' ? '' : 'fake' },
      baseUrl: 'http://localhost:1234/v1', azureEndpoint: 'https://test.openai.azure.com', models: { [provider]: { fast: 'fake-model' } } });
    await llm.stream({ system: 'test', turns, imageDataUrls: [...images, images[0]], onToken() {} });
    if (provider === 'gemini') {
      assert.deepEqual(captured.contents.map(turn => turn.role), ['user', 'model', 'user']);
      assert.deepEqual(captured.contents[2].parts.slice(1).map(part => part.inlineData.data), ['Y29kZTE=', 'Y29kZTI=']);
    } else if (provider === 'anthropic') {
      assert.equal(captured.messages[1].content, 'Original solution');
      assert.deepEqual(captured.messages[2].content.filter(part => part.type === 'image').map(part => part.source.data), ['Y29kZTE=', 'Y29kZTI=']);
    } else if (provider === 'ollama') {
      assert.equal(captured.messages[2].content, 'Original solution');
      assert.deepEqual(captured.messages[3].images, ['Y29kZTE=', 'Y29kZTI=']);
    } else {
      assert.equal(captured.messages[2].content, 'Original solution');
      assert.deepEqual(captured.messages[3].content.slice(1).map(part => part.image_url.url), images);
    }
  });
}
