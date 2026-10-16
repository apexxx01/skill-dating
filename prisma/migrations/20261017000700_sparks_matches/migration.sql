-- CreateEnum
CREATE TYPE "SparkStatus" AS ENUM ('PENDING', 'MATCHED');

-- CreateEnum
CREATE TYPE "MatchEndReason" AS ENUM ('UNMATCHED', 'REPORTED', 'BLOCKED');

-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'MATCH';

-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "closedAt" TIMESTAMP(3),
ADD COLUMN     "closedReason" TEXT;

-- CreateTable
CREATE TABLE "Spark" (
    "id" TEXT NOT NULL,
    "fromId" TEXT NOT NULL,
    "toId" TEXT NOT NULL,
    "dropId" TEXT,
    "connectionType" "MatchType" NOT NULL,
    "opener" TEXT NOT NULL,
    "openerHash" TEXT NOT NULL,
    "status" "SparkStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Spark_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Match" (
    "id" TEXT NOT NULL,
    "userAId" TEXT NOT NULL,
    "userBId" TEXT NOT NULL,
    "userARole" "MatchType" NOT NULL,
    "userBRole" "MatchType" NOT NULL,
    "connectionType" "MatchType" NOT NULL,
    "conversationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "endedById" TEXT,
    "endReason" "MatchEndReason",

    CONSTRAINT "Match_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Spark_toId_status_createdAt_idx" ON "Spark"("toId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "Spark_fromId_createdAt_idx" ON "Spark"("fromId", "createdAt");

-- CreateIndex
CREATE INDEX "Spark_openerHash_createdAt_idx" ON "Spark"("openerHash", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Spark_fromId_toId_connectionType_key" ON "Spark"("fromId", "toId", "connectionType");

-- CreateIndex
CREATE UNIQUE INDEX "Match_conversationId_key" ON "Match"("conversationId");

-- CreateIndex
CREATE INDEX "Match_userBId_endedAt_idx" ON "Match"("userBId", "endedAt");

-- CreateIndex
CREATE INDEX "Match_userAId_endedAt_idx" ON "Match"("userAId", "endedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Match_userAId_userBId_connectionType_key" ON "Match"("userAId", "userBId", "connectionType");

-- AddForeignKey
ALTER TABLE "Spark" ADD CONSTRAINT "Spark_fromId_fkey" FOREIGN KEY ("fromId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Spark" ADD CONSTRAINT "Spark_toId_fkey" FOREIGN KEY ("toId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Spark" ADD CONSTRAINT "Spark_dropId_fkey" FOREIGN KEY ("dropId") REFERENCES "Drop"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Match" ADD CONSTRAINT "Match_userAId_fkey" FOREIGN KEY ("userAId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Match" ADD CONSTRAINT "Match_userBId_fkey" FOREIGN KEY ("userBId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Match" ADD CONSTRAINT "Match_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- A pair is one row whichever of the two sparked first: the smaller id is always A. Written by the application, kept true by the database.
ALTER TABLE "Match" ADD CONSTRAINT "Match_pair_order_check" CHECK ("userAId" < "userBId");

-- An opener is a real sentence: 20 to 280 characters. The application checks much more; this is the floor and ceiling nothing can go around.
ALTER TABLE "Spark" ADD CONSTRAINT "Spark_opener_length_check" CHECK (char_length("opener") BETWEEN 20 AND 280);
