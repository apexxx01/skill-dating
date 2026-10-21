-- CreateEnum
CREATE TYPE "ReportTarget" AS ENUM ('USER', 'MESSAGE', 'SHIP_POST', 'COMMENT', 'SPARK', 'ROMANCE_PROFILE', 'LFG_POST', 'IDEA', 'EXTERNAL_HACKATHON', 'MEDIA');

-- CreateEnum
CREATE TYPE "ReportSource" AS ENUM ('USER', 'AUTOMATED');

-- CreateEnum
CREATE TYPE "AppealStatus" AS ENUM ('PENDING', 'UPHELD', 'OVERTURNED');

-- CreateEnum
CREATE TYPE "RestrictionKind" AS ENUM ('SUSPENDED', 'BANNED', 'ROMANCE', 'MESSAGING', 'POSTING');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ReportReason" ADD VALUE 'IMPERSONATION';
ALTER TYPE "ReportReason" ADD VALUE 'MINOR_SAFETY';

-- AlterTable
ALTER TABLE "Hackathon" ADD COLUMN     "moderatedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "moderatedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Report" ADD COLUMN     "priority" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "resolvedAt" TIMESTAMP(3),
ADD COLUMN     "resolvedById" TEXT,
ADD COLUMN     "snapshot" JSONB,
ADD COLUMN     "source" "ReportSource" NOT NULL DEFAULT 'USER',
ADD COLUMN     "targetId" TEXT,
ADD COLUMN     "targetType" "ReportTarget" NOT NULL DEFAULT 'USER',
ALTER COLUMN "reporterId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "ModerationAction" ADD COLUMN     "appealableUntil" TIMESTAMP(3),
ADD COLUMN     "expiresAt" TIMESTAMP(3),
ADD COLUMN     "feature" TEXT,
ADD COLUMN     "noteToUser" TEXT,
ADD COLUMN     "reportId" TEXT,
ADD COLUMN     "reverseReason" TEXT,
ADD COLUMN     "reversedAt" TIMESTAMP(3),
ADD COLUMN     "reversedById" TEXT,
ADD COLUMN     "subjectUserId" TEXT;

-- AlterTable
ALTER TABLE "Spark" ADD COLUMN     "moderatedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "RomanceProfile" ADD COLUMN     "moderatedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "ShipPost" ADD COLUMN     "moderatedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Comment" ADD COLUMN     "moderatedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "LfgPost" ADD COLUMN     "moderatedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "TeamIdea" ADD COLUMN     "moderatedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "Appeal" (
    "id" TEXT NOT NULL,
    "actionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "status" "AppealStatus" NOT NULL DEFAULT 'PENDING',
    "decidedById" TEXT,
    "decisionNote" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Appeal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserRestriction" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" "RestrictionKind" NOT NULL,
    "actionId" TEXT,
    "endsAt" TIMESTAMP(3),
    "liftedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserRestriction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Mute" (
    "id" TEXT NOT NULL,
    "muterId" TEXT NOT NULL,
    "mutedId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Mute_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Appeal_actionId_key" ON "Appeal"("actionId");

-- CreateIndex
CREATE INDEX "Appeal_status_createdAt_idx" ON "Appeal"("status", "createdAt");

-- CreateIndex
CREATE INDEX "UserRestriction_userId_liftedAt_idx" ON "UserRestriction"("userId", "liftedAt");

-- CreateIndex
CREATE INDEX "Mute_mutedId_idx" ON "Mute"("mutedId");

-- CreateIndex
CREATE UNIQUE INDEX "Mute_muterId_mutedId_key" ON "Mute"("muterId", "mutedId");

-- CreateIndex
CREATE INDEX "Report_status_priority_createdAt_idx" ON "Report"("status", "priority", "createdAt");

-- CreateIndex
CREATE INDEX "Report_reportedId_createdAt_idx" ON "Report"("reportedId", "createdAt");

-- CreateIndex
CREATE INDEX "Report_targetType_targetId_idx" ON "Report"("targetType", "targetId");

-- CreateIndex
CREATE INDEX "Report_resolvedAt_idx" ON "Report"("resolvedAt");

-- CreateIndex
CREATE INDEX "ModerationAction_subjectUserId_createdAt_idx" ON "ModerationAction"("subjectUserId", "createdAt");

-- CreateIndex
CREATE INDEX "ModerationAction_reportId_idx" ON "ModerationAction"("reportId");

-- AddForeignKey
ALTER TABLE "Appeal" ADD CONSTRAINT "Appeal_actionId_fkey" FOREIGN KEY ("actionId") REFERENCES "ModerationAction"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Appeal" ADD CONSTRAINT "Appeal_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserRestriction" ADD CONSTRAINT "UserRestriction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Mute" ADD CONSTRAINT "Mute_muterId_fkey" FOREIGN KEY ("muterId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Mute" ADD CONSTRAINT "Mute_mutedId_fkey" FOREIGN KEY ("mutedId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

