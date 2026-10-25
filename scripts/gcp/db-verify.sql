-- One row per failed check; no rows means the roles are as docker/postgres/init.sh leaves them.
-- Run by db-bootstrap.sh and by tests/run.sh (against a throwaway local postgres:16).
select name from (values
  ('llm_owner: NOLOGIN BYPASSRLS, not superuser/createdb/createrole',
    (select not rolcanlogin and rolbypassrls and not rolsuper and not rolcreatedb and not rolcreaterole from pg_roles where rolname='llm_owner')),
  ('llm_migrator: LOGIN NOINHERIT NOBYPASSRLS, not superuser/createdb/createrole',
    (select rolcanlogin and not rolinherit and not rolbypassrls and not rolsuper and not rolcreatedb and not rolcreaterole from pg_roles where rolname='llm_migrator')),
  ('llm_auth: LOGIN NOINHERIT NOBYPASSRLS, not superuser/createdb/createrole',
    (select rolcanlogin and not rolinherit and not rolbypassrls and not rolsuper and not rolcreatedb and not rolcreaterole from pg_roles where rolname='llm_auth')),
  ('llm_runtime: LOGIN NOINHERIT NOBYPASSRLS, not superuser/createdb/createrole',
    (select rolcanlogin and not rolinherit and not rolbypassrls and not rolsuper and not rolcreatedb and not rolcreaterole from pg_roles where rolname='llm_runtime')),
  ('llm_migrator is a member of llm_owner',
    exists (select 1 from pg_auth_members m join pg_roles g on g.oid=m.roleid join pg_roles r on r.oid=m.member where g.rolname='llm_owner' and r.rolname='llm_migrator')),
  ('CONNECT on llm_proxy for migrator, auth, runtime',
    has_database_privilege('llm_migrator','llm_proxy','CONNECT') and has_database_privilege('llm_auth','llm_proxy','CONNECT') and has_database_privilege('llm_runtime','llm_proxy','CONNECT')),
  ('schema public: USAGE and CREATE for llm_migrator and llm_owner',
    -- a comma list in has_schema_privilege is true when EITHER privilege is held, so ask for each alone.
    has_schema_privilege('llm_migrator','public','USAGE') and has_schema_privilege('llm_migrator','public','CREATE')
    and has_schema_privilege('llm_owner','public','USAGE') and has_schema_privilege('llm_owner','public','CREATE')),
  ('schema public: USAGE but not CREATE for llm_auth and llm_runtime',
    has_schema_privilege('llm_auth','public','USAGE') and has_schema_privilege('llm_runtime','public','USAGE')
    and not has_schema_privilege('llm_auth','public','CREATE') and not has_schema_privilege('llm_runtime','public','CREATE'))
) as c(name, passed) where passed is not true;
