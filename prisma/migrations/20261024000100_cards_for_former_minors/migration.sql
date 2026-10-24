-- Share cards for people who were minors. "Show my cards on the web" defaults to on for adults, but an account that was under 18 at any point (a minor now, or an
-- account made before the 18th birthday) must not become public by turning 18: it is stored OFF until the person turns it on themselves.
-- Age at the day the account was made, by the UTC calendar (as the age policy counts it). An account with no date of birth says nothing and is left as it is.
UPDATE "Profile" p
SET "showCardsOnWeb" = false
FROM "User" u
WHERE u."id" = p."userId"
  AND u."birthDate" IS NOT NULL
  AND p."showCardsOnWeb" = true
  AND (u."birthDate" + interval '18 years')::date > (u."createdAt" AT TIME ZONE 'UTC')::date;

-- A person who has a date of birth that makes them a minor but no profile row yet gets one, with the switch off.
INSERT INTO "Profile" ("id", "userId", "showCardsOnWeb", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, u."id", false, now(), now()
FROM "User" u
WHERE u."birthDate" IS NOT NULL
  AND (u."birthDate" + interval '18 years')::date > (u."createdAt" AT TIME ZONE 'UTC')::date
  AND NOT EXISTS (SELECT 1 FROM "Profile" p WHERE p."userId" = u."id");
