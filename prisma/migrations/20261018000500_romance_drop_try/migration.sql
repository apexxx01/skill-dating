-- The weekly romance drop looks for a person once a day until it finds one (or the week ends), not every hour: the local date of the last empty look.
ALTER TABLE "RomanceProfile" ADD COLUMN "lastDropTryDate" TEXT;
