-- Rollback for 20260728000000_add_sub_accounts

ALTER TABLE "sub_accounts" DROP CONSTRAINT IF EXISTS "sub_accounts_childUserId_fkey";
ALTER TABLE "sub_accounts" DROP CONSTRAINT IF EXISTS "sub_accounts_parentUserId_fkey";

DROP INDEX IF EXISTS "agent_logs_actingAsUserId_idx";
DROP INDEX IF EXISTS "transactions_actingAsUserId_idx";
DROP INDEX IF EXISTS "sub_accounts_status_idx";
DROP INDEX IF EXISTS "sub_accounts_childUserId_idx";
DROP INDEX IF EXISTS "sub_accounts_parentUserId_idx";
DROP INDEX IF EXISTS "sub_accounts_parentUserId_childUserId_key";

DROP TABLE IF EXISTS "sub_accounts";

ALTER TABLE "agent_logs" DROP COLUMN IF EXISTS "actingAsUserId";
ALTER TABLE "transactions" DROP COLUMN IF EXISTS "actingAsUserId";

DROP TYPE IF EXISTS "SubAccountStatus";
DROP TYPE IF EXISTS "SubAccountPermission";
