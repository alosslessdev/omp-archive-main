/**
 * Minimal ZIP (deflate) writer.
 *
 * No dependencies, no zip64: entries and offsets must stay under 4 GiB, which a
 * session archive never approaches. Kept pure so it can be unit-tested outside
 * the omp process.
 */
import { deflateRawSync } from "node:zlib";

export interface ZipEntry {
	/** Forward-slash path inside the archive; directories are implied. */
	name: string;
	data: Uint8Array;
	/** Modification time recorded in the entry; defaults to the caller's `now`. */
	mtime?: Date;
}

const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let i = 0; i < 256; i++) {
		let c = i;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		table[i] = c >>> 0;
	}
	return table;
})();

function crc32(bytes: Uint8Array): number {
	let crc = 0xffffffff;
	for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8);
	return (crc ^ 0xffffffff) >>> 0;
}

/** DOS date/time pair for a JS date (2-second resolution, local time). */
function dosDateTime(date: Date): { time: number; date: number } {
	const year = Math.max(1980, date.getFullYear());
	return {
		time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
		date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
	};
}

/** Local file header signature. */
const LOCAL_SIG = 0x04034b50;
/** Central directory header signature. */
const CENTRAL_SIG = 0x02014b50;
/** End of central directory signature. */
const EOCD_SIG = 0x06054b50;
/** General-purpose bit 11: name is UTF-8. */
const UTF8_FLAG = 0x0800;

class Writer {
	#chunks: Uint8Array[] = [];
	#size = 0;
	u16(v: number): void {
		this.#push(new Uint8Array([v & 0xff, (v >>> 8) & 0xff]));
	}
	u32(v: number): void {
		this.#push(new Uint8Array([v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]));
	}
	bytes(b: Uint8Array): void {
		this.#push(b);
	}
	#push(b: Uint8Array): void {
		this.#chunks.push(b);
		this.#size += b.length;
	}
	get size(): number {
		return this.#size;
	}
	toUint8Array(): Uint8Array {
		const out = new Uint8Array(this.#size);
		let offset = 0;
		for (const chunk of this.#chunks) {
			out.set(chunk, offset);
			offset += chunk.length;
		}
		return out;
	}
}

/** Build a ZIP archive (deflate) from `entries`. Returns the archive bytes. */
export function createZip(entries: readonly ZipEntry[], now: Date = new Date()): Uint8Array {
	const seen = new Set<string>();
	const names = new TextEncoder();
	const body = new Writer();
	const central = new Writer();
	const records: { name: Uint8Array; crc: number; csize: number; usize: number; offset: number; method: number; time: number; date: number }[] = [];

	for (const entry of entries) {
		if (!entry.name || entry.name.endsWith("/")) throw new Error(`Invalid zip entry name: ${JSON.stringify(entry.name)}`);
		if (seen.has(entry.name)) throw new Error(`Duplicate zip entry: ${entry.name}`);
		seen.add(entry.name);
		const name = names.encode(entry.name);
		const data = entry.data;
		const compressed = deflateRawSync(data, { level: 6 });
		const method = 8;
		const payload = compressed.length < data.length ? compressed : data;
		const usedMethod = compressed.length < data.length ? method : 0;
		const crc = crc32(data);
		const { time, date } = dosDateTime(entry.mtime ?? now);
		const offset = body.size;
		if (offset > 0xffffffff || payload.length > 0xffffffff || data.length > 0xffffffff) {
			throw new Error(`Zip entry too large (zip64 unsupported): ${entry.name}`);
		}
		body.u32(LOCAL_SIG);
		body.u16(20);
		body.u16(UTF8_FLAG);
		body.u16(usedMethod);
		body.u16(time);
		body.u16(date);
		body.u32(crc);
		body.u32(payload.length);
		body.u32(data.length);
		body.u16(name.length);
		body.u16(0);
		body.bytes(name);
		body.bytes(payload);
		records.push({ name, crc, csize: payload.length, usize: data.length, offset, method: usedMethod, time, date });
	}

	const centralStart = body.size;
	for (const r of records) {
		central.u32(CENTRAL_SIG);
		central.u16(20);
		central.u16(20);
		central.u16(UTF8_FLAG);
		central.u16(r.method);
		central.u16(r.time);
		central.u16(r.date);
		central.u32(r.crc);
		central.u32(r.csize);
		central.u32(r.usize);
		central.u16(r.name.length);
		central.u16(0);
		central.u16(0);
		central.u16(0);
		central.u16(0);
		central.u32(0);
		central.u32(r.offset);
		central.bytes(r.name);
	}
	const centralBytes = central.toUint8Array();
	if (records.length > 0xffff) throw new Error(`Too many zip entries (zip64 unsupported): ${records.length}`);

	const eocd = new Writer();
	eocd.u32(EOCD_SIG);
	eocd.u16(0);
	eocd.u16(0);
	eocd.u16(records.length);
	eocd.u16(records.length);
	eocd.u32(centralBytes.length);
	eocd.u32(centralStart);
	eocd.u16(0);

	const out = new Uint8Array(body.size + centralBytes.length + eocd.size);
	out.set(body.toUint8Array(), 0);
	out.set(centralBytes, body.size);
	out.set(eocd.toUint8Array(), body.size + centralBytes.length);
	return out;
}
