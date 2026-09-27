# Supabase database CA

`supabase-prod-ca-2021.crt` is a public root CA certificate, not a private key or project credential. Downloaded on 2026-09-27 from the production URL configured in [official Supabase Studio](https://github.com/supabase/supabase/blob/36371de15127206280d2d40786e8578dfe1b681a/apps/studio/hooks/custom-content/custom-content.json):

https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt

- SHA-256 certificate fingerprint: `80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA`.
- Expires: 2031-04-26 10:56:53 UTC.
- Cloud environment setting: `DATABASE_SSL_CA_FILE=infra/certs/supabase-prod-ca-2021.crt`.

Runtime pg loads this CA with `rejectUnauthorized: true`; Prisma7 migrations receive it through the engine's `sslcert` parameter with `sslaccept=strict`. Local TEST connections keep their CA setting empty. Real Supabase session-pooler connections through both application roles and Prisma migration deployment passed with certificate verification enabled. [Environment guide](../../docs/ENVIRONMENT.md) records setup; [Supabase SSL documentation](https://supabase.com/docs/guides/platform/ssl-enforcement) describes the dashboard certificate download.
