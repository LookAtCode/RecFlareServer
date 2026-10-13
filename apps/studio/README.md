# studio

The RecFlare Studio host (`https://studio.<domain>`).

Device login stays on Auth, `GET /account/me` stays on Accounts, and the approval
page is WWW `/device`. This worker answers the editor's build list, stores a
locally built Windows and Android bundle pair, and answers the co-owner
presence list. It does not serve the bundle bytes. A stored build is loaded from
Rooms (the save's `UnityAssetId`, save history, and baked Unity asset lookups)
and from the bucket at `/room/{filename}`.

The RecFlareStudio editor extension can upload a Windows-only build with multipart
`allowWindowsOnly=true`. Otherwise Windows and Android are both required. Optional
`subRoomDataSaveId` pins the upload to that exact save within the requested subroom;
without it, the staged save is preferred, falling back to the published current save.
Attaching a bundle does not publish the save. Publish it through the room's normal
save controls, and restrict a Windows-only room to Windows in the room settings.

Every main or stripped file must begin with `UnityFS\0`. Multipart requests are
limited to **64 MiB total**, including form headers. The bounded reader validates
both declared and streamed sizes and exposes views into one request buffer to avoid
copying each bundle into multiple full-size objects. This is an upload limit, not a
claim that larger Studio scenes can be built remotely.

The success `value` includes `subRoomDataSaveId`, a GUID string `cloudBuildId`, and
the server-assigned GUID `unityAssetId`. Account Studio access (`betastudio`) and
creator/co-owner checks apply to all modes. There is no cloud build executor here.

| Method | Path                            | Purpose                                                                                                                                                                                                                                                      |
| ------ | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET`  | `/cloud-builds/for-room`        | Cloud builds for that room and subroom, newest first (`results`, `totalResults`). Query: `roomId`, `subRoomId`, `skip`, `take`. A bad query is an empty page.                                                                                                |
| `POST` | `/cloud-builds/from-editor`     | Multipart bundle set: Windows required, Android required unless `allowWindowsOnly=true`. Optional stripped bundles and exact `subRoomDataSaveId`; otherwise staged/current save. Stores a finished build. Requires `betastudio` and creator/co-owner access. |
| `GET`  | `/collaboration/owners-in-room` | Account ids of the room's co-owners (creator, or a Creator/CoOwner role) whose live presence is in that `roomId` and `subRoomId`. Body: `{ success: true, error: null, value: number[] }`. Bearer required.                                                  |

## Development

### Run in dev mode

```sh
pnpm dev
```

### Run tests

```sh
pnpm test
```

For a portable protocol test with Node 24's SQLite implementation, use
`pnpm exec vitest run --config vitest.node.config.ts` from `apps/studio`. This runs
the real Hono routes with database transactions and an in-memory R2 adapter;
the standard suite above still verifies behavior inside the Workers runtime.

### Deploy

```sh
pnpm turbo deploy
```

### Migrate

This worker owns `studio_cloud_build` on the shared `recflare` database (`migrations/`,
tracked in its own `d1_migrations_studio` table). The bundles themselves are rows of the
rooms worker's `unity_asset` (one per platform and kind: target 0 Windows / 2 Android,
`studio/<roomId>/<name>.assetbundle` as `filename` — the bytes sit at `room/<filename>` in
the bucket, the prefix the client adds — base64 SHA-256 as `hash`), so a stored build needs
the rooms migrations too. Deploying does not apply either.

```sh
just migrate -F studio             # remote
just migrate -F studio -- --local  # dev db
```
