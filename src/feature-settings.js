function featureSettings(settings, mode) {
  if (mode === 'assist') return { ...settings, smart: true };
  if (mode === 'say') return { ...settings, smart: false };
  return settings;
}
module.exports = { featureSettings };
