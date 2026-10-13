/**
 * Baked unity asset bundles — the blob references behind a room's asset-bundle download.
 *
 * `unity_asset` holds one row per BUILD of a unity asset: the asset's GUID, the `Target`
 * it was built for (0 Windows, 2 Android/Quest — the same numbers a custom avatar's
 * `unityAssetTarget` uses), its `Version`, the `Kind` of bundle (`main`, the scene the
 * client loads; `stripped`, the editor-only variant the Studio upload also stores), and
 * the storage blob the client downloads (`Filename`, fetched as `/room/<Filename>` straight
 * from the shared `recflare-cdn` bucket, and its base64 SHA-256 `Hash`).
 *
 * Two things read it. The client asks for main bundles in bulk from
 * `POST /unity_assets/baked/bulk` (the `rooms` worker) while loading a room — the step
 * Player.log times as `AssetBundle_Download` — and `GET /rooms/{id}` folds the STUDIO
 * main bundles (filenames under `studio/`, see `isStudioBundleFilename`) onto
 * `CurrentSave.UnitySubAssets`. A first-party bundle loaded by hand under `unity/<roomId>/`
 * is served by the bulk lookup only; either way the client then downloads
 * `/room/<Filename>` from the bucket, and a lookup that answers no row,
 * or a row without a `Filename`, simply downloads nothing, with no error anywhere.
 *
 * The `studio` worker writes it: a Rec Room Studio build posts a Windows + Android bundle
 * pair (plus optional stripped ones), stored here at {@link STUDIO_ASSET_VERSION} with the
 * cloud-build record in `studio_cloud_build` (see studio-unity-assets.ts).
 *
 * The `rooms` worker owns the table and its migrations — see
 * apps/rooms/migrations/0024_unity_asset.sql and 0026_unity_asset_kind.sql.
 */

import { bindPlaceholders, chunkForBinds } from './d1-binds'

/** Schema DDL (mirror of apps/rooms/migrations/0026_unity_asset_kind.sql) — tests apply this. */
export const UNITY_ASSET_SCHEMA_DDL: string[] = [
	// A unity asset is built once per target and kind, and may be rebuilt at a new version,
	// so the four together name a row. `unity_asset_id` is stored lowercase: a GUID's case
	// is not part of its identity and the client is not consistent about it.
	`CREATE TABLE IF NOT EXISTS unity_asset (
		unity_asset_id TEXT NOT NULL,
		target INTEGER NOT NULL,
		version INTEGER NOT NULL,
		kind TEXT NOT NULL DEFAULT 'main',
		filename TEXT NOT NULL,
		hash TEXT NOT NULL,
		PRIMARY KEY (unity_asset_id, target, version, kind)
	)`,
]

/**
 * Which bundle of a build a row is. `main` is the scene the game loads; `stripped` is the
 * editor-only variant Rec Room Studio uploads beside it, stored but never listed to the
 * game — a client that loaded every row would replace the scene with the stripped one.
 */
export type UnityAssetKind = 'main' | 'stripped'

/**
 * One baked bundle as the client reads it — its five-key DTO, in this order. An element of
 * the bare array `POST /unity_assets/baked/bulk` answers, and of a save's `UnitySubAssets`.
 */
export interface BakedUnityAsset {
	/** GUID. */
	UnityAssetId: string
	/** 0 Windows, 2 Android/Quest. */
	Target: number
	Version: number
	/** The storage blob the client downloads, as `/room/<Filename>` from the bucket. */
	Filename: string
	/** Base64 SHA-256 of the blob. */
	Hash: string
}

/** One stored row: a baked bundle and which kind of bundle it is. */
export interface UnityAssetBuild extends BakedUnityAsset {
	Kind: UnityAssetKind
}

interface UnityAssetRow {
	unity_asset_id: string
	target: number
	version: number
	kind: string
	filename: string
	hash: string
}

const toBakedUnityAsset = (row: UnityAssetRow): BakedUnityAsset => ({
	UnityAssetId: row.unity_asset_id,
	Target: row.target,
	Version: row.version,
	Filename: row.filename,
	Hash: row.hash,
})

const toUnityAssetBuild = (row: UnityAssetRow): UnityAssetBuild => ({
	...toBakedUnityAsset(row),
	Kind: row.kind === 'stripped' ? 'stripped' : 'main',
})

/**
 * The statement that records a build, for callers that batch it with other writes.
 * Replaces the row for the same (asset, target, version, kind).
 */
