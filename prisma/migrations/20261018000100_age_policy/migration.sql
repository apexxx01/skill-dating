-- The platform age policy (docs/SAFETY.md): a person who gives a date of birth under the minimum is refused, and the only thing kept is WHEN
-- (not the date), so the refusal is not undone by trying another date. A person can ask for a correction through the report flow, with a reason of its own.
-- The new enum value is only used by later requests, never in this transaction.
ALTER TYPE "ReportReason" ADD VALUE 'BIRTHDATE_CORRECTION';

ALTER TABLE "User" ADD COLUMN "birthDateRefusedAt" TIMESTAMP(3);
