-- The evidence engine and signed receipts (src/lib/evidence, docs/PROOF.md): receipts, per-repository GitHub evidence, the sync state, verified
-- collaborations; the immutable GitHub id on User; support and the repository link on SkillEvidence; lastEvidencedAt on UserSkill; the GITHUB_SYNC
-- consent; disputes of a claim as a report target and reason.

-- CreateEnum
CREATE TYPE "EvidenceSupport" AS ENUM ('SUPPORTED', 'UNSUPPORTED');

-- CreateEnum
CREATE TYPE "ReceiptSource" AS ENUM ('GITHUB');

-- CreateEnum
CREATE TYPE "ReceiptStatus" AS ENUM ('VALID', 'SOURCE_CHANGED', 'SOURCE_GONE', 'REVOKED');

-- AlterEnum
ALTER TYPE "ReportReason" ADD VALUE 'CLAIM_DISPUTE';

-- AlterEnum
ALTER TYPE "ReportTarget" ADD VALUE 'EVIDENCE_CLAIM';

-- AlterEnum
ALTER TYPE "ConsentType" ADD VALUE 'GITHUB_SYNC';

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "githubId" TEXT;

-- AlterTable
ALTER TABLE "UserSkill" ADD COLUMN     "lastEvidencedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "SkillEvidence" ADD COLUMN     "repoEvidenceId" TEXT,
ADD COLUMN     "support" "EvidenceSupport",
ADD COLUMN     "supportReason" TEXT;

-- CreateTable
CREATE TABLE "EvidenceReceipt" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "repoEvidenceId" TEXT,
    "source" "ReceiptSource" NOT NULL,
    "sourceRef" TEXT NOT NULL,
    "sourceUrl" TEXT NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL,
    "factsVersion" INTEGER NOT NULL,
    "facts" JSONB NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "kid" TEXT,
    "signature" TEXT,
    "signedAt" TIMESTAMP(3),
    "status" "ReceiptStatus" NOT NULL DEFAULT 'VALID',
    "lastCheckedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EvidenceReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GithubRepoEvidence" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "repoGithubId" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "claimed" BOOLEAN NOT NULL DEFAULT false,
    "facts" JSONB NOT NULL,
    "strength" INTEGER NOT NULL DEFAULT 0,
    "breakdown" JSONB NOT NULL DEFAULT '{}',
    "support" "EvidenceSupport" NOT NULL DEFAULT 'SUPPORTED',
    "supportReason" TEXT,
    "sourceWeight" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "authoredShare" DOUBLE PRECISION,
    "firstAuthoredAt" TIMESTAMP(3),
    "lastAuthoredAt" TIMESTAMP(3),
    "moderatedAt" TIMESTAMP(3),
    "syncedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GithubRepoEvidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GithubSyncState" (
    "userId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'IDLE',
    "requestedAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "lastSyncedAt" TIMESTAMP(3),
    "authMode" TEXT,
    "dayKey" TEXT,
    "callsToday" INTEGER NOT NULL DEFAULT 0,
    "lastCalls" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GithubSyncState_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "VerifiedCollaboration" (
    "id" TEXT NOT NULL,
    "repoGithubId" TEXT NOT NULL,
    "userAId" TEXT NOT NULL,
    "userBId" TEXT NOT NULL,
    "shareA" DOUBLE PRECISION NOT NULL,
    "shareB" DOUBLE PRECISION NOT NULL,
    "overlapStart" TIMESTAMP(3),
    "overlapEnd" TIMESTAMP(3),
    "receiptIds" TEXT[],
    "computedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VerifiedCollaboration_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EvidenceReceipt_userId_createdAt_idx" ON "EvidenceReceipt"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "EvidenceReceipt_status_lastCheckedAt_idx" ON "EvidenceReceipt"("status", "lastCheckedAt");

-- CreateIndex
CREATE INDEX "EvidenceReceipt_signedAt_idx" ON "EvidenceReceipt"("signedAt");

-- CreateIndex
CREATE UNIQUE INDEX "EvidenceReceipt_userId_source_sourceRef_key" ON "EvidenceReceipt"("userId", "source", "sourceRef");

-- CreateIndex
CREATE INDEX "GithubRepoEvidence_repoGithubId_idx" ON "GithubRepoEvidence"("repoGithubId");

-- CreateIndex
CREATE UNIQUE INDEX "GithubRepoEvidence_userId_repoGithubId_key" ON "GithubRepoEvidence"("userId", "repoGithubId");

-- CreateIndex
CREATE INDEX "VerifiedCollaboration_userAId_idx" ON "VerifiedCollaboration"("userAId");

-- CreateIndex
CREATE INDEX "VerifiedCollaboration_userBId_idx" ON "VerifiedCollaboration"("userBId");

-- CreateIndex
CREATE UNIQUE INDEX "VerifiedCollaboration_repoGithubId_userAId_userBId_key" ON "VerifiedCollaboration"("repoGithubId", "userAId", "userBId");

-- CreateIndex
CREATE UNIQUE INDEX "User_githubId_key" ON "User"("githubId");

-- CreateIndex
CREATE INDEX "SkillEvidence_repoEvidenceId_idx" ON "SkillEvidence"("repoEvidenceId");

-- AddForeignKey
ALTER TABLE "SkillEvidence" ADD CONSTRAINT "SkillEvidence_repoEvidenceId_fkey" FOREIGN KEY ("repoEvidenceId") REFERENCES "GithubRepoEvidence"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvidenceReceipt" ADD CONSTRAINT "EvidenceReceipt_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvidenceReceipt" ADD CONSTRAINT "EvidenceReceipt_repoEvidenceId_fkey" FOREIGN KEY ("repoEvidenceId") REFERENCES "GithubRepoEvidence"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GithubRepoEvidence" ADD CONSTRAINT "GithubRepoEvidence_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GithubSyncState" ADD CONSTRAINT "GithubSyncState_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VerifiedCollaboration" ADD CONSTRAINT "VerifiedCollaboration_userAId_fkey" FOREIGN KEY ("userAId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VerifiedCollaboration" ADD CONSTRAINT "VerifiedCollaboration_userBId_fkey" FOREIGN KEY ("userBId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

