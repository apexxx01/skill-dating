-- Spark notifications: a SPARK notification type (added on its own: a new enum value cannot be used in the transaction that adds it), the moment of the last
-- daily digest, an index for the digest, and the per-kind notification preferences.
-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'SPARK';

-- AlterTable
ALTER TABLE "MatchingProfile" ADD COLUMN     "sparkDigestAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "NotificationPreference" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotificationPreference_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "NotificationPreference_userId_kind_key" ON "NotificationPreference"("userId", "kind");

-- CreateIndex
CREATE INDEX "Spark_status_createdAt_idx" ON "Spark"("status", "createdAt");

-- AddForeignKey
ALTER TABLE "NotificationPreference" ADD CONSTRAINT "NotificationPreference_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

