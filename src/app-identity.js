const fs = require('node:fs');
const path = require('node:path');
const legacyProfiles = require('./profile-compatibility.json');
const SETTINGS_FILE = 'veyra-data.json';
// Compatibility names are isolated in data. Keep existing profiles and models;
// never overwrite current settings or replace an explicitly selected profile.
function configureIdentity(app) {
  if (typeof app.getPath !== 'function' || typeof app.setPath !== 'function') return;
  const current = app.getPath('userData');
  const base = app.getPath('appData');
  const isNewDefault = path.resolve(current).toLowerCase() === path.resolve(base, 'veyra').toLowerCase();
  let chosen = current;
  if (isNewDefault && !fs.existsSync(path.join(current, SETTINGS_FILE))) {
    const previous = legacyProfiles.find(profile => fs.existsSync(path.join(base, profile.directory, profile.settingsFile)));
    if (previous) chosen = path.join(base, previous.directory);
  }
  const destination = path.join(chosen, SETTINGS_FILE);
  if (!fs.existsSync(destination)) {
    const oldFile = legacyProfiles.map(profile => path.join(chosen, profile.settingsFile)).find(file => fs.existsSync(file));
    if (oldFile) fs.copyFileSync(oldFile, destination, fs.constants.COPYFILE_EXCL);
  }
  app.setName('Veyra');
  app.setPath('userData', chosen);
}
module.exports = { configureIdentity };
