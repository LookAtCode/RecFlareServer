import {
	deleteUnityAssetBuilds,
	getSubRoom,
	getSubRoomSaveById,
	markRoomAsRecRoomStudio,
	publicStudioBundleFilename,
	setSubRoomSaveUnityAssetId,
	STUDIO_ASSET_VERSION,
	studioAssetTarget,
	studioBundleR2Key,
	unityAssetUpsert,
} from '@repo/domain'

import type { StudioBundlePlatform, UnityAssetKind } from '@repo/domain'

export interface CloudBuildRow {
	cloudBuildId: string
	startedAt: string
	completedAt: string | null
	error: string | null
	unityAssetId: string
	createdByAccountId: number
}

export type BundlePlatform = StudioBundlePlatform
export type BundleKind = UnityAssetKind

export interface LocalBundleFile {
	platform: BundlePlatform
	kind: BundleKind
	filename: string
	bytes: Uint8Array<ArrayBuffer>
}

export interface StoredLocalBuild extends CloudBuildRow {
	subRoomDataSaveId: number
}

interface BuildListRow {
	cloud_build_id: string
	started_at: string
	completed_at: string | null
	error: string | null
	unity_asset_id: string
	created_by_account_id: number
}

function toCloudBuild(row: BuildListRow): CloudBuildRow {
	return {
		cloudBuildId: row.cloud_build_id,
		startedAt: row.started_at,
		completedAt: row.completed_at,
		error: row.error,
		unityAssetId: row.unity_asset_id,
		createdByAccountId: row.created_by_account_id,
	}
}

/** Page of cloud builds for one subroom, newest first. `total` counts the whole subroom. */
export async function listCloudBuilds(
	db: D1Database,
	roomId: number,
	subRoomId: number,
	skip: number,
	take: number
): Promise<{ results: CloudBuildRow[]; totalResults: number }> {
	const total = await db
		.prepare(
			`SELECT COUNT(*) AS n FROM studio_cloud_build
			 WHERE room_id = ?1 AND sub_room_id = ?2`
		)
		.bind(roomId, subRoomId)
		.first<{ n: number | string }>()
	const { results } = await db
		.prepare(
			`SELECT cloud_build_id, started_at, completed_at, error, unity_asset_id, created_by_account_id
			 FROM studio_cloud_build
			 WHERE room_id = ?1 AND sub_room_id = ?2
			 ORDER BY started_at DESC, cloud_build_id DESC
			 LIMIT ?3 OFFSET ?4`
		)
		.bind(roomId, subRoomId, take, skip)
		.all<BuildListRow>()
	return { results: results.map(toCloudBuild), totalResults: Number(total?.n ?? 0) }
}

/** Base64 SHA-256 — the encoding `unity_asset.hash` (and every other bundle hash) uses. */
async function sha256Base64(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', bytes)
	let binary = ''
	for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte)
	return btoa(binary)
}

/**
 * Store a PC-built bundle set as a cloud build that is already finished.
 * The bytes go to R2 under `room/` and each bundle becomes a `unity_asset` row — target
 * 0 Windows / 2 Android, its kind, the `filename` the client prefixes with `/room/` to
 * download it (so the R2 key is `room/<filename>`), the base64 SHA-256 as `hash`. The
 * build row points at the requested save (otherwise staged, then current), its `UnityAssetId` is set
 * to the new asset, and the room is marked as a Studio room the first time
 * (`BecameRRStudioRoomAt`).
 *
 * Returns null when the target save is absent or belongs to another subroom.
 */
export async function storeLocalCloudBuild(
	db: D1Database,
	bucket: R2Bucket,
	roomId: number,
	subRoomId: number,
	accountId: number,
	files: LocalBundleFile[],
	requestedSaveId?: number
): Promise<StoredLocalBuild | null> {
	const sub = await getSubRoom(db, roomId, subRoomId)
	if (!sub) return null
	const current = sub.CurrentSave
	const currentSaveId =
		current && typeof current === 'object'
			? Number((current as { SubRoomDataSaveId?: unknown }).SubRoomDataSaveId)
			: NaN
	// Upload normally stages the new revision. Attaching to CurrentSave would replace
	// the published room's bundles while leaving the creator's draft without a build.
	const saveId = requestedSaveId ?? sub.StagedSubRoomDataSaveId ?? currentSaveId
	if (typeof saveId !== 'number' || !Number.isSafeInteger(saveId) || saveId <= 0) return null
	if (!(await getSubRoomSaveById(db, subRoomId, saveId))) return null

	const now = new Date().toISOString()
	const cloudBuildId = crypto.randomUUID()
	const unityAssetId = crypto.randomUUID()

	const stored: Array<LocalBundleFile & { hash: string }> = []
	try {
		for (const file of files) {
			// The client downloads `/room/<filename>` from the bucket, so the stored name is
			// this build's, not the uploaded basename two rooms can share.
			const filename = publicStudioBundleFilename(roomId, unityAssetId, file.platform, file.kind)
			const hash = await sha256Base64(file.bytes)
			await bucket.put(studioBundleR2Key(filename), file.bytes)
			stored.push({ ...file, filename, hash })
		}
	} catch (err) {
		await Promise.all(stored.map((file) => bucket.delete(studioBundleR2Key(file.filename))))
		throw err
	}

	const discardObjects = () =>
		Promise.all(stored.map((file) => bucket.delete(studioBundleR2Key(file.filename))))
	try {
		await db.batch([
			...stored.map((file) =>
				unityAssetUpsert(
					db,
					{
						UnityAssetId: unityAssetId,
						Target: studioAssetTarget(file.platform),
						Version: STUDIO_ASSET_VERSION,
						Filename: file.filename,
						Hash: file.hash,
					},
					file.kind
				)
			),
			db
				.prepare(
					`INSERT INTO studio_cloud_build
					 (cloud_build_id, room_id, sub_room_id, sub_room_data_save_id, unity_asset_id,
					  created_by_account_id, started_at, completed_at, error)
					 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7, NULL)`
				)
				.bind(cloudBuildId, roomId, subRoomId, saveId, unityAssetId, accountId, now),
		])
	} catch (err) {
		await discardObjects()
		throw err
	}

	const linked = await setSubRoomSaveUnityAssetId(db, subRoomId, saveId, unityAssetId)
	if (!linked) {
		await db
			.prepare('DELETE FROM studio_cloud_build WHERE cloud_build_id = ?1')
			.bind(cloudBuildId)
			.run()
		await deleteUnityAssetBuilds(db, unityAssetId)
		await discardObjects()
		return null
	}
	await markRoomAsRecRoomStudio(db, roomId, now)

	return {
		cloudBuildId,
		startedAt: now,
		completedAt: now,
		error: null,
		unityAssetId,
		createdByAccountId: accountId,
		subRoomDataSaveId: saveId,
	}
}
