import { Telegraf, Markup } from "telegraf";
import { message } from "telegraf/filters";
import { User } from "./models/user";
import { Match } from "./models/match";
import { MatchHistory } from "./models/matchHistory";
import { Referral } from "./models/referral";
import { Queue } from "./models/queue";
import { logger } from "../lib/logger";

export async function cleanupStaleQueue(): Promise<void> {
  const now = new Date();
  const thirtyMinutesAgo = new Date(now.getTime() - 30 * 60 * 1000);

  // MIGRATION: rename legacy state value "in_queue" → "inqueue" across all User documents
  const migrationResult = await User.updateMany(
    { state: "in_queue" },
    { $set: { state: "inqueue" } },
  );
  if (migrationResult.modifiedCount > 0) {
    console.log(`[STARTUP_CLEANUP] MIGRATION: renamed state "in_queue" → "inqueue" for ${migrationResult.modifiedCount} user(s).`);
  }

  // Fix: inqueue users with no pendingLink → reset (they can't be matched)
  const nolinkResult = await User.updateMany(
    { state: "inqueue", $or: [{ pendingLink: null }, { pendingLink: "" }] },
    { $set: { isWaiting: false, state: "awaiting_cut_link", queuedAt: null } },
  );
  if (nolinkResult.modifiedCount > 0) {
    console.log(`[STARTUP_CLEANUP] Reset ${nolinkResult.modifiedCount} user(s) stuck inqueue with no pendingLink → awaiting_cut_link.`);
  }

  // Fix: users stuck inqueue for more than 30 minutes → reset
  const staleResult = await User.updateMany(
    { state: "inqueue", queuedAt: { $lte: thirtyMinutesAgo } },
    { $set: { state: "awaiting_cut_link", isWaiting: false, queuedAt: null, pendingLink: null } },
  );
  if (staleResult.modifiedCount > 0) {
    console.log(`[STARTUP_CLEANUP] Cleared ${staleResult.modifiedCount} user(s) stuck inqueue for >30 minutes.`);
  }

  // Rebuild Queue collection to match current User state
  // Remove Queue entries for users no longer inqueue
  const inqueueIds = (await User.find({ state: "inqueue" }).select("telegramId")).map(u => u.telegramId);
  const orphanResult = await Queue.deleteMany({ telegramId: { $nin: inqueueIds } });
  if (orphanResult.deletedCount > 0) {
    console.log(`[STARTUP_CLEANUP] Removed ${orphanResult.deletedCount} orphaned Queue entries (user no longer inqueue).`);
  }

  // Add Queue entries for inqueue users who are missing from Queue collection
  const queuedUsers = await User.find({ state: "inqueue", pendingLink: { $nin: [null, ""] } })
    .select("telegramId pendingLink queuedAt");
  for (const u of queuedUsers) {
    const exists = await Queue.findOne({ telegramId: u.telegramId });
    if (!exists) {
      await Queue.create({ telegramId: u.telegramId, pendingLink: u.pendingLink!, createdAt: u.queuedAt ?? new Date() });
      console.log(`[STARTUP_CLEANUP] Restored missing Queue entry for telegramId=${u.telegramId}.`);
    }
  }

  // Log final queue state
  const remaining = await Queue.find().sort({ createdAt: 1 });
  console.log(`[STARTUP_CLEANUP] Queue after cleanup: ${remaining.length} user(s).`);
  for (const q of remaining) {
    console.log(`  → telegramId=${q.telegramId} pendingLink=${q.pendingLink ? "SET" : "NULL"} createdAt=${q.createdAt.toISOString()}`);
  }
}

const DAILY_CUT_FLOOR = 7;
const REFERRAL_CUT_REWARD = 4;
const DAILY_REFERRAL_CAP = 20;
const COOLDOWN_MS = 24 * 60 * 60 * 1000;

const matchTimers = new Map<string, ReturnType<typeof setTimeout>>();

function generateReferralCode(): string {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function extractTikTokUsername(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed.startsWith("@")) return trimmed.slice(1);
  const match = trimmed.match(
    /(?:https?:\/\/)?(?:www\.)?tiktok\.com\/@([a-zA-Z0-9._]+)/i,
  );
  if (match && match[1]) return match[1];
  return null;
}

function isValidTikTokLink(url: string): boolean {
  return /(?:https?:\/\/)?(?:www\.)?(tiktok\.com|vm\.tiktok\.com|vt\.tiktok\.com)\//i.test(url);
}

async function checkAndApplyDailyReset(bot: Telegraf, telegramId: number): Promise<void> {
  const user = await User.findOne({ telegramId });
  if (!user || user.tiktokUsername === "__pending__") return;

  const now = new Date();
  const lastReset = user.lastDailyReset;
  const resetDue = !lastReset || now.getTime() - lastReset.getTime() >= COOLDOWN_MS;

  if (!resetDue) return;

  await User.updateOne({ telegramId }, { lastDailyReset: now });

  if (user.cutBalance < DAILY_CUT_FLOOR) {
    await User.updateOne({ telegramId }, { cutBalance: DAILY_CUT_FLOOR });
    console.log(`[DAILY_CUT_RESET] telegramId=${telegramId} (@${user.tiktokUsername}) reset from ${user.cutBalance} → ${DAILY_CUT_FLOOR} cuts.`);
    try {
      await bot.telegram.sendMessage(
        telegramId,
        `🎁 *Cut harian anda telah direset!*\n\nAnda kini mempunyai ${DAILY_CUT_FLOOR} cut untuk digunakan hari ini 🤝`,
        { parse_mode: "Markdown" },
      );
    } catch {
      // user may have blocked the bot
    }
  }
}

