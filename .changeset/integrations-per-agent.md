---
'@truefoundry/trueforge': minor
---

Integrations belong to an agent.

Each integration is now bound to one agent: `Integration` carries `agent_name`, and the manifest no
longer has `default_agent_name`. The CRUD routes moved from `/api/v1/settings/integrations` to
`/api/v1/integrations` (`GET` with `?agent_names=`, `POST` taking `{ agent_name, manifest }`, and
`GET`/`PUT`/`DELETE`/`app-manifest`/`decisions` by id); the SDK group is now `integrations`. They
are no longer admin-only: callers see the integrations they created or whose agent they manage,
creating one needs manage access to the named agent, and admins still see and open every
integration. The channel ingress URLs are unchanged, so installed Slack apps keep working.

One workspace can now hold one integration per agent, deleting an agent deletes its integrations,
and a schedule notification rule only matches schedules of its own agent.

Upgrading stops if an integration names an agent that no longer exists. Before upgrading, list
those integrations with:

```sql
SELECT i.id, i.tenant_id, json_extract(i.manifest, '$.default_agent_name') AS agent_name
FROM integration AS i
LEFT JOIN agent AS a
  ON a.tenant_id = i.tenant_id AND a.name = json_extract(i.manifest, '$.default_agent_name')
WHERE a.id IS NULL;
```

On Postgres use `i.manifest->>'default_agent_name'` in place of `json_extract(...)`. Then recreate
each missing agent under that name, or delete the integration in Settings → Integrations.
