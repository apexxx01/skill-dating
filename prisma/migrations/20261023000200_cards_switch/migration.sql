-- "Show my cards on the web": the share images (/api/og/...) are drawn for an adult unless they turn this off.
ALTER TABLE "Profile" ADD COLUMN "showCardsOnWeb" BOOLEAN NOT NULL DEFAULT true;
