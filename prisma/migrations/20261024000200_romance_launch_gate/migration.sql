-- The romance mode ships closed. It opens where the flag "romance.enabled" says (the whole product, or a rollout share, or an allowlist), or where a city's flag
-- "romance.city.<country>-<city>" does (for example romance.city.in-pune); both are created off and changed with PATCH /api/admin/flags/{key}. "kill.romance" still closes it
-- everywhere at once. Until then the mode answers 503 ROMANCE_PAUSED and appears in no list a person reads.
INSERT INTO "FeatureFlag" ("id", "key", "description", "enabled", "rolloutPercent", "allowUserIds", "createdAt", "updatedAt")
VALUES (gen_random_uuid()::text, 'romance.enabled', 'Launch gate: the romance mode is open (OFF at launch; a city can be opened with romance.city.<country>-<city>). Owner: Trust & Safety lead.', false, 100, '{}', now(), now())
ON CONFLICT ("key") DO NOTHING;

-- CreateTable
CREATE TABLE "RomanceInterest" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "countryCode" VARCHAR(2),
    "cityKey" TEXT,
    "city" TEXT,
    "notifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RomanceInterest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RomanceInterest_userId_key" ON "RomanceInterest"("userId");

-- CreateIndex
CREATE INDEX "RomanceInterest_countryCode_cityKey_idx" ON "RomanceInterest"("countryCode", "cityKey");

-- CreateIndex
CREATE INDEX "RomanceInterest_notifiedAt_idx" ON "RomanceInterest"("notifiedAt");

-- AddForeignKey
ALTER TABLE "RomanceInterest" ADD CONSTRAINT "RomanceInterest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
