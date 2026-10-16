-- AlterTable
ALTER TABLE "User" ADD COLUMN     "currentStreak" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "lastStreakDay" TEXT,
ADD COLUMN     "longestStreak" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "streakFreezeUsed" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "streakFreezes" INTEGER NOT NULL DEFAULT 0;

