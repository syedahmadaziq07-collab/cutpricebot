import { Router, type IRouter } from "express";
import { Queue } from "../bot/models/queue";
import { User } from "../bot/models/user";

const adminRouter: IRouter = Router();

// GET /api/admin/queue — returns all users currently waiting in the queue
adminRouter.get("/admin/queue", async (_req, res) => {
  try {
    // Fetch all Queue entries (presence in collection = "waiting" by design)
    // Also accept explicit status="waiting" for new entries, and entries without status (legacy)
    const entries = await Queue.find({
      $or: [{ status: "waiting" }, { status: { $exists: false } }],
    }).sort({ createdAt: 1 });

    // Enrich with User data for any entries missing user info (legacy entries)
    const enriched = await Promise.all(
      entries.map(async (q) => {
        let telegramUsername = q.telegramUsername ?? "";
        let telegramName = q.telegramName ?? "";
        let tiktokUsername = q.tiktokUsername ?? "";

        if (!tiktokUsername) {
          const user = await User.findOne({ telegramId: q.telegramId }).select(
            "telegramUsername tiktokUsername",
          );
          if (user) {
            telegramUsername = user.telegramUsername ?? "";
            telegramName = user.telegramUsername ?? "";
            tiktokUsername = user.tiktokUsername ?? "";
          }
        }

        const waitingMs = Date.now() - new Date(q.createdAt).getTime();
        const waitingMinutes = Math.round(waitingMs / 60000);

        return {
          telegramId: q.telegramId,
          telegramUsername: telegramUsername || `id:${q.telegramId}`,
          telegramName: telegramName || telegramUsername || `id:${q.telegramId}`,
          tiktokUsername: tiktokUsername || "unknown",
          tiktokLink: q.pendingLink,
          status: (q.status as string) || "waiting",
          createdAt: q.createdAt,
          updatedAt: q.updatedAt ?? q.createdAt,
          waitingMinutes,
        };
      }),
    );

    console.log(
      `[DASHBOARD_QUEUE_COUNT] GET /admin/queue — count=${enriched.length} returning ${enriched.length} waiting user(s)`,
    );

    res.json({
      count: enriched.length,
      queue: enriched,
    });
  } catch (err) {
    console.error(`[DASHBOARD_QUEUE_ERROR] Failed to fetch queue: ${(err as Error).message}`);
    res.status(500).json({ error: "Failed to fetch queue", details: (err as Error).message });
  }
});

// GET /api/admin/users — returns all registered users summary
adminRouter.get("/admin/users", async (_req, res) => {
  try {
    const users = await User.find({})
      .select("telegramId telegramUsername tiktokUsername state cutBalance strikes isBanned suspendedUntil isWaiting queuedAt activeMatchId createdAt")
      .sort({ createdAt: -1 })
      .limit(500);

    res.json({
      count: users.length,
      users: users.map((u) => ({
        telegramId: u.telegramId,
        telegramUsername: u.telegramUsername || `id:${u.telegramId}`,
        tiktokUsername: u.tiktokUsername,
        state: u.state,
        cutBalance: u.cutBalance,
        strikes: u.strikes,
        isBanned: u.isBanned,
        suspendedUntil: u.suspendedUntil,
        isWaiting: u.isWaiting,
        queuedAt: u.queuedAt,
        activeMatchId: u.activeMatchId,
        createdAt: u.createdAt,
      })),
    });
  } catch (err) {
    console.error(`[DASHBOARD_USERS_ERROR] Failed to fetch users: ${(err as Error).message}`);
    res.status(500).json({ error: "Failed to fetch users", details: (err as Error).message });
  }
});

export default adminRouter;
