import { describe, expect, it } from 'vitest'

import { MultipartTooLarge, parseMultipart, parseMultipartBytes } from '../multipart'

const B = 'xyz'

function request(body: BodyInit, contentType = `multipart/form-data; boundary=${B}`): Request {
	return new Request('https://example.com/', {
		method: 'POST',
		headers: { 'content-type': contentType },
		body,
	})
}

describe('parseMultipart', () => {
	it('reads unquoted and quoted names alike', async () => {
		const raw =
			`--${B}\r\nContent-Disposition: form-data; name=a\r\n\r\n1\r\n` +
			`--${B}\r\nContent-Disposition: form-data; name="b"\r\n\r\n2\r\n` +
			`--${B}--\r\n`
		expect(await parseMultipart(request(raw))).toEqual({ a: '1', b: '2' })
	})

	it('reads a file part with bare filename and filename*', async () => {
		const raw =
			`--${B}\r\nContent-Type: application/octet-stream\r\n` +
			`Content-Disposition: form-data; name=windows; filename=x.assetbundle; filename*=utf-8''x%20y.assetbundle\r\n\r\n` +
			`bytes\r\n--${B}--\r\n`
		const fields = await parseMultipart(request(raw))
		const file = fields.windows
		expect(file).toBeInstanceOf(File)
		expect((file as File).name).toBe('x y.assetbundle')
		expect((file as File).type).toBe('application/octet-stream')
		expect(await (file as File).text()).toBe('bytes')
	})

	it('matches the runtime parser on a FormData body', async () => {
		const fd = new FormData()
		fd.append('roomId', '1049')
		fd.append('windows', new File([new Uint8Array([1, 2, 3])], 'w.assetbundle'))
		const req = new Request('https://example.com/', { method: 'POST', body: fd })
		const fields = await parseMultipart(req)
		expect(fields.roomId).toBe('1049')
		expect([...new Uint8Array(await (fields.windows as File).arrayBuffer())]).toEqual([1, 2, 3])
	})

	it('keeps bytes that look like a delimiter but lack the leading CRLF', async () => {
		const enc = new TextEncoder()
		const payload = enc.encode(`x--${B}\r\nnot a delimiter`)
		const body = new Blob([
			enc.encode(`--${B}\r\nContent-Disposition: form-data; name=f; filename=f\r\n\r\n`),
			payload,
			enc.encode(`\r\n--${B}--\r\n`),
		])
		const fields = await parseMultipart(request(body))
		expect(await (fields.f as File).text()).toBe(`x--${B}\r\nnot a delimiter`)
	})

	it('is empty for a non-multipart body or a truncated one', async () => {
		expect(await parseMultipart(request('a=1', 'application/x-www-form-urlencoded'))).toEqual({})
		expect(
			await parseMultipart(request(`--${B}\r\nContent-Disposition: form-data; name=a\r\n\r\n1`))
		).toEqual({})
	})

	it('bounds streamed bodies with and without a declared length', async () => {
		const raw = `--${B}\r\nContent-Disposition: form-data; name=a\r\n\r\n1\r\n--${B}--\r\n`
		expect(await parseMultipartBytes(request(raw), 1024)).toEqual({ a: '1' })
		await expect(parseMultipartBytes(request(raw), 10)).rejects.toBeInstanceOf(MultipartTooLarge)
		const declared = request(raw)
		declared.headers.set('content-length', '2048')
		await expect(parseMultipartBytes(declared, 1024)).rejects.toBeInstanceOf(MultipartTooLarge)
	})

	it('returns binary views without copying each file into File objects', async () => {
		const raw = `--${B}\r\nContent-Disposition: form-data; name=f; filename=f\r\n\r\nbytes\r\n--${B}--\r\n`
		const fields = await parseMultipartBytes(request(raw), 1024)
		const file = fields.f
		expect(typeof file).toBe('object')
		if (typeof file === 'string' || file == null) throw new Error('missing file')
		expect(file.name).toBe('f')
		expect(new TextDecoder().decode(file.bytes)).toBe('bytes')
	})
})
