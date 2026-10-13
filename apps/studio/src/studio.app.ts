import { Hono } from 'hono'
import { useWorkersLogger } from 'workers-tagged-logger'

import {
	canManageRoomById,
	getPlayerIdsInRoomSubRoom,
	getRoomCoOwnerIds,
	getSubRoom,
} from '@repo/domain'
import { withNotFound, withOnError } from '@repo/hono-helpers'
import { validateAndGetAccountId, validateAndGetRoles } from '@repo/jwt'

import { listCloudBuilds, storeLocalCloudBuild } from './local-builds'
import { MultipartTooLarge, parseMultipartBytes } from './multipart'

import type { Context } from 'hono'
import type { App } from './context'
import type { MultipartBytesFields } from './multipart'

/**
 * A query id the editor already validated as a positive integer. Anything else is
 * treated as "no such room" rather than an error: a non-2xx makes Studio throw
 * before it can show the empty co-owner list.
 */
function positiveId(raw: string | undefined): number | null {
	if (raw == null || !/^[1-9]\d*$/.test(raw)) return null
	const id = Number(raw)
	return Number.isSafeInteger(id) ? id : null
}

const BUNDLE_REQUIRED = 'Both a Windows bundle and an Android bundle are required.'
const WINDOWS_REQUIRED = 'A Windows bundle is required.'
const INVALID_BUNDLE = 'Every uploaded bundle must have a UnityFS header.'
const MAX_UPLOAD_BYTES = 64 * 1024 * 1024
const UPLOAD_FIRST = 'Upload a room save first, and select a save that belongs to this subroom.'
const NOT_AUTHORIZED =
	'You do not have authorization to upload RecFlare Studio content at this time.'

/** `skip` >= 0 and `take` > 0, or the editor gets an empty page instead of an error. */
function cloudBuildPage(c: Context<App>): {
	roomId: number
	subRoomId: number
	skip: number
	take: number
} | null {
	const roomId = positiveId(c.req.query('roomId'))
	const subRoomId = positiveId(c.req.query('subRoomId'))
	const skipRaw = c.req.query('skip')
	const takeRaw = c.req.query('take')
	if (roomId == null || subRoomId == null || skipRaw == null || takeRaw == null) return null
	if (!/^\d+$/.test(skipRaw) || !/^[1-9]\d*$/.test(takeRaw)) return null
	const skip = Number(skipRaw)
	const take = Number(takeRaw)
	if (!Number.isSafeInteger(skip) || !Number.isSafeInteger(take)) return null
	return { roomId, subRoomId, skip, take: Math.min(take, 100) }
}

function rejected(c: Context<App>, status: 400 | 403 | 404 | 413, error: string) {
	return c.json({ success: false, error, value: null }, status)
}

function formText(form: MultipartBytesFields, name: string): string | undefined {
	const value = form[name]
	return typeof value === 'string' ? value : undefined
}

/** Basename, then anything outside the bundle filename alphabet becomes `_`. */
function bundleFilename(name: string): string {
	const base = name.split(/[/\\]/).pop() ?? ''
	const cleaned = base.replace(/[^A-Za-z0-9._-]/g, '_')
	return cleaned.length > 0 ? cleaned : 'bundle.assetbundle'
}

function bundlePart(
	form: MultipartBytesFields,
	field: string,
	platform: 'windows' | 'android',
	kind: 'main' | 'stripped'
) {
	const value = form[field]
	if (value == null || typeof value === 'string' || value.bytes.byteLength === 0) return null
	return {
		platform,
		kind,
		filename: bundleFilename(value.name),
		bytes: value.bytes,
	}
}

/**
 * The editor builds bundles on the creator's PC and posts them here. Android may
 * be omitted only with an explicit Windows-only opt-in. This is not `cloud-builds/create` (that one only names a save and
 * waits for a server build). The pair is stored as a cloud build that is already
 * finished, on the explicitly selected save or the latest staged/current save.
 */
