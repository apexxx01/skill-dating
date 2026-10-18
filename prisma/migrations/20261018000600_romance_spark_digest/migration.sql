-- When the daily count of romance sparks was last sent (the romance counterpart of MatchingProfile.sparkDigestAt).
ALTER TABLE "RomanceProfile" ADD COLUMN "sparkDigestAt" TIMESTAMP(3);
