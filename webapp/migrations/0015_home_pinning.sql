-- Home-pinning for no-fix Find Hub reports.
--
-- Some Find Hub devices (stationary displays — a lounge/bedroom display) report
-- a "semantic" or fix-less location with no lat/lon, so they can't be mapped.
-- The user sets a single Home coordinate (settings: home_lat/home_lon) and opts
-- a source in via device_sources.pin_no_fix; the read path then plots that
-- source's no-fix reports at Home.
--
-- Crucially, the TRUE incoming data is never overwritten (latitude/longitude
-- stay NULL — that's the ground truth). The applied Home is SNAPSHOT per report
-- into pinned_latitude/pinned_longitude the first time it's read, and from then
-- on that row keeps its snapshot — so moving Home later only affects future
-- no-fix reports, never markers already pinned (the user's requirement).

ALTER TABLE reports ADD COLUMN pinned_latitude  REAL;  -- snapshot of Home at first read; NULL = not (yet) pinned
ALTER TABLE reports ADD COLUMN pinned_longitude REAL;

ALTER TABLE device_sources ADD COLUMN pin_no_fix INTEGER NOT NULL DEFAULT 0;  -- 1 = pin this source's no-fix reports to Home