async function notifyQueueUsers(
  bot: Telegraf,
  newUserTikTok: string,
  newUserTelegramId: number,
): Promise<void> {
  const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
  const now = new Date();
  const eligibleUsers = await User.find({
    telegramId: { $ne: newUserTelegramId },
    tiktokUsername: { $nin: ["__pending__", ""] },
    isBanned: false,
    state: { $in: ["awaiting_cut_link", "idle"] },
    $and: [
      { $or: [{ suspendedUntil: null }, { suspendedUntil: { $lte: now } }] },
      { $or: [{ cancelCooldownUntil: null }, { cancelCooldownUntil: { $lte: now } }] },
      { $or: [{ lastNotifiedAt: null }, { lastNotifiedAt: { $lte: tenMinutesAgo } }] },
    ],
  });

  console.log(`[QUEUE] @${newUserTikTok} joined queue. Notifying ${eligibleUsers.length} eligible user(s).`);
  if (eligibleUsers.length === 0) {
    console.log(`[QUEUE] Queue empty — no eligible users to notify for @${newUserTikTok}.`);
  }

  let sentCount = 0;
  for (const u of eligibleUsers) {
    try {
      await bot.telegram.sendMessage(
        u.telegramId,
        `🔔 *Pengguna baru sedang mencari partner cut!*\n\nUsername TikTok:\n@${newUserTikTok}\n\nBuka bot sekarang untuk mula swap cut price link 🤝`,
        { parse_mode: "Markdown" },
      );
      await User.updateOne({ telegramId: u.telegramId }, { lastNotifiedAt: new Date() });
      sentCount++;
      console.log(`[NOTIFY] Sent notification to telegramId=${u.telegramId} (@${u.tiktokUsername})`);
    } catch (err) {
      console.error(`[NOTIFY] Failed to notify telegramId=${u.telegramId}: ${(err as Error).message}`);
    }
  }
  console.log(`[NOTIFY] Notifications sent: ${sentCount}/${eligibleUsers.length}`);
}

async function checkSuspension(telegramId: number): Promise<{ suspended: boolean; message: string }> {
  const user = await User.findOne({ telegramId });
  if (!user) return { suspended: false, message: "" };
  if (user.isBanned) return { suspended: true, message: "🚫 Kau dah kena permanent ban. Game over bro." };
  if (user.suspendedUntil && user.suspendedUntil > new Date()) {
    const remaining = Math.ceil((user.suspendedUntil.getTime() - Date.now()) / (1000 * 60 * 60));
    return { suspended: true, message: `⏳ Kau still kena suspend. Tunggu lagi ${remaining} jam k.` };
  }
  return { suspended: false, message: "" };
}

async function issueStrike(bot: Telegraf, telegramId: number): Promise<void> {
  const user = await User.findOne({ telegramId });
  if (!user) return;
  const newStrikes = user.strikes + 1;
  if (newStrikes >= 3) {
    await User.updateOne({ telegramId }, { strikes: newStrikes, isBanned: true, state: "idle", pendingLink: null });
    await bot.telegram.sendMessage(
      telegramId,
      "🚫 Strike 3! Kau dah kena *permanent ban*.\nPunca: screenshot tak valid / proof tak cukup.\n\nTa-ta! 👋",
      { parse_mode: "Markdown" },
    );
  } else {
    const suspendedUntil = new Date(Date.now() + COOLDOWN_MS);
    await User.updateOne({ telegramId }, { strikes: newStrikes, suspendedUntil, state: "idle", pendingLink: null });
    const msgs = [
      `⚠️ Strike ${newStrikes}/3!\nScreenshot tak valid. Kau kena *suspend 24 jam*.\n\nJangan repeat k! 😤`,
      `⚠️ Strike ${newStrikes}/3!\nProof tak lepas semak. 24 jam suspend dimulakan.\n\nLast warning ni! 😡`,
    ];
    await bot.telegram.sendMessage(telegramId, msgs[newStrikes - 1] || msgs[0]!, { parse_mode: "Markdown" });
  }
}

async function handleMatchExpiry(
  bot: Telegraf,
  matchId: string,
  user1Id: number,
  user2Id: number,
): Promise<void> {
  const match = await Match.findById(matchId);
  if (!match || match.status !== "active") return;

  await Match.updateOne({ _id: matchId }, { status: "expired" });
  const expireMsg = "⏰ 4 minit dah habis! Partner tak respond.\n\nSubmit link baru untuk rematch k 👇";

  for (const uid of [user1Id, user2Id]) {
    const user = await User.findOne({ telegramId: uid });
    if (!user) continue;
    const activeStates = ["in_match", "awaiting_proof", "awaiting_partner_approval"];
    if (!activeStates.includes(user.state)) continue;
    await Queue.deleteOne({ telegramId: uid });
    await User.updateOne(
      { telegramId: uid },
      { state: "awaiting_cut_link", pendingLink: null, isWaiting: false, queuedAt: null },
    );
    console.log(`[QUEUE_REMOVE] telegramId=${uid} removed from queue (match expired).`);
    await bot.telegram.sendMessage(uid, expireMsg);
  }
  matchTimers.delete(matchId);
}

async function hasCooldown(userIdA: number, userIdB: number): Promise<boolean> {
  const since = new Date(Date.now() - COOLDOWN_MS);
  const pairKey = [userIdA, userIdB].sort((a, b) => a - b).join(":");
  const existing = await MatchHistory.findOne({
    pairKey,
    matchedAt: { $gte: since },
  });
  if (!existing) {
    console.log(`[REMATCH_ALLOWED_AFTER_24H] pairKey=${pairKey} — no recent match found, pair is eligible.`);
  }
  return existing !== null;
}

