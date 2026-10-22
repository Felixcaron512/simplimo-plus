// Mini-couche IndexedDB : file d'attente des scans hors ligne + cache de données
const open = () => new Promise((res, rej) => {
  const r = indexedDB.open('simplimo', 1);
  r.onupgradeneeded = () => {
    r.result.createObjectStore('queue', { keyPath: 'qid', autoIncrement: true });
    r.result.createObjectStore('cache', { keyPath: 'k' });
  };
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
});
const tx = async (store, mode, fn) => {
  const d = await open();
  return new Promise((res, rej) => {
    const t = d.transaction(store, mode);
    const q = fn(t.objectStore(store));
    t.oncomplete = () => res(q && q.result);
    t.onerror = () => rej(t.error);
  });
};
export const qAdd = o => tx('queue', 'readwrite', s => s.add(o));
export const qAll = () => tx('queue', 'readonly', s => s.getAll());
export const qDel = ids => tx('queue', 'readwrite', s => { ids.forEach(i => s.delete(i)); });
export const cSet = (k, v) => tx('cache', 'readwrite', s => s.put({ k, v }));
export const cGet = async k => (await tx('cache', 'readonly', s => s.get(k)))?.v;
