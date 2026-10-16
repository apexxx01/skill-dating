-- The season participation badge is a BADGE now (it was an AVATAR_PART with nowhere to be worn). Seasons that
-- already closed created their badge row with the old type; seasons closed from now on create it as a BADGE.
UPDATE "Cosmetic" SET "type" = 'BADGE' WHERE "type" = 'AVATAR_PART' AND "slug" ~ '^season-[0-9]+-participant$';