export function unityAssetUpsert(
	db: D1Database,
	asset: BakedUnityAsset,
	kind: UnityAssetKind = 'main'
): D1PreparedStatement {
	return db
		.prepare(
			`INSERT OR REPLACE INTO unity_asset (unity_asset_id, target, version, kind, filename, hash)
			 VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
		)
		.bind(
			asset.UnityAssetId.toLowerCase(),
			asset.Target,
			asset.Version,
			kind,
			asset.Filename,
			asset.Hash
		)
}

/** Record a build. Replaces the row for the same (asset, target, version, kind). */
export async function putUnityAsset(
	db: D1Database,
	asset: BakedUnityAsset,
	kind: UnityAssetKind = 'main'
): Promise<void> {
	await unityAssetUpsert(db, asset, kind).run()
}

/** Forget every build of `unityAssetId`, all targets and kinds. The blobs stay in R2. */
export async function deleteUnityAssetBuilds(db: D1Database, unityAssetId: string): Promise<void> {
	await db
		.prepare('DELETE FROM unity_asset WHERE unity_asset_id = ?1')
		.bind(unityAssetId.toLowerCase())
		.run()
}

/**
 * The main bundles for `unityAssetIds` on `target` — one entry per asset that has one, in
 * the order asked, assets with no build left out. An asset built more than once is served
 * ONCE: the build at the requested `version` when there is one, otherwise the newest. The
 * request's version is a preference, not a filter, because the one capture pairing the two
 * (a request for version 3 answered with version 227) shows the reference did not require
 * them to match, and an empty answer here is a room that silently loads nothing.
 *
 * Ids are matched case-insensitively and served as stored (lowercase). Nothing to ask
 * about reads nothing.
 */
export async function getBakedUnityAssets(
	db: D1Database,
	unityAssetIds: string[],
	target: number,
	version: number
): Promise<BakedUnityAsset[]> {
	const ids = [...new Set(unityAssetIds.map((id) => id.toLowerCase()))]
	if (ids.length === 0) return []
	const pages = await Promise.all(
		chunkForBinds(ids, 2).map((chunk) =>
			db
				.prepare(
					`SELECT unity_asset_id, target, version, kind, filename, hash FROM unity_asset
					 WHERE target = ?1 AND kind = 'main'
					   AND unity_asset_id IN (${bindPlaceholders(chunk, 2)})
					 ORDER BY (version = ?2) DESC, version DESC`
				)
				.bind(target, version, ...chunk)
				.all<UnityAssetRow>()
		)
	)
	// Rows arrive best-first per asset, so the first one seen for an id is the one to serve.
	const best = new Map<string, BakedUnityAsset>()
	for (const row of pages.flatMap((page) => page.results)) {
		if (!best.has(row.unity_asset_id)) best.set(row.unity_asset_id, toBakedUnityAsset(row))
	}
	return ids.flatMap((id) => best.get(id) ?? [])
}

/**
 * Every stored build of the given unity assets — all targets, versions and kinds. Ids are
 * matched case-insensitively and served as stored (lowercase). An empty id list reads
 * nothing.
 */
export async function listUnityAssetBuilds(
	db: D1Database,
	unityAssetIds: string[]
): Promise<UnityAssetBuild[]> {
	const ids = [...new Set(unityAssetIds.filter((id) => id !== '').map((id) => id.toLowerCase()))]
	if (ids.length === 0) return []
	const pages = await Promise.all(
		chunkForBinds(ids).map((chunk) =>
			db
				.prepare(
					`SELECT unity_asset_id, target, version, kind, filename, hash FROM unity_asset
					 WHERE unity_asset_id IN (${bindPlaceholders(chunk)})`
				)
				.bind(...chunk)
				.all<UnityAssetRow>()
		)
	)
	return pages.flatMap((page) => page.results).map(toUnityAssetBuild)
}

/**
 * The main bundles among `builds` as a save lists them: Windows then Android, the client's
 * five-key DTO. Stripped bundles are left off — see {@link UnityAssetKind}.
 */
export function bakedUnityAssets(builds: UnityAssetBuild[]): BakedUnityAsset[] {
	return builds
		.filter((build) => build.Kind === 'main')
		.map(({ Kind: _kind, ...baked }) => baked)
		.sort((a, b) => a.Target - b.Target || a.Filename.localeCompare(b.Filename))
}
