-- Indexes and stored columns found by measuring the busiest queries against 10,000 people (docs/PERFORMANCE.md).

-- Search of posts and projects scored every candidate by building its text vector again, twice (once to test, once to rank). A common word matches a fifth of all posts, so the
-- vector is now stored, computed by the database whenever the row changes, and indexed: the search reads it instead of making it. Same function, same text, same results.
ALTER TABLE "ShipPost" ADD COLUMN "searchVec" tsvector GENERATED ALWAYS AS (search_vec("title", left("body", 4000), search_join("stackTags"))) STORED;
CREATE INDEX "ShipPost_searchVec_idx" ON "ShipPost" USING GIN ("searchVec");
DROP INDEX "ShipPost_search_vec_idx";

ALTER TABLE "Project" ADD COLUMN "searchVec" tsvector GENERATED ALWAYS AS (search_vec("name", "shortDesc", search_join("techStack"), left("description", 2000))) STORED;
CREATE INDEX "Project_searchVec_idx" ON "Project" USING GIN ("searchVec");
DROP INDEX "Project_search_vec_idx";

-- Discover's text filter is a case-insensitive "contains" on four columns of every person: a trigram index serves ILIKE '%word%' where a scan of the table did.
CREATE INDEX "User_name_trgm_idx" ON "User" USING GIN ("name" gin_trgm_ops);
CREATE INDEX "User_username_trgm_idx" ON "User" USING GIN ("username" gin_trgm_ops);
CREATE INDEX "User_headline_trgm_idx" ON "User" USING GIN ("headline" gin_trgm_ops);
CREATE INDEX "User_bio_trgm_idx" ON "User" USING GIN ("bio" gin_trgm_ops);

-- A person's rank is the number of people with more XP: counted on User.xp (the cache of the log's total) instead of grouping the whole log.
CREATE INDEX "User_xp_idx" ON "User" ("xp");
-- The list of deleted accounts the lists leave out (a handful of rows among thousands).
CREATE INDEX "User_deleted_idx" ON "User" ("id") WHERE "deletedAt" IS NOT NULL;

-- Looked up by person and skill (the counts on a passport), by owner (the projects of a set of people, newest first), and listed by time (notifications).
CREATE INDEX "SkillEvidence_userId_skillId_idx" ON "SkillEvidence" ("userId", "skillId");
CREATE INDEX "Project_ownerId_updatedAt_idx" ON "Project" ("ownerId", "updatedAt");
CREATE INDEX "Notification_userId_createdAt_idx" ON "Notification" ("userId", "createdAt");