// Scan the Queue collection for the first eligible pair and create a match.
// Returns true if a match was created.
async function tryMatch(bot: Telegraf): Promise<boolean> {
  const entries = await Queue.find().sort({ createdAt: 1 }).limit(50);

  console.log(`[MATCH_ATTEMPT] ─── tryMatch called — Queue size: ${entries.length} ───`);
  for (const e of entries) {
    console.log(`  → telegramId=${e.telegramId} pendingLink=${e.pendingLink ? "SET" : "NULL"} createdAt=${e.createdAt.toISOString()}`);
  }

  if (entries.length < 2) {
    console.log(`[MATCH_ATTEMPT] Not enough users in queue to match.`);
    return false;
  }

  const now = new Date();

  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const entryA = entries[i];
      const entryB = entries[j];

      if (entryA.telegramId === entryB.telegramId) continue;

      // Check suspension for both
      const [susA, susB] = await Promise.all([
        checkSuspension(entryA.telegramId),
        checkSuspension(entryB.telegramId),
      ]);
      if (susA.suspended) {
        console.log(`[MATCH_ATTEMPT] telegramId=${entryA.telegramId} is suspended — removing from queue.`);
        await Queue.deleteOne({ telegramId: entryA.telegramId });
        await User.updateOne({ telegramId: entryA.telegramId }, { state: "awaiting_cut_link", isWaiting: false, queuedAt: null });
        return tryMatch(bot);
      }
      if (susB.suspended) {
        console.log(`[MATCH_ATTEMPT] telegramId=${entryB.telegramId} is suspended — removing from queue.`);
        await Queue.deleteOne({ telegramId: entryB.telegramId });
        await User.updateOne({ telegramId: entryB.telegramId }, { state: "awaiting_cut_link", isWaiting: false, queuedAt: null });
        return tryMatch(bot);
      }

      // Check 24h cooldown between this pair
      const onCooldown = await hasCooldown(entryA.telegramId, entryB.telegramId);
      if (onCooldown) {
        console.log(`[RECENT_PAIR_BLOCKED] Pair telegramId=${entryA.telegramId} & telegramId=${entryB.telegramId} matched within last 24h — skipping, trying next pair.`);
        console.log(`[NEXT_PARTNER_SEARCH] Continuing search for other eligible partners...`);
        continue;
      }

      console.log(`[MATCH_ATTEMPT] Eligible pair found: telegramId=${entryA.telegramId} & telegramId=${entryB.telegramId}. Removing from queue...`);

      // Atomically remove both from Queue
      const deleted = await Queue.deleteMany({
        telegramId: { $in: [entryA.telegramId, entryB.telegramId] },
      });
      if (deleted.deletedCount < 2) {
        // Race condition — one was claimed by a concurrent tryMatch, retry
        console.log(`[MATCH_ATTEMPT] Race condition on Queue delete (deleted=${deleted.deletedCount}). Retrying.`);
        const retryResult = await tryMatch(bot);
        // After retry, clean up any user whose Queue entry was deleted but User state
        // was never reset (orphaned inqueue user)
        const orphans = await User.find({ state: "inqueue" });
        for (const u of orphans) {
          const inQueue = await Queue.findOne({ telegramId: u.telegramId });
          if (!inQueue) {
            await User.updateOne({ telegramId: u.telegramId }, { state: "awaiting_cut_link", isWaiting: false, queuedAt: null });
            try { await bot.telegram.sendMessage(u.telegramId, "⚠️ Eh something went wrong. Cuba submit link kau balik k!"); } catch {}
            console.log(`[ORPHAN_CLEANUP] Reset orphaned inqueue user telegramId=${u.telegramId}.`);
          }
        }
        return retryResult;
      }

      // Update both users to in_match
      await Promise.all([
        User.updateOne({ telegramId: entryA.telegramId }, { state: "in_match", isWaiting: false, queuedAt: null, lastMatchPartnerId: entryB.telegramId }),
        User.updateOne({ telegramId: entryB.telegramId }, { state: "in_match", isWaiting: false, queuedAt: null, lastMatchPartnerId: entryA.telegramId }),
      ]);

      const [userA, userB] = await Promise.all([
        User.findOne({ telegramId: entryA.telegramId }),
        User.findOne({ telegramId: entryB.telegramId }),
      ]);

      const expiresAt = new Date(now.getTime() + 4 * 60 * 1000);
      const [match] = await Promise.all([
        Match.create({
          user1Id: entryA.telegramId,
          user2Id: entryB.telegramId,
          link1: entryA.pendingLink,
          link2: entryB.pendingLink,
          expiresAt,
        }),
        MatchHistory.create({ userIdA: entryA.telegramId, userIdB: entryB.telegramId, pairKey: [entryA.telegramId, entryB.telegramId].sort((a, b) => a - b).join(":"), matchedAt: now }),
      ]);

      const matchId = (match._id as { toString(): string }).toString();
      console.log(`[MATCH_CREATED] matchId=${matchId} | userA=${entryA.telegramId} (@${userA?.tiktokUsername}) link="${entryA.pendingLink}" | userB=${entryB.telegramId} (@${userB?.tiktokUsername}) link="${entryB.pendingLink}"`);
      console.log(`[MATCH_HISTORY_CREATED] pairKey=${[entryA.telegramId, entryB.telegramId].sort((a,b)=>a-b).join(":")} matchedAt=${now.toISOString()}`);

      const matchButtons = Markup.inlineKeyboard([
        Markup.button.callback("✅ Done Cut", "done_cut"),
        Markup.button.callback("❌ Cancel Match (24h cooldown)", "cancel_match"),
      ]);

      await Promise.all([
        bot.telegram.sendMessage(entryA.telegramId,
          `✅ *Partner dijumpai!*\n\nPartner anda:\n@${userB?.tiktokUsername}\n\nLink cut partner:\n${entryB.pendingLink}\n\nSila cut link partner anda dahulu 🤝`,
          { parse_mode: "Markdown", ...matchButtons }),
        bot.telegram.sendMessage(entryB.telegramId,
          `✅ *Partner dijumpai!*\n\nPartner anda:\n@${userA?.tiktokUsername}\n\nLink cut partner:\n${entryA.pendingLink}\n\nSila cut link partner anda dahulu 🤝`,
          { parse_mode: "Markdown", ...matchButtons }),
      ]);

      const timer = setTimeout(async () => {
        await handleMatchExpiry(bot, matchId, entryA.telegramId, entryB.telegramId);
      }, 4 * 60 * 1000);
      matchTimers.set(matchId, timer);

      return true;
    }
  }

  console.log(`[MATCH_ATTEMPT] No eligible pair found after checking all combinations.`);
  return false;
}

// Add a user to the Queue collection and immediately attempt a match.
async function addToQueue(bot: Telegraf, telegramId: number, pendingLink: string): Promise<void> {
  // Remove any stale entry first (idempotent)
  await Queue.deleteOne({ telegramId });
  // Insert fresh entry
  const queuedAt = new Date();
  await Queue.create({ telegramId, pendingLink, createdAt: queuedAt });
  await User.updateOne({ telegramId }, { state: "inqueue", isWaiting: true, queuedAt, pendingLink });

  const queueSize = await Queue.countDocuments();
  console.log(`[QUEUE_ADD] telegramId=${telegramId} added. Queue size: ${queueSize}. Triggering tryMatch...`);

  // Small delay so the DB write is committed before we read it back in tryMatch
  await new Promise<void>(res => setTimeout(res, 300));

  await tryMatch(bot);
}

