-- When a season's cosmetic rewards were granted. Null until the rollover job has done it.
ALTER TABLE "Season" ADD COLUMN "rewardsGrantedAt" TIMESTAMP(3);
