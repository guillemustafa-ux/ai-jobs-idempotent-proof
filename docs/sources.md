# Sources

Every statement in the README about a third party comes from one of these pages, fetched on
2026-11-01. Where a statement is about what a page does *not* say, the method is stated.

## Model providers: idempotency keys

**Anthropic Messages API reference**: <https://platform.claude.com/docs/en/api/messages>
(`docs.claude.com/en/api/messages` redirects there).

- Method: the full page (8.2 MB of HTML) was downloaded and searched case-insensitively for
  `idempoten`. There is no occurrence of "idempotency" or "Idempotency-Key". The word
  "idempotent" appears only about polling batches:
  > "This endpoint is idempotent and can be used to poll for Message Batch completion."
- The request headers listed in the page's Headers section are `anthropic-version`,
  `anthropic-user-profile-id` and `anthropic-workspace-id`.

**OpenAI chat completions, create**:
<https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create>

- Method: the full page (2.2 MB of HTML) was downloaded and searched case-insensitively for
  `idempoten`: zero occurrences.
- `https://platform.openai.com/docs/api-reference/chat/create` answered HTTP 403 to the fetch
  tool and was not read.

What this supports: neither reference page documents an idempotency key for creating a
completion. It is an absence of documentation, not proof that no such mechanism exists.

## Postgres

**Row security**: <https://www.postgresql.org/docs/16/ddl-rowsecurity.html>

> "If no policy exists for the table, a default-deny policy is used, meaning that no rows are
> visible or can be modified."

> "Superusers and roles with the `BYPASSRLS` attribute always bypass the row security system when
> accessing a table. Table owners normally bypass row security as well, though a table owner can
> choose to be subject to row security with ALTER TABLE ... FORCE ROW LEVEL SECURITY."

**SELECT, locking clause**: <https://www.postgresql.org/docs/16/sql-select.html>

> "With `SKIP LOCKED`, any selected rows that cannot be immediately locked are skipped. Skipping
> locked rows provides an inconsistent view of the data, so this is not suitable for general
> purpose work, but can be used to avoid lock contention with multiple consumers accessing a
> queue-like table."

## Supabase

**Row Level Security**: <https://supabase.com/docs/guides/database/postgres/row-level-security>

> "A secret key authorizes access through the `service_role` Postgres role, which has the
> `bypassrls` attribute."

> "A secret key bypasses RLS only when the request carries no user access token."

> "Never use a secret key in the browser or expose it to customers."

> "Once RLS is enabled, no data is accessible through the API when using a publishable key, until
> you create policies."

**pg_cron on Supabase**: <https://supabase.com/docs/guides/database/extensions/pg_cron>

> "pg_cron: schedule recurring Jobs with cron syntax in Postgres."

## pg_cron

**pg_cron README**: <https://github.com/citusdata/pg_cron>

> "pg_cron is a simple cron-based job scheduler for PostgreSQL (10 or higher) that runs inside the
> database as an extension."

> "to use `[1-59] seconds` to schedule a job based on an interval."

Example from the same page:

```sql
SELECT cron.schedule(
       'run_every_30_seconds',
       '30 seconds',
       'SELECT 1'
);
```
