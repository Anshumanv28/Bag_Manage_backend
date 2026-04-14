-- Allow multiple active bookings per candidate and per rack (ambiguous mappings → flagged_bookings).
DROP INDEX IF EXISTS "bookings_one_active_candidate_id";
DROP INDEX IF EXISTS "bookings_one_active_rack_id";
