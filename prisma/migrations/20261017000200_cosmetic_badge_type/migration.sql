-- A BADGE is worn in the "badges" slot, up to three at a time. It is added on its own: a new enum value cannot
-- be used in the transaction that adds it, so the rows that move to it are updated in the next migration.
ALTER TYPE "CosmeticType" ADD VALUE IF NOT EXISTS 'BADGE';