async function postLocalCloudBuild(c: Context<App>) {
	const secret = await c.env.JWT_SECRET.get()
	const accountId = await validateAndGetAccountId(c.req.raw, secret)
	const roles = await validateAndGetRoles(c.req.raw, secret)
	if (accountId == null || roles == null) return c.body(null, 401)
	// Same claim the editor treats as Full Studio access. Developer does not confer it.
	if (!roles.includes('betastudio')) return rejected(c, 403, NOT_AUTHORIZED)

	// Not `c.req.parseBody()`: the editor leaves its form-data names unquoted, which the
	// runtime's parser rejects outright. See multipart.ts.
	let form: MultipartBytesFields
	try {
		form = await parseMultipartBytes(c.req.raw, MAX_UPLOAD_BYTES)
	} catch (err) {
		if (err instanceof MultipartTooLarge) {
			return rejected(c, 413, 'The multipart upload must be at most 64 MiB.')
		}
		throw err
	}

	const roomId = positiveId(formText(form, 'roomId'))
	if (roomId == null) return rejected(c, 404, 'No such room.')
	const allowed = await canManageRoomById(c.env.DB, roomId, accountId)
	if (allowed == null) return rejected(c, 404, 'No such room.')
	if (!allowed) return rejected(c, 403, 'This account cannot upload a build for that room.')

	const subRoomId = positiveId(formText(form, 'subRoomId'))
	if (subRoomId == null) return rejected(c, 404, 'No such subroom.')
	const sub = await getSubRoom(c.env.DB, roomId, subRoomId)
	if (!sub) return rejected(c, 404, 'No such subroom.')

	const requestedSave = formText(form, 'subRoomDataSaveId')
	const requestedSaveId = requestedSave == null ? undefined : positiveId(requestedSave)
	if (requestedSaveId === null) return rejected(c, 400, 'Invalid subRoomDataSaveId.')
	const windowsOnly = formText(form, 'allowWindowsOnly')?.toLowerCase() === 'true'
	const windows = bundlePart(form, 'windows', 'windows', 'main')
	const android = bundlePart(form, 'android', 'android', 'main')
	if (!windows || (!android && !windowsOnly)) {
		return rejected(c, 400, windowsOnly ? WINDOWS_REQUIRED : BUNDLE_REQUIRED)
	}
	const files = android ? [windows, android] : [windows]
	const windowsStripped = bundlePart(form, 'windowsStripped', 'windows', 'stripped')
	const androidStripped = bundlePart(form, 'androidStripped', 'android', 'stripped')
	if (windowsStripped) files.push(windowsStripped)
	if (androidStripped && !android) {
		return rejected(c, 400, 'An Android stripped bundle requires an Android main bundle.')
	}
	if (androidStripped) files.push(androidStripped)
	const signature = new TextEncoder().encode('UnityFS\0')
	if (files.some((file) => signature.some((byte, i) => file.bytes[i] !== byte))) {
		return rejected(c, 400, INVALID_BUNDLE)
	}

	const stored = await storeLocalCloudBuild(
		c.env.DB,
		c.env.CDN_ASSETS,
		roomId,
		subRoomId,
		accountId,
		files,
		requestedSaveId
	)
	if (!stored) return rejected(c, 400, UPLOAD_FIRST)

	return c.json({
		success: true,
		error: null,
		value: {
			cloudBuildId: stored.cloudBuildId,
			startedAt: stored.startedAt,
			completedAt: stored.completedAt,
			error: stored.error,
			unityAssetId: stored.unityAssetId,
			createdByAccountId: stored.createdByAccountId,
			subRoomDataSaveId: stored.subRoomDataSaveId,
		},
	})
}

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

	// The editor lists a room's cloud builds with
	// GET /cloud-builds/for-room?roomId=&subRoomId=&skip=&take= on this host.
	// Studio reads `results` and `totalResults` (camelCase, not a Result wrapper)
	// and treats any non-2xx as failure. No bearer: the panel asks even when the
	// sign-in state is unclear, and a 401 would blank the list as an error.
	// A bad id, skip, or take is an empty page for the same reason.
	.get('/cloud-builds/for-room', async (c) => {
		const page = cloudBuildPage(c)
		if (page == null) return c.json({ results: [], totalResults: 0 })
		return c.json(
			await listCloudBuilds(c.env.DB, page.roomId, page.subRoomId, page.skip, page.take)
		)
	})

	// Local Windows + Android bundles from the editor button under Upload.
	.post('/cloud-builds/from-editor', (c) => postLocalCloudBuild(c))

	// Studio asks how often it may request cloud builds. Stubbed: this server
	// never queues a real cloud build (every build is local, see from-editor),
	// so the numbers are permissive placeholders. The field names are an
	// ASSUMPTION — what the editor reads from this response has not been
	// observed; adjust once it has.
	.get('/cloud-builds/get-rate-limit-config', (c) =>
		c.json({
			maxBuildsPerHour: 100,
			maxConcurrentBuilds: 10,
			cooldownSeconds: 0,
		})
	)

	// Who of this room's co-owners is standing in this subroom right now. Studio
	// shows them as "Co-owners in Room" and reads a Result<List<int>>: `success`
	// must be true and `error` null, or the editor throws; `value` is those
	// account ids (camelCase). An empty list is the "nobody here" state.
	//
	// Co-owners are the room's creator plus every Creator/CoOwner role. Presence
	// has to name this roomId AND this subRoomId — a co-owner in another subroom,
	// or in another room, is not in the list. Hosts and moderators are not
	// co-owners, and a pending co-owner invite is not a role yet.
	.get('/collaboration/owners-in-room', async (c) => {
		const accountId = await validateAndGetAccountId(c.req.raw, await c.env.JWT_SECRET.get())
		if (accountId == null) return c.body(null, 401)

		const roomId = positiveId(c.req.query('roomId'))
		const subRoomId = positiveId(c.req.query('subRoomId'))
		if (roomId == null || subRoomId == null) {
			return c.json({ success: true, error: null, value: [] })
		}

		const coOwners = await getRoomCoOwnerIds(c.env.DB, roomId)
		if (coOwners == null || coOwners.length === 0) {
			return c.json({ success: true, error: null, value: [] })
		}
		const present = new Set(await getPlayerIdsInRoomSubRoom(c.env.DB, roomId, subRoomId))
		return c.json({
			success: true,
			error: null,
			value: coOwners.filter((id) => present.has(id)),
		})
	})

export default app
