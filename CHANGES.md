# Changes compared to the official Orbit (GPL-3.0)

This package is a modified version of Orbit (PlanetaryOrbit/orbit), distributed under the same GPL-3.0 license
(see `LICENSE`). Changes made:

- **PostgreSQL -> MySQL/MariaDB database**: `prisma/schema.prisma` (provider `mysql`, `Text`/`Char(36)` columns),
  `@prisma/adapter-mariadb` adapter in `utils/database.ts`.
- **Lists (`String[]`, `BigInt[]`) -> JSON columns**: roles (`permissions`, `groupRoles`), schedules (`Days`),
  sessions (`statues`, `slots`), alliances (`notes`, `theirReps`) and visits (`participants`). The `has/hasSome`
  filters were replaced with the helpers in `utils/jsonList.ts`.
- **Custom SQL rewritten for MySQL**: `utils/logs.ts`, `pages/api/workspace/[id]/member/intro.ts`,
  `pages/api/workspace/[id]/home/new-members.ts`.
- **Migrations**: replaced by `scripts/db-setup.js`, which creates and updates the tables by reading the schema
  (it does not need to download Prisma's migration engine). The PostgreSQL `prisma/migrations` were removed.
- **Locally hosted fonts** (`fonts/`) instead of Google Fonts.
- **`startup.js`**: automatic startup (dependencies, secrets, tables, Prisma client, server and auto-restart).
- Dependencies pinned to the exact versions used for the build (`package.json` + `package-lock.json`).
