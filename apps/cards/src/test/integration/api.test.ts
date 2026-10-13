import { adminSecretsStore, env, SELF } from 'cloudflare:test'
import { sign } from 'hono/jwt'
import { beforeAll, expect, it } from 'vitest'

import type { Env } from '../../context'

declare module 'cloudflare:test' {
	interface ProvidedEnv extends Env {}
}

beforeAll(async () => {
	await adminSecretsStore(env.JWT_SECRET).create('cards-test-secret')
})

async function bearer() {
	const token = await sign(
		{ sub: '205', exp: Math.floor(Date.now() / 1000) + 60 },
		'cards-test-secret',
		'HS256'
	)
	return { Authorization: `Bearer ${token}` }
}

it('response with hello world', async () => {
	const res = await SELF.fetch('https://example.com')
	expect(res.status).toBe(200)
	expect(await res.text()).toMatchInlineSnapshot(`"hello, world!"`)
})

it('in-app message channels return a bare list and require authentication', async () => {
	const url = 'https://example.com/iam/me/channels/Announcements'
	expect((await SELF.fetch(url)).status).toBe(401)
	for (const channel of ['Announcements', 'JustInTimeTutorials', 'None']) {
		const response = await SELF.fetch(`https://example.com/iam/me/channels/${channel}`, {
			headers: await bearer(),
		})
		expect(response.status).toBe(200)
		expect(await response.json()).toEqual([])
	}
	expect(
		(await SELF.fetch('https://example.com/iam/me/channels/Unknown', { headers: await bearer() }))
			.status
	).toBe(400)
})
