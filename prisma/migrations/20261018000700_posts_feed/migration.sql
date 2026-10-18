-- Ship posts, props, comments, follows, watches, integrity signals, the Ship Day recap, and the columns that let a notification stand for several events.
-- The new notification types are added on their own: a new enum value cannot be used in the transaction that adds it.

-- CreateEnum
CREATE TYPE "PostKind" AS ENUM ('SHIP', 'UPDATE', 'DEVLOG', 'DEMO');

-- CreateEnum
CREATE TYPE "PostVisibility" AS ENUM ('PUBLIC', 'FOLLOWERS', 'CREW');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NotificationType" ADD VALUE 'PROPS';
ALTER TYPE "NotificationType" ADD VALUE 'COMMENT';
ALTER TYPE "NotificationType" ADD VALUE 'FOLLOW';
ALTER TYPE "NotificationType" ADD VALUE 'WATCH';

-- AlterTable
ALTER TABLE "Notification" ADD COLUMN     "coalesceKey" TEXT,
ADD COLUMN     "count" INTEGER NOT NULL DEFAULT 1;

-- CreateTable
CREATE TABLE "ShipPost" (
    "id" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "projectId" TEXT,
    "teamId" TEXT,
    "kind" "PostKind" NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "links" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "media" JSONB NOT NULL DEFAULT '[]',
    "stackTags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "coAuthorIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "visibility" "PostVisibility" NOT NULL DEFAULT 'PUBLIC',
    "shipDayKey" TEXT,
    "propsScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "propsCount" INTEGER NOT NULL DEFAULT 0,
    "commentCount" INTEGER NOT NULL DEFAULT 0,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "projectUpdateId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "editedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "ShipPost_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Prop" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "weight" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Prop_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Comment" (
    "id" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "parentId" TEXT,
    "body" TEXT NOT NULL,
    "editedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Comment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Follow" (
    "id" TEXT NOT NULL,
    "followerId" TEXT NOT NULL,
    "followeeId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Follow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Watch" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Watch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IntegritySignal" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "userId" TEXT,
    "subjectType" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "data" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IntegritySignal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShipDayRecap" (
    "id" TEXT NOT NULL,
    "weekKey" TEXT NOT NULL,
    "dateKey" TEXT NOT NULL,
    "totalPosts" INTEGER NOT NULL,
    "topPosts" JSONB NOT NULL DEFAULT '[]',
    "places" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShipDayRecap_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ShipPost_authorId_createdAt_idx" ON "ShipPost"("authorId", "createdAt");

-- CreateIndex
CREATE INDEX "ShipPost_projectId_createdAt_idx" ON "ShipPost"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "ShipPost_teamId_createdAt_idx" ON "ShipPost"("teamId", "createdAt");

-- CreateIndex
CREATE INDEX "ShipPost_createdAt_idx" ON "ShipPost"("createdAt");

-- CreateIndex
CREATE INDEX "ShipPost_shipDayKey_idx" ON "ShipPost"("shipDayKey");

-- CreateIndex
CREATE INDEX "ShipPost_coAuthorIds_idx" ON "ShipPost" USING GIN ("coAuthorIds");

-- CreateIndex
CREATE INDEX "Prop_postId_createdAt_idx" ON "Prop"("postId", "createdAt");

-- CreateIndex
CREATE INDEX "Prop_userId_createdAt_idx" ON "Prop"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Prop_userId_postId_key" ON "Prop"("userId", "postId");

-- CreateIndex
CREATE INDEX "Comment_postId_createdAt_idx" ON "Comment"("postId", "createdAt");

-- CreateIndex
CREATE INDEX "Comment_parentId_createdAt_idx" ON "Comment"("parentId", "createdAt");

-- CreateIndex
CREATE INDEX "Follow_followeeId_createdAt_idx" ON "Follow"("followeeId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Follow_followerId_followeeId_key" ON "Follow"("followerId", "followeeId");

-- CreateIndex
CREATE INDEX "Watch_projectId_idx" ON "Watch"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "Watch_userId_projectId_key" ON "Watch"("userId", "projectId");

-- CreateIndex
CREATE INDEX "IntegritySignal_kind_createdAt_idx" ON "IntegritySignal"("kind", "createdAt");

-- CreateIndex
CREATE INDEX "IntegritySignal_subjectType_subjectId_idx" ON "IntegritySignal"("subjectType", "subjectId");

-- CreateIndex
CREATE UNIQUE INDEX "ShipDayRecap_weekKey_key" ON "ShipDayRecap"("weekKey");

-- CreateIndex
CREATE UNIQUE INDEX "Notification_userId_coalesceKey_key" ON "Notification"("userId", "coalesceKey");

-- AddForeignKey
ALTER TABLE "ShipPost" ADD CONSTRAINT "ShipPost_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShipPost" ADD CONSTRAINT "ShipPost_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Prop" ADD CONSTRAINT "Prop_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Prop" ADD CONSTRAINT "Prop_postId_fkey" FOREIGN KEY ("postId") REFERENCES "ShipPost"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_postId_fkey" FOREIGN KEY ("postId") REFERENCES "ShipPost"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Comment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Follow" ADD CONSTRAINT "Follow_followerId_fkey" FOREIGN KEY ("followerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Follow" ADD CONSTRAINT "Follow_followeeId_fkey" FOREIGN KEY ("followeeId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Watch" ADD CONSTRAINT "Watch_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Watch" ADD CONSTRAINT "Watch_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

