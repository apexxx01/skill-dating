-- CreateEnum
CREATE TYPE "InviteKind" AS ENUM ('PERSONAL', 'CAMPAIGN');

-- CreateEnum
CREATE TYPE "InviteStatus" AS ENUM ('PENDING', 'QUALIFIED', 'REWARDED', 'REJECTED', 'EXPIRED');

-- CreateTable
CREATE TABLE "InviteCode" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "kind" "InviteKind" NOT NULL,
    "ownerId" TEXT,
    "label" TEXT,
    "campusId" TEXT,
    "maxUses" INTEGER,
    "uses" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3),
    "disabledAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InviteCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InviteRedemption" (
    "id" TEXT NOT NULL,
    "codeId" TEXT NOT NULL,
    "inviteeId" TEXT NOT NULL,
    "inviterId" TEXT,
    "status" "InviteStatus" NOT NULL DEFAULT 'PENDING',
    "reason" TEXT,
    "redeemedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "qualifiedAt" TIMESTAMP(3),
    "rewardedAt" TIMESTAMP(3),

    CONSTRAINT "InviteRedemption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Campus" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "emailDomains" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "city" TEXT,
    "cityKey" TEXT,
    "countryCode" TEXT,
    "disabledAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Campus_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampusMembership" (
    "userId" TEXT NOT NULL,
    "campusId" TEXT NOT NULL,
    "emailHash" TEXT NOT NULL,
    "verifiedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CampusMembership_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "CampusVerification" (
    "userId" TEXT NOT NULL,
    "campusId" TEXT NOT NULL,
    "email" TEXT,
    "emailHash" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CampusVerification_pkey" PRIMARY KEY ("userId")
);

-- CreateIndex
CREATE UNIQUE INDEX "InviteCode_code_key" ON "InviteCode"("code");

-- CreateIndex
CREATE UNIQUE INDEX "InviteCode_ownerId_key" ON "InviteCode"("ownerId");

-- CreateIndex
CREATE INDEX "InviteCode_kind_createdAt_idx" ON "InviteCode"("kind", "createdAt");

-- CreateIndex
CREATE INDEX "InviteCode_campusId_idx" ON "InviteCode"("campusId");

-- CreateIndex
CREATE UNIQUE INDEX "InviteRedemption_inviteeId_key" ON "InviteRedemption"("inviteeId");

-- CreateIndex
CREATE INDEX "InviteRedemption_codeId_idx" ON "InviteRedemption"("codeId");

-- CreateIndex
CREATE INDEX "InviteRedemption_inviterId_status_idx" ON "InviteRedemption"("inviterId", "status");

-- CreateIndex
CREATE INDEX "InviteRedemption_status_redeemedAt_idx" ON "InviteRedemption"("status", "redeemedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Campus_slug_key" ON "Campus"("slug");

-- CreateIndex
CREATE INDEX "Campus_emailDomains_idx" ON "Campus" USING GIN ("emailDomains");

-- CreateIndex
CREATE INDEX "Campus_countryCode_idx" ON "Campus"("countryCode");

-- CreateIndex
CREATE UNIQUE INDEX "CampusMembership_emailHash_key" ON "CampusMembership"("emailHash");

-- CreateIndex
CREATE INDEX "CampusMembership_campusId_idx" ON "CampusMembership"("campusId");

-- CreateIndex
CREATE INDEX "CampusVerification_expiresAt_idx" ON "CampusVerification"("expiresAt");

-- AddForeignKey
ALTER TABLE "InviteCode" ADD CONSTRAINT "InviteCode_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InviteCode" ADD CONSTRAINT "InviteCode_campusId_fkey" FOREIGN KEY ("campusId") REFERENCES "Campus"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InviteRedemption" ADD CONSTRAINT "InviteRedemption_codeId_fkey" FOREIGN KEY ("codeId") REFERENCES "InviteCode"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InviteRedemption" ADD CONSTRAINT "InviteRedemption_inviteeId_fkey" FOREIGN KEY ("inviteeId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InviteRedemption" ADD CONSTRAINT "InviteRedemption_inviterId_fkey" FOREIGN KEY ("inviterId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampusMembership" ADD CONSTRAINT "CampusMembership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampusMembership" ADD CONSTRAINT "CampusMembership_campusId_fkey" FOREIGN KEY ("campusId") REFERENCES "Campus"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampusVerification" ADD CONSTRAINT "CampusVerification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A campus board and a campus feed are for people who verified a campus e-mail address (src/lib/campus). Until now a campus was free text and anybody could put themselves on
-- any campus's board by typing its name. The comparable key now means "a verified campus"; what people typed stays as the display text, and they join the board by verifying.
UPDATE "Profile" SET "campusKey" = NULL WHERE "campusKey" IS NOT NULL;

-- A campus slug is lower case letters, digits and hyphens: what a leaderboard scope id is parsed to.
ALTER TABLE "Campus" ADD CONSTRAINT "Campus_slug_format" CHECK ("slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$');
