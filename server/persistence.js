// Persistencia en disco del historial de delta. Es lo único del screener que
// depende de Node, por eso se inyecta en el orquestador en vez de vivir dentro.

import { loadSnapshot, saveSnapshot } from './snapshot.js';

export function createFilePersistence(config) {
  return {
    load: () => loadSnapshot(config.snapshotFile),
    save: (store) => saveSnapshot(store, config.snapshotFile),
  };
}