async function grantReferralReward(bot: Telegraf, referredUserId: number): Promise<void> {
  const referral = await Referral.findOne({ referredId: referredUserId, rewardGranted: false });
  if (!referral) return;

  const referrer = await User.findOne({ telegramId: referral.referrerId });
  if (!referrer) {
    console.log(`[REFERRAL_REJECTED] Referrer telegramId=${referral.referrerId} not found for referredId=${referredUserId}.`);
    return;
  }

  const now = new Date();

  const dailyWindowExpired = !referrer.dailyReferralResetAt ||
    now.getTime() - referrer.dailyReferralResetAt.getTime() >= COOLDOWN_MS;

  let cutsToday = referrer.dailyReferralCutsToday;
  let resetAt = referrer.dailyReferralResetAt;

  if (dailyWindowExpired) {
    cutsToday = 0;
    resetAt = now;
  }

  if (cutsToday + REFERRAL_CUT_REWARD > DAILY_REFERRAL_CAP) {
    console.log(`[REFERRAL_DAILY_LIMIT_REACHED] telegramId=${referral.referrerId} (@${referrer.tiktokUsername}) has reached daily referral cap (${cutsToday}/${DAILY_REFERRAL_CAP}). Reward not granted for referredId=${referredUserId}.`);
    await Referral.updateOne({ _id: referral._id }, { rewardGranted: true, rewardGrantedAt: now });
    return;
  }

  const newBalance = referrer.cutBalance + REFERRAL_CUT_REWARD;
  const newCutsToday = cutsToday + REFERRAL_CUT_REWARD;

  await Promise.all([
    User.updateOne(
      { telegramId: referral.referrerId },
      { cutBalance: newBalance, dailyReferralCutsToday: newCutsToday, dailyReferralResetAt: resetAt },
    ),
    Referral.updateOne({ _id: referral._id }, { rewardGranted: true, rewardGrantedAt: now }),
  ]);

  console.log(`[REFERRAL_REWARD_GRANTED] telegramId=${referral.referrerId} (@${referrer.tiktokUsername}) received +${REFERRAL_CUT_REWARD} cuts for referredId=${referredUserId}. New balance: ${newBalance}. Daily referral cuts today: ${newCutsToday}/${DAILY_REFERRAL_CAP}.`);

  try {
    await bot.telegram.sendMessage(
      referral.referrerId,
      `🎉 Kawan yang kau jemput baru sahaja selesaikan swap pertama mereka!\n\n*+${REFERRAL_CUT_REWARD} cuts* dah masuk balance kau! 🔥\n\nCut baki: *${newBalance}*`,
      { parse_mode: "Markdown" },
    );
  } catch {
    // user may have blocked the bot
  }
}

async function checkAndCompleteMatch(bot: Telegraf, matchId: string): Promise<void> {
  const match = await Match.findById(matchId);
  if (!match || match.status !== "active") return;

  const bothSubmitted = match.user1ProofSubmitted && match.user2ProofSubmitted;
  const bothApproved = match.user1ProofApprovedByPartner && match.user2ProofApprovedByPartner;
  if (!bothSubmitted || !bothApproved) return;

  const timerId = match._id.toString();
  const existingTimer = matchTimers.get(timerId);
  if (existingTimer) {
    clearTimeout(existingTimer);
    matchTimers.delete(timerId);
  }

  await Match.updateOne({ _id: matchId }, { status: "completed" });
  console.log(`[MATCH_COMPLETED] matchId=${matchId} — both proofs submitted and approved.`);

  for (const uid of [match.user1Id, match.user2Id]) {
    const user = await User.findOne({ telegramId: uid });
    if (!user) continue;

    const newBalance = Math.max(0, user.cutBalance - 1);
    const isFirstSwap = !user.firstSwapCompleted;

    await User.updateOne(
      { telegramId: uid },
      {
        state: "awaiting_cut_link",
        cutBalance: newBalance,
        pendingLink: null,
        queuedAt: null,
        isWaiting: false,
        firstSwapCompleted: true,
      },
    );

    if (newBalance === 0) {
      const me = await bot.telegram.getMe();
      const refLink = `https://t.me/${me.username}?start=ref_${user.referralCode}`;
      await bot.telegram.sendMessage(
        uid,
        `🎉 *Swap selesai!*\n\nTerima kasih kerana menggunakan CutSquad 🤝\n\nCut baki: *0/${DAILY_CUT_FLOOR}* 😮\n\nKau dah habis semua cuts!\n\n🔥 Nak lagi? Share bot ni & dapat *+${REFERRAL_CUT_REWARD} cuts* setiap orang yang join!\n\n${refLink}`,
        { parse_mode: "Markdown" },
      );
    } else {
      await bot.telegram.sendMessage(
        uid,
        `🎉 *Swap selesai!*\n\nTerima kasih kerana menggunakan CutSquad 🤝\n\nCut baki: *${newBalance}*`,
        {
          parse_mode: "Markdown",
          ...Markup.inlineKeyboard([Markup.button.callback("🔁 Cut Lagi!", "cut_more")]),
        },
      );
    }

    if (isFirstSwap) {
      await grantReferralReward(bot, uid);
    }
  }
}

