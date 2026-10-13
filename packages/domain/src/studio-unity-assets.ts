/**
 * Rec Room Studio cloud builds.
 *
 * The editor builds Windows and Android asset bundles on the creator's PC and posts them
 * to the `studio` worker, which stores the bytes in the shared `recflare-cdn` bucket,
 * records each bundle as a row of `unity_asset` (see unity-assets-db.ts — the same table
 * the game's bulk lookup reads) and files the build itself in `studio_cloud_build`, the
 * one table this module describes. The studio migration owns that table; this module
 * reads it, and tests apply {@link STUDIO_CLOUD_BUILD_SCHEMA_DDL} directly.
 *
 * A room load must keep working before that migration has been applied, so a missing
 * table is reported by {@link isMissingStudioAssetTable} and the caller falls back to
 * whatever it knows without the build record.
 */

import { listUnityAssetBuilds } from './unity-assets-db'

import type { UnityAssetBuild } from './unity-assets-db'

/** Schema DDL (mirror of apps/studio/migrations/0001_studio_cloud_build.sql, less the dropped file table). */
export const STUDIO_CLOUD_BUILD_SCHEMA_DDL: string[] = [
	`CREATE TABLE IF NOT EXISTS studio_cloud_build (
		cloud_build_id TEXT PRIMARY KEY,
		room_id INTEGER NOT NULL,
		sub_room_id INTEGER NOT NULL,
		sub_room_data_save_id INTEGER NOT NULL,
		unity_asset_id TEXT NOT NULL,
		created_by_account_id INTEGER NOT NULL,
		started_at TEXT NOT NULL,
		completed_at TEXT NOT NULL,
		error TEXT
	)`,
	`CREATE INDEX IF NOT EXISTS idx_studio_cloud_build_room
		ON studio_cloud_build (room_id, sub_room_id, started_at)`,
]

/** The `Version` stamped on every bundle a Studio build stores. */
export const STUDIO_ASSET_VERSION = 1

/** The platforms a local Studio build posts, named as the multipart fields name them. */
export type StudioBundlePlatform = 'windows' | 'android'

/** Where every Studio (UGC) bundle filename starts; see {@link publicStudioBundleFilename}. */
const STUDIO_BUNDLE_PREFIX = 'studio/'

/**
 * A Studio bundle's `unity_asset.filename` — the name the client downloads, which it
 * prefixes with `/room/` (see {@link studioBundleR2Key}). Laid out like the official
 * game's room assets (`unity/<roomId>/<name>.assetbundle`) with `studio` in place of
 * `unity`, so a room's bundles sit together under its id. Unique per build, platform,
 * and kind, so two rooms that both uploaded `win.assetbundle` cannot collide.
 */
export function publicStudioBundleFilename(
	roomId: number,
	unityAssetId: string,
	platform: StudioBundlePlatform,
	kind: string
): string {
	const id = unityAssetId.replace(/-/g, '').toLowerCase()
	return `${STUDIO_BUNDLE_PREFIX}${roomId}/${id}.${platform}.${kind}.assetbundle`
}

/**
 * Whether a `unity_asset` filename is a Rec Room Studio build — UGC the studio worker
 * wrote — as opposed to a first-party bundle loaded by hand under the game's own
 * `unity/<roomId>/` layout. The two share the table, and only the Studio ones are
 * folded onto a save's `UnitySubAssets`: a 2025 client handed a first-party bundle
 * inline takes it instead of asking `POST /unity_assets/baked/bulk`, cannot name it
 * (its decoder reads `UnityAsset`/`UnityAssetHash`, not `Filename`/`Hash`), and loads
 * nothing. The bulk lookup serves both kinds.
 */
export function isStudioBundleFilename(filename: string): boolean {
	return filename.startsWith(STUDIO_BUNDLE_PREFIX)
}

/**
 * Where the bytes behind a `unity_asset.filename` live in the shared `recflare-cdn`
 * bucket. The game client fetches every room asset under `/room/`, straight from the
 * bucket, so the key is the filename with that prefix — `room/studio/<roomId>/<name>`.
 */
export function studioBundleR2Key(filename: string): string {
	return `room/${filename}`
}

/**
 * 0 for Windows, 2 for Android/Quest — the `Target` a bundle is stored under, the same
 * numbers the game sends as `unityAssetTarget` on a custom avatar.
 */
export function studioAssetTarget(platform: StudioBundlePlatform): number {
	return platform === 'android' ? 2 : 0
}

/** True when D1 failed because the studio cloud-build table has not been migrated. */
export function isMissingStudioAssetTable(err: unknown): boolean {
	const message = err instanceof Error ? err.message : String(err)
	return message.toLowerCase().includes('no such table')
}

export interface StudioUnityAssetRecord {
	unityAssetId: string
	/** 0 when the cloud-build row is gone. The route can fall back to the save's author. */
	createdByAccountId: number
	/** Every stored bundle of the asset, stripped ones included. */
	builds: UnityAssetBuild[]
}

/**
 * One unity asset and the account that built it. Null when no bundle is stored. A
 * missing cloud-build table leaves `createdByAccountId` at 0.
 */
export async function getStudioUnityAsset(
	db: D1Database,
	unityAssetId: string
): Promise<StudioUnityAssetRecord | null> {
	const builds = await listUnityAssetBuilds(db, [unityAssetId])
	if (builds.length === 0) return null
	let createdByAccountId = 0
	try {
		const row = await db
			.prepare(
				`SELECT created_by_account_id FROM studio_cloud_build
				 WHERE unity_asset_id = ?1 ORDER BY started_at DESC LIMIT 1`
			)
			.bind(unityAssetId)
			.first<{ created_by_account_id: number }>()
		if (row) createdByAccountId = row.created_by_account_id
	} catch (err) {
		if (!isMissingStudioAssetTable(err)) throw err
	}
	return { unityAssetId, createdByAccountId, builds }
}
