-- AlterEnum
ALTER TYPE "MediaPurpose" ADD VALUE 'AVATAR';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "MediaStatus" ADD VALUE 'SCANNING';
ALTER TYPE "MediaStatus" ADD VALUE 'IN_REVIEW';
ALTER TYPE "MediaStatus" ADD VALUE 'BLOCKED';

-- AlterTable
ALTER TABLE "MediaAsset" ADD COLUMN     "scanLabels" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "scanVerdict" TEXT,
ADD COLUMN     "scannedAt" TIMESTAMP(3);

