-- Search (src/lib/search, docs/SEARCH.md): PostgreSQL full-text search and trigram similarity.
--
-- pg_trgm gives typo-tolerant and prefix matching on names; unaccent makes both accent-insensitive. Both are contrib extensions every managed PostgreSQL offers.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;

-- unaccent() is only STABLE, so it cannot be used in an index. These wrappers are IMMUTABLE (the dictionary does not change under a running database), and they are
-- the one place that decides how text is normalised: every index below and every query in src/lib/search/postgres.ts calls them, so an index is always the
-- expression the query asks for.
CREATE OR REPLACE FUNCTION search_unaccent(text) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
  AS $$ SELECT public.unaccent('public.unaccent'::regdictionary, $1) $$;

-- Lower case, accents removed: what names and usernames are compared as.
CREATE OR REPLACE FUNCTION search_norm(text) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
  AS $$ SELECT lower(search_unaccent($1)) $$;

-- array_to_string is only STABLE; for text arrays it is safe to call it immutable.
CREATE OR REPLACE FUNCTION search_join(text[]) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE
  AS $$ SELECT array_to_string($1, ' ') $$;

-- The searchable text of a row as a tsvector: the 'simple' configuration (no stemming, no language assumptions), over text with accents removed. NULL parts are skipped.
CREATE OR REPLACE FUNCTION search_vec(VARIADIC parts text[]) RETURNS tsvector LANGUAGE sql IMMUTABLE PARALLEL SAFE
  AS $$ SELECT to_tsvector('simple', search_unaccent(array_to_string(parts, ' '))) $$;

-- People
CREATE INDEX "User_search_vec_idx" ON "User" USING GIN (search_vec("name", "username", "headline", "builderRole"));
CREATE INDEX "User_search_username_trgm_idx" ON "User" USING GIN (search_norm("username") gin_trgm_ops);
CREATE INDEX "User_search_name_trgm_idx" ON "User" USING GIN (search_norm("name") gin_trgm_ops);
CREATE INDEX "Skill_search_name_trgm_idx" ON "Skill" USING GIN (search_norm("name") gin_trgm_ops);

-- Projects
CREATE INDEX "Project_search_vec_idx" ON "Project" USING GIN (search_vec("name", "shortDesc", search_join("techStack"), left("description", 2000)));
CREATE INDEX "Project_search_name_trgm_idx" ON "Project" USING GIN (search_norm("name") gin_trgm_ops);

-- Crews and squads
CREATE INDEX "Team_search_vec_idx" ON "Team" USING GIN (search_vec("name", left("description", 2000), search_join("lookingFor")));
CREATE INDEX "Team_search_name_trgm_idx" ON "Team" USING GIN (search_norm("name") gin_trgm_ops);

-- Hackathons
CREATE INDEX "Hackathon_search_vec_idx" ON "Hackathon" USING GIN (search_vec("name", "shortDesc", "organizer", "city", "country", search_join("technologies")));
CREATE INDEX "Hackathon_search_name_trgm_idx" ON "Hackathon" USING GIN (search_norm("name") gin_trgm_ops);

-- Posts
CREATE INDEX "ShipPost_search_vec_idx" ON "ShipPost" USING GIN (search_vec("title", left("body", 4000), search_join("stackTags")));
CREATE INDEX "ShipPost_search_title_trgm_idx" ON "ShipPost" USING GIN (search_norm("title") gin_trgm_ops);
