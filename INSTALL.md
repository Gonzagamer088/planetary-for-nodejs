# Orbit (Planetary) - MySQL version with automatic startup

This is the official **Orbit / Planetary** (https://github.com/PlanetaryOrbit/orbit) adapted to run on
**MySQL/MariaDB** (the original uses PostgreSQL) and to **set itself up on startup**, with no console needed.

## Installation (3 steps)

1. Upload and unzip this package on your Node.js server.
2. Copy `.env.example` to `.env` and fill in at least:
   ```
   DATABASE_URL=mysql://USER:PASSWORD@MYSQL_IP:3306/DATABASE_NAME
   NEXTAUTH_URL=https://your-domain.com
   ```
   (If your panel has an "Environment variables" section you can set them there instead of creating `.env`.)
3. Set **`startup.js`** as the start file (command: `node startup.js`) and start the server.

Open your panel URL: the first time it takes you to `/welcome` to create the first user and workspace.

## What `startup.js` does by itself

1. Installs dependencies if they are missing (first run only, 2-5 min, needs internet access).
2. Generates a secure `SESSION_SECRET` if you did not set one (saved in `.session-secret`).
3. Waits for MySQL to respond and **creates/updates the tables** automatically.
4. Generates the Prisma client if missing.
5. Starts Orbit. **Scheduled tasks (cron jobs)** start automatically with the server.
6. If the server crashes, it **restarts it automatically**.

Everything is written to `logs/orbit.log` (useful if your panel's console does not work well).

## Requirements

- Node.js 20 or newer (22 recommended).
- MySQL 8+ or MariaDB 10.6+ reachable from this server (your host must allow connections from its IP).
- Recommended RAM: 1 GB or more (2-3 GB is plenty). The port is taken from the `PORT` variable (panels usually set it).

## Optional variables

| Variable | Purpose |
|---|---|
| `PORT` | Server port (default 3000) |
| `SESSION_SECRET` | Session key (if missing or weak, one is generated) |
| `ROBLOX_WORKSPACE_REDIRECTID` | Roblox group ID used to redirect to the workspace |
| `DB_POOL_SIZE` | Maximum MySQL connections (default 10) |
| `ORBIT_MAX_MEMORY` | Maximum memory for Node in MB (default 1536) |

## Troubleshooting

Check `logs/orbit.log`. The most common errors:
- *could not connect to the database*: check the username/password and that MySQL allows this server's IP.
- *DATABASE_URL is missing*: create `.env` from `.env.example`.
- *ERROR installing dependencies*: the server needs outbound access to `registry.npmjs.org`.
