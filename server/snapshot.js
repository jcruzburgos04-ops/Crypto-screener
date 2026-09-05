// Persistencia binaria del VolumeStore.
//
// Reiniciar el proceso no debería tirar a la basura las ventanas de 4 h o 24 h,
// que tardan horas en llenarse. Se vuelca todo a un archivo binario compacto
// (~29 KB por símbolo) y al arrancar se restaura y se envejece con advance().

import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  VolumeStore,
  FINE_SLOTS,
  COARSE_SLOTS,
  FINE_BUCKET_MS,
  COARSE_BUCKET_MS,
  MAX_WINDOW_MS,
} from '../public/js/core/volume-store.js';

const MAGIC = 0x42594256; // "BYBV"
const VERSION = 1;
const HEADER_BYTES = 60;
const ENTRY_FIXED_BYTES = 2 + 8; // longitud del nombre + `since`
const ENTRY_ARRAY_BYTES = (FINE_SLOTS * 2 + COARSE_SLOTS * 2) * 8;

function copyIn(target, offset, floats) {
  target.set(new Uint8Array(floats.buffer, floats.byteOffset, floats.byteLength), offset);
  return offset + floats.byteLength;
}

function copyOut(source, offset, slots) {
  const floats = new Float64Array(slots);
  new Uint8Array(floats.buffer).set(source.subarray(offset, offset + floats.byteLength));
  return [floats, offset + floats.byteLength];
}

export function serialize(store, savedAt = Date.now()) {
  const names = [];
  let total = HEADER_BYTES;
  for (const symbol of store.entries.keys()) {
    const name = Buffer.from(symbol, 'utf8');
    names.push(name);
    total += ENTRY_FIXED_BYTES + name.length + ENTRY_ARRAY_BYTES;
  }

  const buf = Buffer.allocUnsafe(total);
  buf.writeUInt32LE(MAGIC, 0);
  buf.writeUInt32LE(VERSION, 4);
  buf.writeDoubleLE(savedAt, 8);
  buf.writeDoubleLE(store.startedAt, 16);
  buf.writeUInt32LE(FINE_SLOTS, 24);
  buf.writeUInt32LE(COARSE_SLOTS, 28);
  buf.writeUInt32LE(FINE_BUCKET_MS, 32);
  buf.writeUInt32LE(COARSE_BUCKET_MS, 36);
  buf.writeDoubleLE(store.fineId, 40);
  buf.writeDoubleLE(store.coarseId, 48);
  buf.writeUInt32LE(store.entries.size, 56);

  const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  let offset = HEADER_BYTES;
  let i = 0;
  for (const entry of store.entries.values()) {
    const name = names[i++];
    buf.writeUInt16LE(name.length, offset);
    offset += 2;
    bytes.set(name, offset);
    offset += name.length;
    buf.writeDoubleLE(entry.since, offset);
    offset += 8;
    offset = copyIn(bytes, offset, entry.fineBuy);
    offset = copyIn(bytes, offset, entry.fineSell);
    offset = copyIn(bytes, offset, entry.coarseBuy);
    offset = copyIn(bytes, offset, entry.coarseSell);
  }
  return buf;
}

export function deserialize(buf, now = Date.now()) {
  if (buf.length < HEADER_BYTES) throw new Error('snapshot truncado');
  if (buf.readUInt32LE(0) !== MAGIC) throw new Error('cabecera desconocida');
  if (buf.readUInt32LE(4) !== VERSION) throw new Error('versión de snapshot incompatible');
  if (
    buf.readUInt32LE(24) !== FINE_SLOTS ||
    buf.readUInt32LE(28) !== COARSE_SLOTS ||
    buf.readUInt32LE(32) !== FINE_BUCKET_MS ||
    buf.readUInt32LE(36) !== COARSE_BUCKET_MS
  ) {
    throw new Error('la geometría de los buffers cambió');
  }

  const savedAt = buf.readDoubleLE(8);
  if (now - savedAt > MAX_WINDOW_MS) throw new Error('snapshot demasiado antiguo');

  const store = new VolumeStore(now);
  store.startedAt = Math.min(buf.readDoubleLE(16), now);
  store.fineId = buf.readDoubleLE(40);
  store.coarseId = buf.readDoubleLE(48);

  const count = buf.readUInt32LE(56);
  const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  let offset = HEADER_BYTES;
  for (let i = 0; i < count; i++) {
    const nameLen = buf.readUInt16LE(offset);
    offset += 2;
    const symbol = buf.toString('utf8', offset, offset + nameLen);
    offset += nameLen;
    const since = buf.readDoubleLE(offset);
    offset += 8;
    let fineBuy;
    let fineSell;
    let coarseBuy;
    let coarseSell;
    [fineBuy, offset] = copyOut(bytes, offset, FINE_SLOTS);
    [fineSell, offset] = copyOut(bytes, offset, FINE_SLOTS);
    [coarseBuy, offset] = copyOut(bytes, offset, COARSE_SLOTS);
    [coarseSell, offset] = copyOut(bytes, offset, COARSE_SLOTS);
    store.entries.set(symbol, {
      symbol,
      fineBuy,
      fineSell,
      coarseBuy,
      coarseSell,
      since: Math.min(since, now),
      lastTradeMs: 0,
      trades: 0,
    });
  }
  // Vacía los cubos que caducaron mientras el proceso estaba apagado.
  store.advance(now);
  return store;
}

export async function saveSnapshot(store, file, now = Date.now()) {
  const buf = serialize(store, now);
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, buf);
  await rename(tmp, file); // reemplazo atómico: nunca se lee un archivo a medias
  return buf.length;
}

export async function loadSnapshot(file, now = Date.now()) {
  let buf;
  try {
    buf = await readFile(file);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  try {
    return deserialize(buf, now);
  } catch (err) {
    // Un snapshot inservible se descarta: el screener se rellena solo.
    await unlink(file).catch(() => {});
    const wrapped = new Error(`snapshot descartado: ${err.message}`);
    wrapped.recoverable = true;
    throw wrapped;
  }
}
