/**
 * The extension's side of the pairing (DESIGN §3.3): its static P-256 key, which never leaves IndexedDB
 * (the private key is not extractable), its install id, the app key it pinned, and the person's consent.
 */

import { type ChannelKeyPair, generateChannelKey, randomBase64Url } from "@openbot/contracts/chrome-bridge/channel";
import { isDynamicRecord, isNumber, isString } from "@openbot/contracts/runtime-values";

const DATABASE = "builders-bot";
const STORE = "keys";
const STATIC_KEY = "static";
const PAIR_KEY = "bb.pair";
const INSTALL_KEY = "bb.installId";

export interface Pin {
  /** The app's static public key. */
  appKey: string;
  /** False until the app says it pinned this extension too (`pair.done`). */
  final: boolean;
}

export interface Consent {
  version: number;
  at: number;
}

function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB did not open"));
  });
}

function inStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return database().then((db) =>
    new Promise<T>((resolve, reject) => {
      const request = run(db.transaction(STORE, mode).objectStore(STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("IndexedDB failed"));
    }).finally(() => db.close()),
  );
}

let cached: ChannelKeyPair | null = null;

function readKeyPair(value: unknown): ChannelKeyPair | null {
  if (!isDynamicRecord(value) || !isString(value.publicKey) || !(value.privateKey instanceof CryptoKey)) return null;
  return { privateKey: value.privateKey, publicKey: value.publicKey };
}

/** The static key of this install, made once. */
export async function staticKey(): Promise<ChannelKeyPair> {
  if (cached) return cached;
  const stored = readKeyPair(await inStore("readonly", (store) => store.get(STATIC_KEY)));
  if (stored) {
    cached = stored;
    return stored;
  }
  const made = await generateChannelKey(false);
  await inStore("readwrite", (store) =>
    store.put({ privateKey: made.privateKey, publicKey: made.publicKey }, STATIC_KEY),
  );
  cached = made;
  return made;
}

export async function installId(): Promise<string> {
  const stored = (await chrome.storage.local.get(INSTALL_KEY))[INSTALL_KEY];
  if (isString(stored) && /^[A-Za-z0-9_-]{22}$/u.test(stored)) return stored;
  const made = randomBase64Url(16);
  await chrome.storage.local.set({ [INSTALL_KEY]: made });
  return made;
}

export async function readPairing(): Promise<{ pin: Pin | null; consent: Consent | null }> {
  const stored = (await chrome.storage.local.get(PAIR_KEY))[PAIR_KEY];
  if (!isDynamicRecord(stored)) return { pin: null, consent: null };
  const pin = isString(stored.appKey) ? { appKey: stored.appKey, final: stored.final === true } : null;
  const consent =
    isDynamicRecord(stored.consent) && isNumber(stored.consent.version) && isNumber(stored.consent.at)
      ? { version: stored.consent.version, at: stored.consent.at }
      : null;
  return { pin, consent };
}

export async function writePairing(pin: Pin, consent: Consent): Promise<void> {
  await chrome.storage.local.set({ [PAIR_KEY]: { appKey: pin.appKey, final: pin.final, consent } });
}

/** "Disconnect" in the popup: the keys and the pin go; the next connection needs the words again. */
export async function forgetPairing(): Promise<void> {
  cached = null;
  await chrome.storage.local.remove([PAIR_KEY, INSTALL_KEY]);
  await inStore("readwrite", (store) => store.delete(STATIC_KEY));
}