export function createBot(): Telegraf {
  const token = process.env["BOT_TOKEN"];
  if (!token) throw new Error("BOT_TOKEN is required");

  const bot = new Telegraf(token);

  bot.start(async (ctx) => {
    const telegramId = ctx.from.id;
    const telegramUsername = ctx.from.username ?? "";
    const payload = ctx.startPayload;

    const existingUser = await User.findOne({ telegramId });

    if (existingUser && existingUser.tiktokUsername && existingUser.tiktokUsername !== "__pending__") {
      const sus = await checkSuspension(telegramId);
      if (sus.suspended) { await ctx.reply(sus.message); return; }
      await ctx.reply(
        `Eh, kau dah register la @${existingUser.tiktokUsername}! 👋\n\nCut baki: *${existingUser.cutBalance}*\n\nHantar TikTok cut price link untuk mula! 🔗`,
        { parse_mode: "Markdown" },
      );
      // Clear any stale Queue entry before resetting state
      await Queue.deleteOne({ telegramId });
      await User.updateOne({ telegramId }, { state: "awaiting_cut_link" });
      return;
    }

    let referralCode: string | null = null;
    if (payload && payload.startsWith("ref_")) referralCode = payload.slice(4);

    await User.findOneAndUpdate(
      { telegramId },
      {
        telegramId,
        telegramUsername,
        tiktokUsername: "__pending__",
        referralCode: generateReferralCode(),
        state: "awaiting_tiktok_profile",
        $setOnInsert: { pendingReferralCode: referralCode },
      },
      { upsert: true, new: true },
    );

    await ctx.reply(
      "👋 Weh selamat datang ke *CutSquad*!\n\nBot ni untuk swap TikTok cut price links — kau cut gue, gue cut kau! 🔁\n\nHantar link profile TikTok kau 👇\n_(contoh: https://www.tiktok.com/@username)_",
      { parse_mode: "Markdown" },
    );
  });

  bot.command("balance", async (ctx) => {
    const user = await User.findOne({ telegramId: ctx.from.id });
    if (!user || user.tiktokUsername === "__pending__") {
      await ctx.reply("Kau belum register lagi. Taip /start dulu k!");
      return;
    }
    await ctx.reply(
      `💰 *Balance kau:*\n\nCut baki: *${user.cutBalance}*\nStrike: ${user.strikes}/3\n\nReferral link kau:\n👇`,
      { parse_mode: "Markdown" },
    );
    const me = await bot.telegram.getMe();
    const refLink = `https://t.me/${me.username}?start=ref_${user.referralCode}`;
    await ctx.reply(refLink);
  });

  bot.command("referral", async (ctx) => {
    const user = await User.findOne({ telegramId: ctx.from.id });
    if (!user || user.tiktokUsername === "__pending__") {
      await ctx.reply("Kau belum register lagi. Taip /start dulu k!");
      return;
    }
    const me = await bot.telegram.getMe();
    const refLink = `https://t.me/${me.username}?start=ref_${user.referralCode}`;
    await ctx.reply(
      `🔥 *Referral link kau:*\n\n${refLink}\n\nShare ni — setiap kawan yang join & selesaikan swap pertama = *+${REFERRAL_CUT_REWARD} cuts* untuk kau!\n\n_(Had harian: ${DAILY_REFERRAL_CAP} cuts daripada referral)_`,
      { parse_mode: "Markdown" },
    );
  });

  bot.command("debug_queue", async (ctx) => {
    const telegramId = ctx.from.id;
    console.log(`[DEBUG_QUEUE] /debug_queue requested by telegramId=${telegramId}`);

    const queueEntries = await Queue.find().sort({ createdAt: 1 });

    if (queueEntries.length === 0) {
      await ctx.reply("✅ Queue is empty — Queue collection has 0 entries.");
      return;
    }

    const lines = await Promise.all(queueEntries.map(async (q, i) => {
      const age = `${Math.round((Date.now() - q.createdAt.getTime()) / 1000)}s ago`;
      const u = await User.findOne({ telegramId: q.telegramId }).select("telegramUsername tiktokUsername state isWaiting");
      return (
        `${i + 1}. telegramId=${q.telegramId}\n` +
        `   @TG: ${u?.telegramUsername || "?"} | @TT: ${u?.tiktokUsername ?? "?"}\n` +
        `   user.state=${u?.state ?? "?"} | user.isWaiting=${u?.isWaiting ?? "?"}\n` +
        `   in Queue since: ${age}\n` +
        `   pendingLink: ${q.pendingLink ? "SET" : "NULL"}`
      );
    }));

    const reply = `🔍 *Queue Debug (${queueEntries.length} user(s)):*\n\n` + lines.join("\n\n");
    await ctx.reply(reply, { parse_mode: "Markdown" });
  });

  bot.command("debug_match_history", async (ctx) => {
    const since = new Date(Date.now() - COOLDOWN_MS);
    const history = await MatchHistory.find({ matchedAt: { $gte: since } }).sort({ matchedAt: -1 }).limit(20);
    if (history.length === 0) {
      await ctx.reply("✅ No match history in the last 24 hours.");
      return;
    }
    const lines = await Promise.all(history.map(async (h, i) => {
      const uA = await User.findOne({ telegramId: h.userIdA }).select("tiktokUsername");
      const uB = await User.findOne({ telegramId: h.userIdB }).select("tiktokUsername");
      const age = Math.round((Date.now() - h.matchedAt.getTime()) / (1000 * 60));
      const resetIn = Math.round((COOLDOWN_MS - (Date.now() - h.matchedAt.getTime())) / (1000 * 60));
      return (
        `${i + 1}. @${uA?.tiktokUsername ?? h.userIdA} ↔️ @${uB?.tiktokUsername ?? h.userIdB}\n` +
        `   pairKey: ${(h as any).pairKey ?? "N/A"}\n` +
        `   matched: ${age} min ago | cooldown resets in: ${resetIn} min`
      );
    }));
    await ctx.reply(`🕐 *Match History (last 24h):*\n\n` + lines.join("\n\n"), { parse_mode: "Markdown" });
  });

  bot.command("status", async (ctx) => {
    const user = await User.findOne({ telegramId: ctx.from.id });
    if (!user || user.tiktokUsername === "__pending__") {
      await ctx.reply("Belum register. /start dulu la bro!");
      return;
    }
    const statusMap: Record<string, string> = {
      idle: "😴 Idle",
      awaiting_cut_link: "⏳ Tunggu link",
      inqueue: "🔍 Cari partner...",
      in_match: "🤝 In match",
      awaiting_proof: "📸 Menunggu bukti",
      awaiting_partner_approval: "⏳ Menunggu kelulusan partner",
    };
    await ctx.reply(
      `📊 *Status kau:*\n\nTikTok: @${user.tiktokUsername}\nCut baki: ${user.cutBalance}\nStrikes: ${user.strikes}/3\nStatus: ${statusMap[user.state] ?? user.state}`,
      { parse_mode: "Markdown" },
    );
  });

  bot.on(message("photo"), async (ctx) => {
    const telegramId = ctx.from.id;
    console.log(`[MSG] photo from telegramId=${telegramId}`);

    const sus = await checkSuspension(telegramId);
    if (sus.suspended) { await ctx.reply(sus.message); return; }

    await checkAndApplyDailyReset(bot, telegramId);

    const user = await User.findOne({ telegramId });
    if (!user || user.tiktokUsername === "__pending__") {
      await ctx.reply("Kau belum register lagi. Taip /start dulu k!");
      return;
    }

    if (user.state === "in_match") {
      await ctx.reply("Sila tekan butang *✅ Done Cut* dahulu sebelum menghantar bukti ya.", { parse_mode: "Markdown" });
      return;
    }

    if (user.state === "awaiting_partner_approval") {
      await ctx.reply("⏳ Bukti anda sudah dihantar. Sila tunggu partner anda semak dan approve terlebih dahulu.");
      return;
    }

    if (user.state !== "awaiting_proof") {
      await ctx.reply("Tiada match aktif. Hantar link TikTok anda dahulu untuk mula.");
      return;
    }

    const match = await Match.findOne({
      $or: [{ user1Id: telegramId }, { user2Id: telegramId }],
      status: "active",
    });

    if (!match) {
      await ctx.reply("Hmm takde match active la. Cuba /start balik k.");
      return;
    }

    const isUser1 = match.user1Id === telegramId;
    const partnerId = isUser1 ? match.user2Id : match.user1Id;
    const matchId = match._id.toString();

    const alreadySubmitted = isUser1 ? match.user1ProofSubmitted : match.user2ProofSubmitted;
    if (alreadySubmitted) {
      await ctx.reply("⏳ Bukti anda sudah dihantar. Sila tunggu partner anda semak dan approve terlebih dahulu.");
      return;
    }

    const photos = ctx.message.photo;
    const photo = photos[photos.length - 1];
    if (!photo) {
      await ctx.reply("Gambar tidak diterima. Sila cuba semula.");
      return;
    }

    const proofMessageId = ctx.message.message_id.toString();
    const proofFileId = photo.file_id;
    const now = new Date();

    if (isUser1) {
      await Match.updateOne({ _id: match._id }, {
        user1ProofSubmitted: true,
        user1ProofMessageId: proofMessageId,
        user1ProofSubmittedAt: now,
        user1Confirmed: true,
      });
    } else {
      await Match.updateOne({ _id: match._id }, {
        user2ProofSubmitted: true,
        user2ProofMessageId: proofMessageId,
        user2ProofSubmittedAt: now,
        user2Confirmed: true,
      });
    }

    console.log(`[PROOF_SUBMITTED] telegramId=${telegramId} submitted proof for matchId=${matchId}.`);
    await User.updateOne({ telegramId }, { state: "awaiting_partner_approval" });
    await ctx.reply("✅ Bukti anda telah dihantar.\nTunggu partner anda semak dan approve bukti tersebut.");

    const approveButtons = Markup.inlineKeyboard([
      Markup.button.callback("✅ Approve Proof", `approve_proof:${matchId}:${telegramId}`),
      Markup.button.callback("❌ Reject Proof", `reject_proof:${matchId}:${telegramId}`),
    ]);

    await bot.telegram.sendPhoto(partnerId, proofFileId, {
      caption: `📸 *Partner anda telah menghantar bukti cut.*\n\nSila semak bukti di bawah sebelum approve.`,
      parse_mode: "Markdown",
      ...approveButtons,
    });
  });

  bot.on(message("text"), async (ctx) => {
    const telegramId = ctx.from.id;
    const text = ctx.message.text.trim();
    console.log(`[MSG] text from telegramId=${telegramId}: ${text.slice(0, 80)}`);

    if (text.startsWith("/")) return;

    const sus = await checkSuspension(telegramId);
    if (sus.suspended) { await ctx.reply(sus.message); return; }

    await checkAndApplyDailyReset(bot, telegramId);

    const user = await User.findOne({ telegramId });

    if (!user || user.tiktokUsername === "__pending__") {
      if (user?.state === "awaiting_tiktok_profile") {
        console.log(`[TIKTOK] Received profile link from telegramId=${telegramId}: ${text.slice(0, 100)}`);
        const username = extractTikTokUsername(text);
        if (!username) {
          console.warn(`[TIKTOK] Username extraction failed for telegramId=${telegramId}, input="${text.slice(0, 100)}"`);
          await ctx.reply("Hmm link tu tak valid la 😕\nHantar betul2 k — contoh:\nhttps://www.tiktok.com/@username");
          return;
        }

        const referralDoc = await User.findOne({ telegramId });
        const pendingRef = (referralDoc as any)?.pendingReferralCode ?? null;

        await User.updateOne(
          { telegramId },
          { tiktokUsername: username, tiktokProfileLink: text, telegramUsername: ctx.from.username ?? "", state: "awaiting_cut_link" },
        );

        if (pendingRef) {
          const referrer = await User.findOne({ referralCode: pendingRef });
          if (referrer && referrer.telegramId !== telegramId) {
            await User.updateOne({ telegramId }, { referredBy: pendingRef });
            await Referral.create({
              referralCode: pendingRef,
              referrerId: referrer.telegramId,
              referredId: telegramId,
            });
            console.log(`[REFERRAL_PENDING] telegramId=${telegramId} (@${username}) joined via referral from telegramId=${referrer.telegramId} (@${referrer.tiktokUsername}). Reward pending first swap completion.`);
          } else {
            console.log(`[REFERRAL_REJECTED] Self-referral or referrer not found for telegramId=${telegramId}, code=${pendingRef}.`);
          }
        }

        const me = await bot.telegram.getMe();
        const updatedUser = await User.findOne({ telegramId });
        const refLink = `https://t.me/${me.username}?start=ref_${updatedUser!.referralCode}`;

        await ctx.reply(
          `Welcome @${username}! ✅\n\nKau dapat *${DAILY_CUT_FLOOR} cuts* untuk start!\n\nReferral link kau:\n${refLink}\n\nSekarang hantar TikTok cut price link kau 👇`,
          { parse_mode: "Markdown" },
        );
      } else {
        await ctx.reply("Taip /start dulu la bro untuk register! 👋");
      }
      return;
    }

    if (user.state === "awaiting_tiktok_profile") {
      console.log(`[TIKTOK] Received profile link from telegramId=${telegramId}: ${text.slice(0, 100)}`);
      const username = extractTikTokUsername(text);
      if (!username) {
        console.warn(`[TIKTOK] Username extraction failed for telegramId=${telegramId}, input="${text.slice(0, 100)}"`);
        await ctx.reply("Link tu pelik sikit 😕\nHantar link profile TikTok betul k — contoh:\nhttps://www.tiktok.com/@username");
        return;
      }
      await User.updateOne({ telegramId }, { tiktokUsername: username, tiktokProfileLink: text, state: "awaiting_cut_link" });
      await ctx.reply(`Welcome @${username}! ✅\n\nSekarang hantar TikTok cut price link kau 👇`);
      return;
    }

    if (user.state === "awaiting_cut_link") {
      if (user.cancelCooldownUntil && user.cancelCooldownUntil > new Date()) {
        const remaining = Math.ceil((user.cancelCooldownUntil.getTime() - Date.now()) / (1000 * 60 * 60));
        await ctx.reply(
          `❌ Akaun anda masih dalam cooldown selama *${remaining} jam* lagi.\n\nAnda boleh menggunakan sistem semula selepas tempoh ini tamat.`,
          { parse_mode: "Markdown" },
        );
        return;
      }

      if (user.cutBalance <= 0) {
        const me = await bot.telegram.getMe();
        const refLink = `https://t.me/${me.username}?start=ref_${user.referralCode}`;
        await ctx.reply(
          `😬 Cuts kau dah habis bro!\n\n🔥 Share bot ni & dapat *+${REFERRAL_CUT_REWARD} cuts* setiap orang yang join & selesaikan swap!\n\n${refLink}`,
          { parse_mode: "Markdown" },
        );
        return;
      }

      if (!isValidTikTokLink(text)) {
        await ctx.reply("Link ni takde life la 💀 Try lain k!\n_(Kena link TikTok yang valid)_", { parse_mode: "Markdown" });
        return;
      }

      const activeMatch = await Match.findOne({
        $or: [{ user1Id: telegramId }, { user2Id: telegramId }],
        status: "active",
      });

      if (activeMatch) {
        console.log(`[ACTIVE_MATCH_BLOCKED_NEW_LINK] telegramId=${telegramId} (@${user.tiktokUsername}) tried to submit new link while match ${activeMatch._id} is still active.`);
        await ctx.reply(
          "⚠️ *Selesaikan swap semasa dahulu.*\n\nAnda hanya boleh cari partner baru selepas kedua-dua pihak approve bukti cut masing-masing.",
          { parse_mode: "Markdown" },
        );
        return;
      }

      // Log diagnostic snapshot before queuing
      console.log(
        `[LINK_RECEIVED] ─── User sent cut link ───\n` +
        `  telegramId          = ${telegramId}\n` +
        `  username            = @${user.tiktokUsername}\n` +
        `  state (before)      = ${user.state}\n` +
        `  isWaiting (before)  = ${user.isWaiting}\n` +
        `  pendingLink (before)= ${user.pendingLink ? `"${user.pendingLink}"` : "NULL"}`,
      );

      await ctx.reply("Secured! 🔒 Finding ur partner…\n\n_(Kau dalam queue — bot tengah cari match sekarang)_", { parse_mode: "Markdown" });

      // Add to Queue and attempt match first, then notify other users
      await addToQueue(bot, telegramId, text);
      await notifyQueueUsers(bot, user.tiktokUsername, telegramId);
      return;
    }

    if (user.state === "inqueue") {
      await ctx.reply("Relax bro! 😅 Tengah cari partner kau. Tunggu sekejap k…");
      return;
    }

    if (user.state === "in_match") {
      await ctx.reply("Sila tekan butang *✅ Done Cut* apabila anda selesai cut link partner.", { parse_mode: "Markdown" });
      return;
    }

    if (user.state === "awaiting_proof") {
      await ctx.reply("Sila hantar *screenshot* sebagai bukti anda telah cut link partner. 📸", { parse_mode: "Markdown" });
      return;
    }

    if (user.state === "awaiting_partner_approval") {
      await ctx.reply("⏳ Bukti anda sudah dihantar. Sila tunggu partner anda semak dan approve terlebih dahulu.");
      return;
    }

    await ctx.reply("Taip /start untuk mula atau /status untuk semak status anda.");
  });

  bot.action("done_cut", async (ctx) => {
    await ctx.answerCbQuery();
    const telegramId = ctx.from!.id;
    const user = await User.findOne({ telegramId });
    if (!user || user.state !== "in_match") {
      await ctx.reply("Tiada match aktif untuk disahkan.");
      return;
    }
    await User.updateOne({ telegramId }, { state: "awaiting_proof" });
    await ctx.reply("📸 Sila hantar *screenshot* sebagai bukti anda telah cut link partner.", { parse_mode: "Markdown" });
  });

  bot.action("cancel_match", async (ctx) => {
    await ctx.answerCbQuery();
    const telegramId = ctx.from!.id;
    const user = await User.findOne({ telegramId });
    if (!user || user.state !== "in_match") {
      await ctx.reply("Tiada match aktif untuk dibatalkan.");
      return;
    }

    const match = await Match.findOne({
      $or: [{ user1Id: telegramId }, { user2Id: telegramId }],
      status: "active",
    });
    if (!match) { await ctx.reply("Tiada match aktif."); return; }

    const partnerId = match.user1Id === telegramId ? match.user2Id : match.user1Id;
    const partner = await User.findOne({ telegramId: partnerId });

    await Match.updateOne({ _id: match._id }, { status: "cancelled" });

    const timerId = match._id.toString();
    const existingTimer = matchTimers.get(timerId);
    if (existingTimer) { clearTimeout(existingTimer); matchTimers.delete(timerId); }

    const cooldownUntil = new Date(Date.now() + COOLDOWN_MS);
    await User.updateOne(
      { telegramId },
      { state: "idle", isWaiting: false, queuedAt: null, cancelCooldownUntil: cooldownUntil, pendingLink: null },
    );

    console.log(`[MATCH_CANCELLED] telegramId=${telegramId} (@${user.tiktokUsername}) cancelled the match.`);
    console.log(`[USER_COOLDOWN] telegramId=${telegramId} on cooldown until ${cooldownUntil.toISOString()}.`);

    await ctx.reply(
      "❌ *Match dibatalkan.*\n\nAkaun anda dalam cooldown selama 24 jam sebelum boleh menggunakan sistem semula.",
      { parse_mode: "Markdown" },
    );

    await Queue.deleteOne({ telegramId });

    if (partner) {
      await Queue.deleteOne({ telegramId: partnerId });
      await bot.telegram.sendMessage(
        partnerId,
        "⚠️ *Partner anda telah membatalkan match.*\n\nSistem sedang mencari partner baru untuk anda 🤝",
        { parse_mode: "Markdown" },
      );
      if (partner.pendingLink) {
        console.log(`[PARTNER_REQUEUED] telegramId=${partnerId} (@${partner.tiktokUsername ?? "unknown"}) re-entering queue after cancel.`);
        await addToQueue(bot, partnerId, partner.pendingLink);
      } else {
        await User.updateOne({ telegramId: partnerId }, { state: "awaiting_cut_link", isWaiting: false, queuedAt: null });
        console.log(`[PARTNER_NO_LINK] telegramId=${partnerId} has no pendingLink — set to awaiting_cut_link.`);
      }
    }
  });

  bot.action(/^approve_proof:(.+):(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const telegramId = ctx.from!.id;
    const matchId = ctx.match[1];
    const proofOwnerId = parseInt(ctx.match[2], 10);

    if (telegramId === proofOwnerId) {
      await ctx.reply("❌ Anda tidak boleh approve bukti anda sendiri.");
      return;
    }

    const match = await Match.findById(matchId);
    if (!match || match.status !== "active") { await ctx.reply("Match ini tidak lagi aktif."); return; }

    if (match.user1Id !== telegramId && match.user2Id !== telegramId) {
      await ctx.reply("Anda bukan sebahagian daripada match ini.");
      return;
    }

    const isProofOwnerUser1 = match.user1Id === proofOwnerId;

    if (isProofOwnerUser1) {
      if (match.user1ProofApprovedByPartner) { await ctx.reply("Bukti ini sudah diapprove sebelum ini."); return; }
      await Match.updateOne({ _id: matchId }, { user1ProofApprovedByPartner: true });
    } else {
      if (match.user2ProofApprovedByPartner) { await ctx.reply("Bukti ini sudah diapprove sebelum ini."); return; }
      await Match.updateOne({ _id: matchId }, { user2ProofApprovedByPartner: true });
    }

    console.log(`[PROOF_APPROVED] telegramId=${telegramId} approved proof of telegramId=${proofOwnerId} for matchId=${matchId}.`);
    await bot.telegram.sendMessage(proofOwnerId, "✅ Bukti anda telah diapprove oleh partner.");
    await checkAndCompleteMatch(bot, matchId);
  });

  bot.action(/^reject_proof:(.+):(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const telegramId = ctx.from!.id;
    const matchId = ctx.match[1];
    const proofOwnerId = parseInt(ctx.match[2], 10);

    if (telegramId === proofOwnerId) {
      await ctx.reply("❌ Anda tidak boleh reject bukti anda sendiri.");
      return;
    }

    const match = await Match.findById(matchId);
    if (!match || match.status !== "active") { await ctx.reply("Match ini tidak lagi aktif."); return; }

    if (match.user1Id !== telegramId && match.user2Id !== telegramId) {
      await ctx.reply("Anda bukan sebahagian daripada match ini.");
      return;
    }

    const isProofOwnerUser1 = match.user1Id === proofOwnerId;

    if (isProofOwnerUser1) {
      await Match.updateOne({ _id: matchId }, {
        user1ProofSubmitted: false,
        user1ProofMessageId: null,
        user1ProofSubmittedAt: null,
        user1Confirmed: false,
      });
    } else {
      await Match.updateOne({ _id: matchId }, {
        user2ProofSubmitted: false,
        user2ProofMessageId: null,
        user2ProofSubmittedAt: null,
        user2Confirmed: false,
      });
    }

    console.log(`[PROOF_REJECTED] telegramId=${telegramId} rejected proof of telegramId=${proofOwnerId} for matchId=${matchId}.`);
    await User.updateOne({ telegramId: proofOwnerId }, { state: "awaiting_proof" });
    await bot.telegram.sendMessage(proofOwnerId, "⚠️ Bukti anda ditolak oleh partner.\n\nSila hantar screenshot yang jelas.");
    await ctx.reply("✅ Anda telah menolak bukti partner. Mereka akan menghantar semula.");
  });

  bot.action("cut_more", async (ctx) => {
    await ctx.answerCbQuery();
    const telegramId = ctx.from!.id;

    const sus = await checkSuspension(telegramId);
    if (sus.suspended) { await ctx.reply(sus.message); return; }

    const user = await User.findOne({ telegramId });
    if (!user) return;

    if (user.cutBalance <= 0) {
      const me = await bot.telegram.getMe();
      const refLink = `https://t.me/${me.username}?start=ref_${user.referralCode}`;
      await ctx.reply(
        `😬 Cuts kau dah habis bro!\n\n🔥 *Nak lagi? Share bot ni & dapat +${REFERRAL_CUT_REWARD} cuts setiap orang yang join & selesaikan swap!*\n\n${refLink}`,
        { parse_mode: "Markdown" },
      );
      return;
    }

    await User.updateOne({ telegramId }, { state: "awaiting_cut_link" });
    await ctx.reply(
      `🔁 Jom cut lagi!\n\nCut baki: *${user.cutBalance}*\n\nHantar TikTok cut price link baru kau 👇`,
      { parse_mode: "Markdown" },
    );
  });

  bot.catch((err) => {
    logger.error({ err }, "Bot error");
  });

  return bot;
}
