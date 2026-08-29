-- "Freight Forwarder" was one of three provider_roles values from the very first schema, but it
-- doesn't exist as a real category in this trader's actual business (confirmed live, 2026-08-30):
-- providers are either ground carriers (US and/or Mexican freight) or customs agencies that cross/
-- import containers — sometimes the same company is both, never anything else. Table was empty
-- (0 providers, 0 provider_roles) at the time of this change, so nothing to migrate.

alter table provider_roles drop constraint provider_roles_role_check;
alter table provider_roles add constraint provider_roles_role_check check (role in ('carrier', 'customs_broker'));
