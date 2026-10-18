-- Squads, part 5: external hackathons (Devfolio, Devpost, MLH, Unstop, Luma): where a hackathon lives, its normalised link (unique), platform,
-- mode and place, who submitted it and when it was verified.

-- CreateEnum
CREATE TYPE "HackathonSource" AS ENUM ('NATIVE', 'EXTERNAL');

-- CreateEnum
CREATE TYPE "HackathonPlatform" AS ENUM ('DEVFOLIO', 'DEVPOST', 'MLH', 'UNSTOP', 'LUMA', 'OTHER');

-- CreateEnum
CREATE TYPE "HackathonMode" AS ENUM ('ONLINE', 'IN_PERSON', 'HYBRID');

-- AlterTable
ALTER TABLE "Hackathon" ADD COLUMN     "city" TEXT,
ADD COLUMN     "country" TEXT,
ADD COLUMN     "externalUrl" TEXT,
ADD COLUMN     "mode" "HackathonMode",
ADD COLUMN     "platform" "HackathonPlatform",
ADD COLUMN     "source" "HackathonSource" NOT NULL DEFAULT 'NATIVE',
ADD COLUMN     "submittedById" TEXT,
ADD COLUMN     "verifiedAt" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX "Hackathon_externalUrl_key" ON "Hackathon"("externalUrl");

-- AddForeignKey
ALTER TABLE "Hackathon" ADD CONSTRAINT "Hackathon_submittedById_fkey" FOREIGN KEY ("submittedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

