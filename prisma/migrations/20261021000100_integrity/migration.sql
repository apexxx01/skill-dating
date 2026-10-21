-- CreateEnum
CREATE TYPE "FraudSignalStatus" AS ENUM ('OPEN', 'CONFIRMED', 'DISMISSED');

-- CreateEnum
CREATE TYPE "RiskLevel" AS ENUM ('LOW', 'ELEVATED', 'HIGH');

-- AlterTable
ALTER TABLE "SkillEvidence" ADD COLUMN     "integrityWeight" DOUBLE PRECISION NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "Prop" ADD COLUMN     "integrityWeight" DOUBLE PRECISION NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "PeerReview" ADD COLUMN     "integrityWeight" DOUBLE PRECISION NOT NULL DEFAULT 1;

-- CreateTable
CREATE TABLE "FraudSignal" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "memberIds" TEXT[],
    "evidence" JSONB NOT NULL,
    "affected" JSONB NOT NULL DEFAULT '{}',
    "fingerprint" TEXT NOT NULL,
    "status" "FraudSignalStatus" NOT NULL DEFAULT 'OPEN',
    "windowStart" TIMESTAMP(3) NOT NULL,
    "windowEnd" TIMESTAMP(3) NOT NULL,
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FraudSignal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserRisk" (
    "userId" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "level" "RiskLevel" NOT NULL,
    "factors" JSONB NOT NULL DEFAULT '{}',
    "overrideLevel" "RiskLevel",
    "overrideById" TEXT,
    "overrideReason" TEXT,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserRisk_pkey" PRIMARY KEY ("userId")
);

-- CreateIndex
CREATE INDEX "FraudSignal_status_createdAt_idx" ON "FraudSignal"("status", "createdAt");

-- CreateIndex
CREATE INDEX "FraudSignal_memberIds_idx" ON "FraudSignal" USING GIN ("memberIds");

-- CreateIndex
CREATE UNIQUE INDEX "FraudSignal_type_fingerprint_key" ON "FraudSignal"("type", "fingerprint");

-- CreateIndex
CREATE INDEX "UserRisk_level_idx" ON "UserRisk"("level");

-- CreateIndex
CREATE INDEX "UserRisk_overrideLevel_idx" ON "UserRisk"("overrideLevel");

-- AddForeignKey
ALTER TABLE "UserRisk" ADD CONSTRAINT "UserRisk_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

