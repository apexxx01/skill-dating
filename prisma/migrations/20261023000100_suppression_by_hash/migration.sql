-- The suppression list keeps a hash of the address, not the address: it outlives the account, so it should hold nothing that can be read back.
ALTER TABLE "EmailSuppression" ADD COLUMN "emailHash" TEXT;

UPDATE "EmailSuppression" SET "emailHash" = encode(sha256(convert_to(lower(btrim("email")), 'UTF8')), 'hex');

ALTER TABLE "EmailSuppression" ALTER COLUMN "emailHash" SET NOT NULL;

DROP INDEX "EmailSuppression_email_key";
ALTER TABLE "EmailSuppression" DROP COLUMN "email";

CREATE UNIQUE INDEX "EmailSuppression_emailHash_key" ON "EmailSuppression"("emailHash");

-- Whatever is written here can only be a SHA-256, so a plain address cannot be stored by mistake.
ALTER TABLE "EmailSuppression" ADD CONSTRAINT "EmailSuppression_emailHash_format" CHECK ("emailHash" ~ '^[0-9a-f]{64}$');
