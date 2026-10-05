// Shared by the renderer and the hardware probe so the tested constraints ship.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.VeyraMicrophone = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  async function openMicrophone(mediaDevices, { platform, deviceId } = {}) {
    const requested = {
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      // A boolean only cancels audio rendered by this app on some runtimes.
      // Veyra needs the Windows loopback reference for Chrome/Teams/Zoom playback.
      echoCancellation: platform === 'win32' ? { exact: 'all' } : true,
      noiseSuppression: true,
      autoGainControl: false,
      channelCount: 1,
      sampleRate: 16000
    };
    try {
      return { stream: await mediaDevices.getUserMedia({ audio: requested }), requested, fallback: false };
    } catch (error) {
      // Never mask a missing device or permission/device-busy error with a retry.
      if (platform !== 'win32' || error.name !== 'OverconstrainedError' || error.constraint !== 'echoCancellation') throw error;
      const fallbackRequested = { ...requested, echoCancellation: true };
      return { stream: await mediaDevices.getUserMedia({ audio: fallbackRequested }), requested: fallbackRequested, fallback: true };
    }
  }
  function echoMode(value) {
    if (value === 'all') return 'all';
    if (value === 'remote-only') return 'remote-only';
    return value === true ? 'default' : 'off';
  }
  return { openMicrophone, echoMode };
});
