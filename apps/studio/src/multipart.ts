/**
 * A multipart/form-data parser that tolerates what the Studio editor actually sends.
 *
 * The editor writes `Content-Disposition: form-data; name=roomId; filename=a.assetbundle`
 * with the parameter values UNQUOTED. RFC 7578 wants quotes, and the runtime's own
 * parser (`Request.formData()`, and so Hono's `parseBody`) throws
 * "Content-Disposition header in FormData part is missing a name" on the first such
 * part. Caught and defaulted, that read as an empty form and the upload was refused
 * with "No such room." Every field is parsed here instead, quoted or bare.
 */

export type FormFields = Record<string, string | File>

/** Views into the request buffer: the upload route avoids two copies of every bundle. */
export interface MultipartFile {
	name: string
	type: string
	bytes: Uint8Array<ArrayBuffer>
}

export type MultipartBytesFields = Record<string, string | MultipartFile>

export class MultipartTooLarge extends Error {}

const CRLF = new Uint8Array([13, 10])
const HEADER_END = new Uint8Array([13, 10, 13, 10])
const DASHES = new Uint8Array([45, 45])

function indexOf(haystack: Uint8Array, needle: Uint8Array, from: number): number {
	const first = needle[0]
	const last = haystack.length - needle.length
	outer: for (let i = from; i <= last; i++) {
		if (haystack[i] !== first) continue
		for (let j = 1; j < needle.length; j++) {
			if (haystack[i + j] !== needle[j]) continue outer
		}
		return i
	}
	return -1
}

function startsWith(bytes: Uint8Array, prefix: Uint8Array, at: number): boolean {
	if (at + prefix.length > bytes.length) return false
	for (let i = 0; i < prefix.length; i++) if (bytes[at + i] !== prefix[i]) return false
	return true
}

function boundaryOf(contentType: string | null): string | null {
	const match = contentType?.match(/multipart\/form-data\s*;.*?boundary=(?:"([^"]+)"|([^;\s]+))/i)
	return match ? (match[1] ?? match[2] ?? null) : null
}

/**
 * `; name=value`, `; name="value"`, with `\"` escapes inside quotes. A bare value runs
 * to the next `;`, which is how the editor's unquoted filenames end.
 */
function dispositionParams(header: string): Map<string, string> {
	const params = new Map<string, string>()
	const re = /;\s*([^=;\s]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;]*))/g
	for (const m of header.matchAll(re)) {
		const key = m[1].toLowerCase()
		const value = m[2] != null ? m[2].replace(/\\(.)/g, '$1') : (m[3] ?? '').trim()
		params.set(key, value)
	}
	return params
}

/** RFC 5987 `utf-8''percent%20encoded`; a value that fails to decode is left as is. */
function extendedValue(raw: string): string {
	const m = raw.match(/^(?:utf-8|utf8)'[^']*'(.*)$/i)
	if (!m) return raw
	try {
		return decodeURIComponent(m[1])
	} catch {
		return m[1]
	}
}

function headerValue(headers: string, name: string): string | null {
	const re = new RegExp(`^${name}\\s*:\\s*(.*)$`, 'im')
	const m = headers.match(re)
	return m ? m[1].trim() : null
}

function parseParts(bytes: Uint8Array<ArrayBuffer>, boundary: string): MultipartBytesFields {
	const fields: MultipartBytesFields = {}
	const delimiter = new TextEncoder().encode(`--${boundary}`)
	const decoder = new TextDecoder()

	// The first delimiter has no CRLF before it; every later one is `CRLF--boundary`.
	let pos = indexOf(bytes, delimiter, 0)
	if (pos !== 0 && !(pos > 0 && startsWith(bytes, CRLF, pos - 2))) return fields
	pos += delimiter.length

	while (pos < bytes.length) {
		if (startsWith(bytes, DASHES, pos)) break
		// Skip transport padding up to the CRLF that ends the delimiter line.
		const lineEnd = indexOf(bytes, CRLF, pos)
		if (lineEnd < 0) break
		const headersStart = lineEnd + 2
		const headersEnd = indexOf(bytes, HEADER_END, headersStart)
		if (headersEnd < 0) break
		const contentStart = headersEnd + 4
		// Content runs to the CRLF that precedes the next delimiter.
		let next = indexOf(bytes, delimiter, contentStart)
		while (next >= 0 && !startsWith(bytes, CRLF, next - 2)) {
			next = indexOf(bytes, delimiter, next + delimiter.length)
		}
		if (next < 0) break
		const content = bytes.subarray(contentStart, next - 2)
		pos = next + delimiter.length

		const headers = decoder.decode(bytes.subarray(headersStart, headersEnd))
		const disposition = headerValue(headers, 'content-disposition')
		if (disposition == null) continue
		const params = dispositionParams(disposition)
		const name = params.get('name')
		if (name == null || name === '') continue
		const filenameExt = params.get('filename*')
		const filename = filenameExt != null ? extendedValue(filenameExt) : params.get('filename')
		if (filename != null) {
			const type = headerValue(headers, 'content-type') ?? 'application/octet-stream'
			fields[name] = { name: filename, type, bytes: content }
		} else {
			fields[name] = decoder.decode(content)
		}
	}
	return fields
}

/**
 * Parse the request body as multipart/form-data. Text parts are strings, parts with a
 * filename are Files. A later part with the same name replaces an earlier one. A
 * request that is not multipart, or has no boundary, parses as no fields.
 */
export async function parseMultipart(req: Request): Promise<FormFields> {
	const boundary = boundaryOf(req.headers.get('content-type'))
	if (boundary == null) return {}
	const bytes = new Uint8Array(await req.arrayBuffer())
	return Object.fromEntries(
		Object.entries(parseParts(bytes, boundary)).map(([name, value]) => [
			name,
			typeof value === 'string' ? value : new File([value.bytes], value.name, { type: value.type }),
		])
	)
}

/** Bound bytes while reading, including requests with no Content-Length header. */
export async function parseMultipartBytes(
	req: Request,
	maxBytes: number
): Promise<MultipartBytesFields> {
	const boundary = boundaryOf(req.headers.get('content-type'))
	if (boundary == null || req.body == null) return {}
	const lengthHeader = req.headers.get('content-length')
	const length = lengthHeader != null && /^\d+$/.test(lengthHeader) ? Number(lengthHeader) : null
	if (length != null && (!Number.isSafeInteger(length) || length > maxBytes)) {
		throw new MultipartTooLarge('Multipart upload exceeds the size limit.')
	}
	// A single buffer keeps a large request inside the Workers memory limit. When the
	// size is unknown, reserve the limit rather than retaining chunks and copying them.
	const buffer = new Uint8Array(length ?? maxBytes)
	const reader = req.body.getReader()
	let used = 0
	try {
		while (true) {
			const { done, value } = await reader.read()
			if (done) break
			if (used + value.byteLength > buffer.byteLength) {
				await reader.cancel()
				throw new MultipartTooLarge('Multipart upload exceeds the declared size or size limit.')
			}
			buffer.set(value, used)
			used += value.byteLength
		}
	} finally {
		reader.releaseLock()
	}
	return parseParts(buffer.subarray(0, used), boundary)
}
