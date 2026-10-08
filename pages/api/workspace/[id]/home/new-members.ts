import type { NextApiResponse } from 'next';

import { AuthenticatedRequest, withAuth } from '@/lib/withAuth';
import prisma from '@/utils/database';

export default withAuth(async function handler(req: AuthenticatedRequest, res: NextApiResponse) {
  const workspaceGroupId = parseInt(req.query.id as string, 10);
  if (!workspaceGroupId)
    return res.status(400).json({ success: false, error: 'Invalid workspace id' });
  if (!req.auth.userId) {
    return res.status(401).json({ success: false, error: 'Not logged in' });
  }

  const days = req.query.days ? parseInt(req.query.days as string, 10) : 7;
  const windowDays = isNaN(days) || days <= 0 || days > 30 ? 7 : days;

  const userid = Number(req.auth.userId);

  const userRoles = await prisma.role.findMany({
    where: {
      workspaceGroupId,
      members: { some: { userid: BigInt(userid) } },
    },
  });
  if (userRoles.length > 0) {
    try {
      await prisma.workspaceMember.upsert({
        where: { workspaceGroupId_userId: { workspaceGroupId, userId: userid } },
        create: { workspaceGroupId, userId: userid, joinDate: new Date() },
        update: {},
      });
    } catch (e) {}
  }

  const cutoff = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

  const recentRows = await prisma.workspaceMember.findMany({
    where: { workspaceGroupId, joinDate: { gte: cutoff } },
    orderBy: { joinDate: 'desc' },
    include: { user: { select: { userid: true, username: true, picture: true } } },
  });
  const recent = recentRows.map((r) => ({
    userid: r.user.userid,
    username: r.user.username,
    picture: r.user.picture,
    joinDate: r.joinDate,
    introNote: r.introNote,
    introSong: r.introSong,
  }));

  res.json({
    success: true,
    members: recent.map((r) => ({
      userid: r.userid.toString(),
      username: r.username || r.userid.toString(),
      picture: r.picture,
      joinDate: r.joinDate,
      introNote: r.introNote ?? null,
      introSong: r.introSong ?? null,
    })),
  });
});
