import { PrismaMariaDb } from '@prisma/adapter-mariadb';
import {
  PrismaClient,
  role,
  workspace,
  user,
  Session,
  SessionType,
  schedule,
  ActivitySession,
  document,
  wallPost,
  inactivityNotice,
  sessionUser,
  Quota,
  Ally,
  allyVisit,
  RoleMember,
  AuthSession,
} from '@prisma/client';

declare global {
  var prisma: PrismaClient | undefined;
}

function buildAdapter() {
  const u = new URL(process.env.DATABASE_URL!.replace(/^jdbc:/, ''));
  return new PrismaMariaDb({
    host: u.hostname,
    port: u.port ? Number(u.port) : 3306,
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: u.pathname.replace(/^\//, ''),
    connectionLimit: Number(process.env.DB_POOL_SIZE || 10),
    connectTimeout: 15000,
  });
}

const adapter = buildAdapter();

const prisma =
  globalThis.prisma ??
  new PrismaClient({
    adapter,
  });

if (process.env.NODE_ENV !== 'production') {
  globalThis.prisma = prisma;
}

(BigInt.prototype as any).toJSON = function () {
  return this.toString();
};

export type {
  role,
  workspace,
  user,
  Session,
  SessionType,
  schedule,
  ActivitySession,
  document,
  wallPost,
  inactivityNotice,
  sessionUser,
  Quota,
  Ally,
  allyVisit,
  RoleMember,
  AuthSession,
};

export default prisma;
