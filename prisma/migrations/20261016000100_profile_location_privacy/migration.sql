-- AlterTable
ALTER TABLE "Profile" ADD COLUMN     "campus" TEXT,
ADD COLUMN     "campusKey" TEXT,
ADD COLUMN     "city" TEXT,
ADD COLUMN     "cityKey" TEXT,
ADD COLUMN     "countryCode" TEXT,
ADD COLUMN     "hideFromLeaderboards" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "showActivity" BOOLEAN NOT NULL DEFAULT true;

-- CreateIndex
CREATE INDEX "Profile_countryCode_idx" ON "Profile"("countryCode");

-- CreateIndex
CREATE INDEX "Profile_countryCode_cityKey_idx" ON "Profile"("countryCode", "cityKey");

-- CreateIndex
CREATE INDEX "Profile_campusKey_idx" ON "Profile"("campusKey");

