-- Uploads (src/lib/media-assets.ts): a row per declared file, so the server can check the real object against the declaration, dedupe by content hash
-- (owner, purpose, sha256 is unique) and clean up what nobody finished.

-- CreateEnum
CREATE TYPE "MediaPurpose" AS ENUM ('POST_MEDIA', 'ROMANCE_PHOTO');

-- CreateEnum
CREATE TYPE "MediaKind" AS ENUM ('IMAGE', 'GIF', 'VIDEO');

-- CreateEnum
CREATE TYPE "MediaStatus" AS ENUM ('PENDING', 'READY', 'REJECTED');

-- CreateTable
CREATE TABLE "MediaAsset" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "purpose" "MediaPurpose" NOT NULL,
    "kind" "MediaKind" NOT NULL,
    "key" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "bytes" INTEGER NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "durationMs" INTEGER,
    "sha256" TEXT NOT NULL,
    "status" "MediaStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmedAt" TIMESTAMP(3),

    CONSTRAINT "MediaAsset_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MediaAsset_key_key" ON "MediaAsset"("key");

-- CreateIndex
CREATE INDEX "MediaAsset_ownerId_status_idx" ON "MediaAsset"("ownerId", "status");

-- CreateIndex
CREATE INDEX "MediaAsset_status_createdAt_idx" ON "MediaAsset"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "MediaAsset_ownerId_purpose_sha256_key" ON "MediaAsset"("ownerId", "purpose", "sha256");

-- AddForeignKey
ALTER TABLE "MediaAsset" ADD CONSTRAINT "MediaAsset_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

