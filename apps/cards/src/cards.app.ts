import { Hono } from 'hono'
import { useWorkersLogger } from 'workers-tagged-logger'

import { withNotFound, withOnError } from '@repo/hono-helpers'
import { validateAndGetAccountId } from '@repo/jwt'

import type { App } from './context'

const app = new Hono<App>()
	.use(
		'*',
		// middleware
		(c, next) =>
			useWorkersLogger(c.env.NAME, {
				environment: c.env.ENVIRONMENT,
				release: c.env.SENTRY_RELEASE,
			})(c, next)
	)

	.onError(withOnError())
	.notFound(withNotFound())

	.get('/', async (c) => {
		return c.text('hello, world!')
	})
	.get('/iam/me/channels/:channel', async (c) => {
		const accountId = await validateAndGetAccountId(c.req.raw, await c.env.JWT_SECRET.get())
		if (accountId === null) return c.body(null, 401)
		const channel = c.req.param('channel')
		if (!['None', 'Announcements', 'JustInTimeTutorials'].includes(channel)) {
			return c.body(null, 400)
		}
		// GetChannelMessages decodes a bare List<InAppMessageDTO>. No campaigns are configured.
		return c.json([])
	})

export default app
