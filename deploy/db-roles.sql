-- ===========================================================================
-- ECHO ECHO - separate migration and runtime database roles
--
-- NOT APPLIED ANYWHERE. Test in a disposable database, and take a backup and an
-- explicit owner decision before production. server/test/db-roles.test.mjs runs
-- this on a throwaway database and proves the result.
--
--   echo_runtime   what the API connects as. It can read and write data, but it
--                  owns nothing, so it cannot disable a trigger, alter a table
--                  or drop anything.
--   <migrator>     the existing owner role. Migrations and restores use it, from
--                  a separate connection string the running API never holds.
--
-- Run as the role that owns the tables. Set the password with ALTER ROLE from a
-- password manager afterwards; never commit it.
--
-- ROLLBACK: point DATABASE_URL back at the owner role and redeploy. Nothing here
-- changes data or table ownership, so that returns everything to how it was.
-- ===========================================================================
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'echo_runtime') THEN
    CREATE ROLE echo_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO echo_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO echo_runtime;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO echo_runtime;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO echo_runtime;

-- New tables from later migrations are covered too.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO echo_runtime;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO echo_runtime;

-- The records the application must only ever add to.
REVOKE UPDATE, DELETE, TRUNCATE ON audit_log, catalog_version FROM echo_runtime;

-- The runtime role must never run migrations.
REVOKE CREATE ON SCHEMA public FROM echo_runtime;
REVOKE ALL ON schema_migration FROM echo_runtime;
GRANT SELECT ON schema_migration TO echo_runtime;
