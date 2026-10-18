-- CreateEnum
CREATE TYPE "DropStatus" AS ENUM ('NEW', 'SPARKED', 'PASSED', 'EXPIRED');

-- CreateTable
CREATE TABLE "Drop" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "connectionType" "MatchType" NOT NULL,
    "score" INTEGER NOT NULL,
    "reasons" JSONB NOT NULL DEFAULT '[]',
    "localDate" TEXT NOT NULL,
    "status" "DropStatus" NOT NULL DEFAULT 'NEW',
    "secondLook" BOOLEAN NOT NULL DEFAULT false,
    "passSnapshot" JSONB,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "viewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Drop_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Drop_userId_localDate_idx" ON "Drop"("userId", "localDate");

-- CreateIndex
CREATE INDEX "Drop_userId_candidateId_createdAt_idx" ON "Drop"("userId", "candidateId", "createdAt");

-- CreateIndex
CREATE INDEX "Drop_candidateId_createdAt_idx" ON "Drop"("candidateId", "createdAt");

-- CreateIndex
CREATE INDEX "Drop_status_expiresAt_idx" ON "Drop"("status", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "Drop_userId_candidateId_localDate_key" ON "Drop"("userId", "candidateId", "localDate");

-- AddForeignKey
ALTER TABLE "Drop" ADD CONSTRAINT "Drop_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Drop" ADD CONSTRAINT "Drop_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
