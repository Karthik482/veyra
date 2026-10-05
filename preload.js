const { contextBridge, ipcRenderer } = require('electron');
const platform = process.platform;

contextBridge.exposeInMainWorld('veyra', {
  platform,
  settingsGet: () => ipcRenderer.invoke('settings:get'),
  settingsSet: (patch) => ipcRenderer.invoke('settings:set', patch),
  shortcutsGet: () => ipcRenderer.invoke('shortcuts:get'),
  shortcutsSet: (bindings) => ipcRenderer.invoke('shortcuts:set', bindings),
  shortcutsRecord: (active) => ipcRenderer.invoke('shortcuts:record', active),
  resizeWindow: (gesture) => ipcRenderer.send('window:resize', gesture),
  whisperModels: () => ipcRenderer.invoke('whisper:models'),
  whisperModelDownload: (modelId) => ipcRenderer.invoke('whisper:model-download', modelId),
  whisperModelCancel: (modelId) => ipcRenderer.invoke('whisper:model-cancel', modelId),
  whisperModelDelete: (modelId) => ipcRenderer.invoke('whisper:model-delete', modelId),
  whisperModelImport: (modelId) => ipcRenderer.invoke('whisper:model-import', modelId),
  platformInfo: () => ipcRenderer.invoke('platform:info'),
  ask: (payload) => ipcRenderer.send('ask', payload),
  captureToggle: () => ipcRenderer.invoke('capture:toggle').catch((err) => {
    console.error('[veyra] captureToggle error', err);
    return false;
  }),
  captureState: () => ipcRenderer.invoke('capture:state'),
  micPcm: (arrayBuffer) => ipcRenderer.send('mic:pcm', arrayBuffer),
  systemPcm: (arrayBuffer) => ipcRenderer.send('system:pcm', arrayBuffer),
  setIgnoreMouse: (v) => ipcRenderer.send('mouse:ignore', v),
  clearTranscript: () => ipcRenderer.invoke('transcript:clear'),
  assistContext: () => ipcRenderer.invoke('assist:context'),
  addScreenshot: () => ipcRenderer.invoke('assist:screenshot'),
  clearScreenshots: () => ipcRenderer.invoke('assist:clear-screenshots'),
  clearAssistContext: () => ipcRenderer.invoke('assist:clear-context'),
  diagnostic: (event, data) => ipcRenderer.send('diagnostic', { event, data }),
  openPane: (url) => ipcRenderer.send('open-pane', url),
  appLinkState: () => ipcRenderer.invoke('applink:state'),
  appLinkRevoke: (callerId) => ipcRenderer.invoke('applink:revoke', callerId),
  appLinkConsentRespond: (id, allowed) => ipcRenderer.send('applink:consent-response', { id, allowed }),
  pickProfileDocument: () => ipcRenderer.invoke('profile:pickDocument'),
  quit: () => ipcRenderer.send('app:quit'),
  permissionsCheck: () => ipcRenderer.invoke('permissions:check'),
  permissionsRequest: () => ipcRenderer.invoke('permissions:request'),
  permissionsContinue: () => ipcRenderer.send('permissions:continue'),
  log: (msg) => ipcRenderer.send('log', msg),
  micProcessing: (report) => ipcRenderer.send('mic:processing', report),
  on: (channel, cb) => {
    const allowed = ['capture:state', 'llm:start', 'llm:token', 'llm:done', 'llm:error', 'status', 'transcript', 'stt:interim', 'stt:final', 'stt:status', 'vad:state', 'applink:consent-request', 'hide:toggle', 'whisper:download-progress', 'whisper:models-changed', 'assist:context', 'diagnostic', 'shortcut:action', 'shortcuts:changed'];
    if (!allowed.includes(channel)) return;
    ipcRenderer.on(channel, (_e, data) => cb(data));
  }
});
