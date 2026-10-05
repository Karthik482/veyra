// Explicit development-only diagnostics. Never serialize clients, settings or images.
function createDiagnostics({ enabled = false, secrets = () => [], write = console.log }) {
  function scrub(value, key = '') {
    if (/^(api.?keys?|authorization|credentials?|password|token|access_token|refresh_token|dataurl|imagedataurls?|base64)$/i.test(key)) return '[redacted]';
    if (typeof value === 'string') {
      let text = value.replace(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/g, '[image omitted]');
      for (const secret of secrets().filter(value => typeof value === 'string' && value.length >= 4)) text = text.split(secret).join('[redacted]');
      return text.replace(/\b(?:sk-[A-Za-z0-9_-]+|Bearer\s+\S+)/gi, '[redacted]');
    }
    if (Array.isArray(value)) return value.map(item => scrub(item));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, scrub(item, name)]));
    return value;
  }
  return { enabled, log(event, data = {}) { if (enabled) write(event, scrub(data)); } };
}
module.exports = { createDiagnostics };
