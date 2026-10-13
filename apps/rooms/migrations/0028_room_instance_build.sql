-- A room instance's `gameVersion` is now a BUILD — the bare `YYYYMMDD` — rather than the
-- client's full version. The `.NN` after the date is a same-day point release of the
-- same build: it changes nothing a session keys on, so `20250718.01` and `20250718.2`
-- belong in one Photon room, and `SUPPORTED_GAME_VERSIONS` lists dates alone.
--
-- Matchmaking now stamps the build (createRoomInstance runs the value through
-- `gameBuild`) and every lookup normalizes its argument the same way, so a row still
-- carrying `20250718.01` would match NOBODY from here on: a 20250718 player's search is
-- `game_version = '20250718'`. Strip the point release off every live row so the sessions
-- open at the moment of the deploy stay joinable. Rows with no `.` (already bare, or the
-- NULL of a row older than the stamp) are left exactly as they are.
--
-- `game_version` is a virtual column over the `data` blob (0012), so the blob is what's
-- rewritten; the column follows.

UPDATE room_instance
   SET data = json_set(data, '$.gameVersion', substr(game_version, 1, instr(game_version, '.') - 1))
 WHERE game_version LIKE '%.%';
