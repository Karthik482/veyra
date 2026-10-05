const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { configureIdentity } = require('../src/app-identity');
const compatibility = require('../src/profile-compatibility.json');

function fixture(t, explicit = false) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'veyra-identity-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const paths = { appData: base, userData: path.join(base, explicit ? 'isolated' : 'veyra') };
  const app = { getPath: key => paths[key], setPath: (key, value) => { paths[key] = value; }, setName: value => { app.name = value; } };
  const put = (directory, file, content) => { fs.mkdirSync(directory, { recursive: true }); fs.writeFileSync(path.join(directory, file), content); };
  return { base, paths, app, put };
}
for (const profile of compatibility) {
  test('migrates a supported legacy profile without changing its settings or models: '+profile.directory, t => {
    const { base, paths, app, put } = fixture(t);
    const previous = path.join(base, profile.directory);
    const original = JSON.stringify({ shortcuts: { moveLeft: 'Alt+Left' }, echoSuppression: true, localWhisper: { modelId: 'base.en' } });
    put(previous, profile.settingsFile, original);
    put(path.join(previous, 'whisper-models'), 'sample.bin', 'model sentinel');
    configureIdentity(app);
    assert.equal(app.name, 'Veyra');
    assert.equal(paths.userData, previous);
    assert.equal(fs.readFileSync(path.join(previous, 'veyra-data.json'), 'utf8'), original);
    assert.equal(fs.readFileSync(path.join(previous, profile.settingsFile), 'utf8'), original);
    assert.equal(fs.readFileSync(path.join(paths.userData, 'whisper-models/sample.bin'), 'utf8'), 'model sentinel');
    put(previous, 'veyra-data.json', '{"smart":true}');
    configureIdentity(app);
    assert.equal(fs.readFileSync(path.join(previous, 'veyra-data.json'), 'utf8'), '{"smart":true}');
  });
}
test('fresh installation uses its new profile', t => {
  const { paths, app } = fixture(t);
  const original = paths.userData;
  configureIdentity(app);
  assert.equal(paths.userData, original);
  assert.equal(app.name, 'Veyra');
});
test('explicit profile is isolated from legacy settings', t => {
  const { base, paths, app, put } = fixture(t, true);
  const original = paths.userData;
  const previous = compatibility[1];
  put(path.join(base, previous.directory), previous.settingsFile, '{"smart":true}');
  configureIdentity(app);
  assert.equal(paths.userData, original);
  assert.equal(fs.existsSync(path.join(original, 'veyra-data.json')), false);
});
test('existing Veyra settings take precedence over legacy profiles', t => {
  const { base, paths, app, put } = fixture(t);
  const original = paths.userData;
  const previous = compatibility[1];
  put(path.join(base, previous.directory), previous.settingsFile, '{"smart":false}');
  put(original, 'veyra-data.json', '{"smart":true}');
  configureIdentity(app);
  assert.equal(paths.userData, original);
  assert.equal(fs.readFileSync(path.join(original, 'veyra-data.json'), 'utf8'), '{"smart":true}');
});
