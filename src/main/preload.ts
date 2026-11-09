import { contextBridge, ipcRenderer } from 'electron';

// Minimal, sikker bro: UI'et kan kun kalde navngivne API-metoder og lytte på live-opdateringer.
contextBridge.exposeInMainWorld('aiDispatch', {
  invoke: (method: string, params?: unknown) => ipcRenderer.invoke('invoke', method, params ?? {}),
  onLive: (cb: (topics: string[]) => void) => {
    const listener = (_: unknown, topics: string[]) => cb(topics);
    ipcRenderer.on('live', listener);
    return () => ipcRenderer.removeListener('live', listener);
  },
});
