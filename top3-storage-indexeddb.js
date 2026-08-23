// TOP-3 storage patch: IndexedDB instead of localStorage
// Version: 1.0.1
//
// Drop this file into the repository and load it BEFORE the main app script.
//
// Replaces oversized localStorage usage for:
//   top3-auto-state-v1
//
// Notes:
// - IndexedDB has a much larger quota than localStorage.
// - It is NOT literally unlimited; browser/device storage limits still apply.
// - Existing localStorage data is migrated automatically when possible.

(() => {
  'use strict';

  const DB_NAME = 'top3-auto-db';
  const DB_VERSION = 1;
  const STORE_NAME = 'state';
  const DEFAULT_KEY = 'top3-auto-state-v1';

  let dbPromise = null;

  function openDb() {
    if (dbPromise) return dbPromise;

    dbPromise = new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) {
        reject(new Error('IndexedDB is not supported in this browser'));
        return;
      }

      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME);
        }
      };

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Failed to open IndexedDB'));
      request.onblocked = () => {
        console.warn('[TOP-3 storage] IndexedDB upgrade is blocked by another tab.');
      };
    });

    return dbPromise;
  }

  async function idbSet(key, value) {
    const db = await openDb();

    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);

      store.put(value, key);

      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error || new Error('IndexedDB write failed'));
      tx.onabort = () => reject(tx.error || new Error('IndexedDB write aborted'));
    });
  }

  async function idbGet(key) {
    const db = await openDb();

    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(key);

      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => reject(req.error || new Error('IndexedDB read failed'));
    });
  }

  async function idbDelete(key) {
    const db = await openDb();

    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);

      store.delete(key);

      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error || new Error('IndexedDB delete failed'));
      tx.onabort = () => reject(tx.error || new Error('IndexedDB delete aborted'));
    });
  }

  async function idbClear() {
    const db = await openDb();

    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);

      store.clear();

      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error || new Error('IndexedDB clear failed'));
      tx.onabort = () => reject(tx.error || new Error('IndexedDB clear aborted'));
    });
  }

  function safeParse(raw) {
    if (raw == null) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }

  async function migrateFromLocalStorage(key = DEFAULT_KEY) {
    try {
      const raw = localStorage.getItem(key);
      if (raw == null) return false;

      const parsed = safeParse(raw);
      await idbSet(key, parsed);

      // Remove the oversized localStorage item after successful migration.
      localStorage.removeItem(key);

      console.info(`[TOP-3 storage] Migrated "${key}" from localStorage to IndexedDB.`);
      return true;
    } catch (error) {
      console.warn('[TOP-3 storage] Migration skipped:', error);
      return false;
    }
  }

  async function saveState(state, key = DEFAULT_KEY) {
    try {
      await idbSet(key, state);
      return true;
    } catch (error) {
      console.error('[TOP-3 storage] saveState failed:', error);
      return false;
    }
  }

  async function loadState(key = DEFAULT_KEY) {
    try {
      let value = await idbGet(key);

      if (value == null) {
        const migrated = await migrateFromLocalStorage(key);
        if (migrated) value = await idbGet(key);
      }

      return value;
    } catch (error) {
      console.error('[TOP-3 storage] loadState failed:', error);
      return null;
    }
  }

  async function removeState(key = DEFAULT_KEY) {
    try {
      await idbDelete(key);
      try {
        localStorage.removeItem(key);
      } catch {}
      return true;
    } catch (error) {
      console.error('[TOP-3 storage] removeState failed:', error);
      return false;
    }
  }

  async function clearAllTop3Storage() {
    try {
      await idbClear();

      // Remove TOP-3 localStorage leftovers too.
      try {
        const keys = [];
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k && k.startsWith('top3-')) keys.push(k);
        }
        keys.forEach(k => localStorage.removeItem(k));
      } catch {}

      return true;
    } catch (error) {
      console.error('[TOP-3 storage] clearAllTop3Storage failed:', error);
      return false;
    }
  }

  async function estimateStorage() {
    if (!navigator.storage || !navigator.storage.estimate) {
      return null;
    }

    try {
      const estimate = await navigator.storage.estimate();
      return {
        usage: estimate.usage ?? null,
        quota: estimate.quota ?? null,
        usageMB: estimate.usage ? +(estimate.usage / 1024 / 1024).toFixed(2) : null,
        quotaMB: estimate.quota ? +(estimate.quota / 1024 / 1024).toFixed(2) : null,
      };
    } catch {
      return null;
    }
  }

  // Public API
  window.Top3Storage = {
    DB_NAME,
    STORE_NAME,
    DEFAULT_KEY,
    saveState,
    loadState,
    removeState,
    migrateFromLocalStorage,
    clearAllTop3Storage,
    estimateStorage,
    set: idbSet,
    get: idbGet,
    delete: idbDelete,
    clear: idbClear,
  };

  // Try migration immediately, but don't block app startup.
  migrateFromLocalStorage(DEFAULT_KEY).catch(() => {});
  migrateFromLocalStorage('yulia-top3-forecast-archive-v2-auto').catch(() => {});
})();
