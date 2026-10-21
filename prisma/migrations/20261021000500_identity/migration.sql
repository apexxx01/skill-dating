-- AlterTable
ALTER TABLE "User" ADD COLUMN     "usernameSkeleton" TEXT;

-- CreateIndex
CREATE INDEX "User_usernameSkeleton_idx" ON "User"("usernameSkeleton");


-- Backfill: the skeleton of every existing username. Usernames are ASCII ([a-z0-9_-], src/lib/username.ts), and on ASCII this is exactly what
-- skeleton() in src/lib/identity/confusables.ts does: lower case; 0 1 3 4 5 7 8 9 | $ @ i become o l e a s t b g l s a l; separators dropped;
-- then rn to m, vv to w, cl to d, in that order. A unit test (confusables.test.ts) pins the TypeScript side to the same examples.
UPDATE "User" SET "usernameSkeleton" =
  replace(replace(replace(
    regexp_replace(translate(lower("username"), '01345789|$@i', 'oleastbglsal'), '[_.[:space:]-]', '', 'g'),
  'rn', 'm'), 'vv', 'w'), 'cl', 'd');
