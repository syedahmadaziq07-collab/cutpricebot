import mongoose from "mongoose";
import { Telegraf, Markup } from "telegraf";
import { message } from "telegraf/filters";
import { schedule } from "node-cron";
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
    { $set: { isWaiting: false, state: "awaiting_cut_link", queuedAt: null, activeMatchId: null } },
  );
  if (nolinkResult.modifiedCount > 0) {
    console.log(`[STARTUP_CLEANUP] Reset ${nolinkResult.modifiedCount} user(s) stuck inqueue with no pendingLink → awaiting_cut_link.`);
  }

  // Fix: users stuck inqueue for more than 30 minutes → reset
  const staleResult = await User.updateMany(
    { state: "inqueue", queuedAt: { $lte: thirtyMinutesAgo } },
    { $set: { state: "awaiting_cut_link", isWaiting: false, queuedAt: null, pendingLink: null, activeMatchId: null } },
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

  // Duplicate TikTok username cleanup — keep oldest owner, reset all newer duplicates
  const allRegistered = await User.find({ tiktokUsername: { $nin: ["__pending__", ""] } })
    .select("telegramId tiktokUsername createdAt")
    .sort({ createdAt: 1 });

  const seenUsernames = new Map<string, number>(); // normalized username → oldest owner's telegramId
  const duplicateIds: number[] = [];

  for (const u of allRegistered) {
    const normalized = normalizeTikTokUsername(u.tiktokUsername);
    if (seenUsernames.has(normalized)) {
      duplicateIds.push(u.telegramId);
    } else {
      seenUsernames.set(normalized, u.telegramId);
    }
  }

  if (duplicateIds.length > 0) {
    await User.updateMany(
      { telegramId: { $in: duplicateIds } },
      { $set: { tiktokUsername: "__pending__", state: "awaiting_tiktok_profile", tiktokUsernameLocked: false, tiktokLockedAt: null, usernameConflictReset: true } },
    );
    console.log(`[DUPLICATE_USERNAME_CLEANUP] Reset ${duplicateIds.length} duplicate TikTok username user(s): ${duplicateIds.join(", ")}`);
  }

  // Backfill lock for all existing registered users who don't have one yet
  const backfillResult = await User.updateMany(
    { tiktokUsername: { $nin: ["__pending__", ""] }, tiktokUsernameLocked: false },
    { $set: { tiktokUsernameLocked: true, tiktokLockedAt: new Date() } },
  );
  if (backfillResult.modifiedCount > 0) {
    console.log(`[STARTUP_CLEANUP] Backfilled tiktokUsernameLocked=true for ${backfillResult.modifiedCount} existing user(s).`);
  }

  // Log final queue state
  const remaining = await Queue.find().sort({ createdAt: 1 });
  console.log(`[STARTUP_CLEANUP] Queue after cleanup: ${remaining.length} user(s).`);
  for (const q of remaining) {
    console.log(`  → telegramId=${q.telegramId} pendingLink=${q.pendingLink ? "SET" : "NULL"} createdAt=${q.createdAt.toISOString()}`);
  }
}

const DAILY_CUT_FLOOR = 7;
const REFERRAL_CUT_REWARD = 3;
const MAX_CUT_BALANCE = 20;
const COOLDOWN_MS = 24 * 60 * 60 * 1000;

const matchTimers = new Map<string, ReturnType<typeof setTimeout>>();
const proofTimers = new Map<string, ReturnType<typeof setTimeout>>();

const NO_RESPONSE_TIMEOUT_MS = 4 * 60 * 1000;
const NO_RESPONSE_COOLDOWN_30M_MS = 30 * 60 * 1000;
const NO_RESPONSE_24H_MS = 24 * 60 * 60 * 1000;

function generateReferralCode(): string {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

async function extractTikTokUsername(input: string): Promise<string | null> {
  const trimmed = input.trim();

  // Handle bare @username — extract only valid username characters
  if (trimmed.startsWith("@")) {
    const m = trimmed.slice(1).match(/^([a-zA-Z0-9._]+)/);
    return m ? m[1] : null;
  }

  // Handle vt.tiktok.com short links — follow redirect to resolve full URL
  if (/https?:\/\/vt\.tiktok\.com\//i.test(trimmed)) {
    try {
      const res = await fetch(trimmed, { redirect: "follow" });
      const resolved = res.url;
      const vtMatch = resolved.match(/tiktok\.com\/@([a-zA-Z0-9._]+)/i);
      if (vtMatch && vtMatch[1]) return vtMatch[1];
    } catch {
      return null;
    }
    return null;
  }

  // Handle standard tiktok.com/@username URLs (query params are ignored by char class)
  const match = trimmed.match(
    /(?:https?:\/\/)?(?:www\.)?tiktok\.com\/@([a-zA-Z0-9._]+)/i,
  );
  if (match && match[1]) return match[1];

  return null;
}

function normalizeTikTokUsername(username: string): string {
  return username.toLowerCase().trim();
}

function isValidTikTokLink(url: string): boolean {
  return /(?:https?:\/\/)?(?:www\.)?(tiktok\.com|vm\.tiktok\.com|vt\.tiktok\.com)\//i.test(url);
}

async function checkAndApplyDailyReset(bot: Telegraf, telegramId: number): Promise<void> {
  const user = await User.findOne({ telegramId });
  if (!user || user.tiktokUsername === "__pending__") return;

  const now = new Date();
  const lastReset = user.lastDailyReset;

  // Fallback: if scheduler missed (server was down at midnight), reset this user now
  const fallbackDue = !lastReset || now.getTime() - lastReset.getTime() >= COOLDOWN_MS;
  if (fallbackDue) {
    const prevBalance = user.cutBalance;
    await User.updateOne({ telegramId }, { lastDailyReset: now, cutBalance: DAILY_CUT_FLOOR, lastResetNotifiedAt: now });
    console.log(`[DAILY_CUT_RESET] telegramId=${telegramId} (@${user.tiktokUsername}) fallback reset from ${prevBalance} → ${DAILY_CUT_FLOOR} cuts.`);
    try {
      await bot.telegram.sendMessage(
        telegramId,
        `🎁 Daily cuts refreshed!\n\nYou now have 7 fresh cuts ready for today 🤝✨`,
      );
    } catch { /* user may have blocked the bot */ }
    return;
  }

  // Scheduler ran — notify user if they haven't been notified since the last reset
  const lastNotified = user.lastResetNotifiedAt;
  if (lastReset && (!lastNotified || lastNotified < lastReset)) {
    await User.updateOne({ telegramId }, { lastResetNotifiedAt: now });
    try {
      await bot.telegram.sendMessage(
        telegramId,
        `🎁 Daily cuts refreshed!\n\nYou now have 7 fresh cuts ready for today 🤝✨`,
      );
    } catch { /* user may have blocked the bot */ }
  }
}

export function scheduleDailyMidnightReset(bot: Telegraf): void {
  // Runs at 00:00 every day, Asia/Kuala_Lumpur (MYT = UTC+8)
  schedule("0 0 * * *", async () => {
    const now = new Date();
    console.log(`[DAILY_MIDNIGHT_CUT_RESET_MYT] Midnight reset triggered at ${now.toISOString()} (00:00 MYT / Asia/Kuala_Lumpur).`);
    try {
      const result = await User.updateMany(
        { tiktokUsername: { $nin: ["__pending__", ""] }, isBanned: false },
        { $set: { cutBalance: DAILY_CUT_FLOOR, lastDailyReset: now } },
      );
      console.log(`[DAILY_CUT_RESET_SUCCESS] Reset cutBalance to ${DAILY_CUT_FLOOR} for ${result.modifiedCount} user(s).`);
    } catch (err) {
      console.error(`[DAILY_CUT_RESET_FAILED] Error during midnight reset: ${(err as Error).message}`);
    }
  }, { timezone: "Asia/Kuala_Lumpur" });

  console.log("[DAILY_MIDNIGHT_CUT_RESET_MYT] Scheduler registered: daily cut reset at 00:00 Asia/Kuala_Lumpur (MYT).");
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

  const filtered = await Promise.all(
    eligibleUsers.map(async (u) => {
      const recent = await hasRecentMatch(u.telegramId, newUserTelegramId);
      if (recent) {
        console.log(`[NOTIFICATION_SKIPPED_RECENT_PAIR] Skipping notification to telegramId=${u.telegramId} — recent match with telegramId=${newUserTelegramId}`);
        return null;
      }
      return u;
    })
  );
  const usersToNotify = filtered.filter(Boolean);

  if (eligibleUsers.length === 0) {
    console.log(`[MATCH_HISTORY_EMPTY] No eligible users found in DB for notification (all filtered out by state/ban/cooldown). newUserTikTok=@${newUserTikTok}`);
  }

  console.log(`[QUEUE] @${newUserTikTok} joined queue. Notifying ${usersToNotify.length}/${eligibleUsers.length} eligible user(s) (${eligibleUsers.length - usersToNotify.length} skipped — recent pair).`);
  if (usersToNotify.length === 0 && eligibleUsers.length > 0) {
    console.log(`[NOTIFICATION_SKIPPED_ALL] All ${eligibleUsers.length} eligible user(s) were skipped due to recent pair cooldown. newUserTikTok=@${newUserTikTok}`);
  }

  let sentCount = 0;
  for (const u of usersToNotify) {
    try {
      await bot.telegram.sendMessage(
        u.telegramId,
        `🔔 Someone new just dropped their cut link\\! 👀✨\n\nTikTok username:\n@${newUserTikTok}`,
        { parse_mode: "Markdown" },
      );
      await User.updateOne({ telegramId: u.telegramId }, { lastNotifiedAt: new Date() });
      sentCount++;
      console.log(`[NOTIFICATION_SENT] telegramId=${u.telegramId} (@${u.tiktokUsername}) notified about newUser=@${newUserTikTok}`);
    } catch (err) {
      console.error(`[NOTIFY] Failed to notify telegramId=${u.telegramId}: ${(err as Error).message}`);
    }
  }
  console.log(`[NOTIFY] Notifications sent: ${sentCount}/${usersToNotify.length}`);
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

async function issueNoResponseStrike(bot: Telegraf, inactivePartnerId: number): Promise<void> {
  const user = await User.findOne({ telegramId: inactivePartnerId });
  if (!user) return;

  const now = new Date();
  const windowStart = user.noResponseStrikeWindowStart;
  const windowExpired = !windowStart || (now.getTime() - windowStart.getTime() > NO_RESPONSE_24H_MS);
  const currentCount = windowExpired ? 0 : (user.noResponseStrikeCount ?? 0);
  const newCount = currentCount + 1;

  const baseUpdate: Record<string, unknown> = {
    noResponseStrikeCount: newCount,
    ...(windowExpired ? { noResponseStrikeWindowStart: now } : {}),
  };

  console.log(`[NO_RESPONSE_STRIKE] telegramId=${inactivePartnerId} — strike ${newCount}/3 (window ${windowExpired ? "reset" : "active"}).`);

  if (newCount === 1) {
    await User.updateOne({ telegramId: inactivePartnerId }, baseUpdate);
    try {
      await bot.telegram.sendMessage(
        inactivePartnerId,
        `⚠️ Hey! You didn't respond to your partner's proof in time.\n\nStrike: 1/3\n\nIf you fail to approve again, your account will be banned for 24 hours 🚫`,
      );
    } catch { /* user may have blocked bot */ }
  } else if (newCount === 2) {
    const cooldownUntil = new Date(now.getTime() + NO_RESPONSE_COOLDOWN_30M_MS);
    await User.updateOne({ telegramId: inactivePartnerId }, { ...baseUpdate, cancelCooldownUntil: cooldownUntil });
    console.log(`[NO_RESPONSE_COOLDOWN_30M] telegramId=${inactivePartnerId} placed on 30-min cooldown until ${cooldownUntil.toISOString()}.`);
    try {
      await bot.telegram.sendMessage(
        inactivePartnerId,
        `⚠️ Hey! You didn't respond to your partner's proof in time.\n\nStrike: 2/3\n\n⏳ You've been placed on a 30-minute cooldown.\n\nIf you fail to approve again, your account will be banned for 24 hours 🚫`,
      );
    } catch { /* user may have blocked bot */ }
  } else {
    const cooldownUntil = new Date(now.getTime() + NO_RESPONSE_24H_MS);
    await User.updateOne({ telegramId: inactivePartnerId }, { ...baseUpdate, cancelCooldownUntil: cooldownUntil });
    console.log(`[NO_RESPONSE_COOLDOWN_24H] telegramId=${inactivePartnerId} placed on 24h cooldown until ${cooldownUntil.toISOString()}.`);
    try {
      await bot.telegram.sendMessage(
        inactivePartnerId,
        `⚠️ Hey! You didn't respond to your partner's proof in time.\n\nStrike: ${newCount}/3\n\n🚫 You've been placed on a 24-hour cooldown for repeated non-responses.`,
      );
    } catch { /* user may have blocked bot */ }
  }
}

async function handleProofTimeout(
  bot: Telegraf,
  matchId: string,
  proofOwnerId: number,
  inactivePartnerId: number,
): Promise<void> {
  const match = await Match.findById(matchId);
  if (!match || match.status !== "active") {
    console.log(`[NO_RESPONSE_TIMEOUT] matchId=${matchId} proofOwnerId=${proofOwnerId} — match no longer active, skipping.`);
    return;
  }

  const isUser1 = match.user1Id === proofOwnerId;
  const proofApproved = isUser1 ? match.user1ProofApprovedByPartner : match.user2ProofApprovedByPartner;
  if (proofApproved) {
    console.log(`[NO_RESPONSE_TIMEOUT] matchId=${matchId} proofOwnerId=${proofOwnerId} — proof already approved, skipping.`);
    return;
  }

  console.log(`[NO_RESPONSE_TIMEOUT] matchId=${matchId} — inactivePartnerId=${inactivePartnerId} did not respond to proof from proofOwnerId=${proofOwnerId}. Cancelling match.`);

  await Match.updateOne({ _id: matchId }, { status: "cancelled" });

  const existingMatchTimer = matchTimers.get(matchId);
  if (existingMatchTimer) { clearTimeout(existingMatchTimer); matchTimers.delete(matchId); }

  proofTimers.delete(`proof:${matchId}:${proofOwnerId}`);

  // Reset proof owner → allow new link
  await Queue.deleteOne({ telegramId: proofOwnerId });
  await User.updateOne(
    { telegramId: proofOwnerId },
    { state: "awaiting_cut_link", isWaiting: false, queuedAt: null, activeMatchId: null },
  );
  console.log(`[NO_RESPONSE_TIMEOUT] telegramId=${proofOwnerId} reset to awaiting_cut_link.`);

  try {
    await bot.telegram.sendMessage(
      proofOwnerId,
      `⏰ Your partner went missing 😭\n\nNo response received within 4 minutes.\n\nYou can now submit a new link and find another swap partner 🔗✨`,
    );
  } catch { /* user may have blocked bot */ }

  // Reset inactive partner state then issue strike
  await Queue.deleteOne({ telegramId: inactivePartnerId });
  await User.updateOne(
    { telegramId: inactivePartnerId },
    { state: "awaiting_cut_link", isWaiting: false, queuedAt: null, pendingLink: null, activeMatchId: null },
  );
  await issueNoResponseStrike(bot, inactivePartnerId);
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
    // Clear any pending proof timer for this user in this match
    const proofTimerKey = `proof:${matchId}:${uid}`;
    const existingProofTimer = proofTimers.get(proofTimerKey);
    if (existingProofTimer) { clearTimeout(existingProofTimer); proofTimers.delete(proofTimerKey); }
    await Queue.deleteOne({ telegramId: uid });
    await User.updateOne(
      { telegramId: uid },
      { state: "awaiting_cut_link", pendingLink: null, isWaiting: false, queuedAt: null, activeMatchId: null },
    );
    console.log(`[QUEUE_REMOVE] telegramId=${uid} removed from queue (match expired).`);
    await bot.telegram.sendMessage(uid, expireMsg);
  }
  matchTimers.delete(matchId);
}

async function hasRecentMatch(userIdA: number, userIdB: number): Promise<boolean> {
  const since = new Date(Date.now() - COOLDOWN_MS);
  const pairKey = [userIdA, userIdB].sort((a, b) => a - b).join(":");
  const existing = await MatchHistory.findOne({ pairKey, matchedAt: { $gte: since } });
  if (existing) {
    const ageMin = Math.round((Date.now() - existing.matchedAt.getTime()) / (1000 * 60));
    const resetInMin = Math.round((COOLDOWN_MS - (Date.now() - existing.matchedAt.getTime())) / (1000 * 60));
    console.log(`[RECENT_PAIR_CHECK_RESULT] pairKey=${pairKey} — BLOCKED (matched ${ageMin} min ago, cooldown resets in ${resetInMin} min)`);
  } else {
    console.log(`[RECENT_PAIR_CHECK_RESULT] pairKey=${pairKey} — ALLOWED (no match history in last 24h)`);
  }
  return existing !== null;
}

// Atomically claim an eligible waiting partner and create a match.
// Returns true if a match was created, false if the current user should be queued.
async function tryMatchAtomic(bot: Telegraf, currentTelegramId: number, pendingLink: string): Promise<boolean> {
  // Block if current user already has an active match
  const existingMatch = await Match.findOne({
    $or: [{ user1Id: currentTelegramId }, { user2Id: currentTelegramId }],
    status: "active",
  });
  if (existingMatch) {
    console.log(`[DOUBLE_MATCH_BLOCKED] telegramId=${currentTelegramId} already has activeMatchId=${existingMatch._id} — skipping new match.`);
    return false;
  }

  const now = new Date();

  // Collect recently paired IDs for 24h cooldown exclusion
  const recentHistory = await MatchHistory.find({
    $or: [{ userIdA: currentTelegramId }, { userIdB: currentTelegramId }],
    matchedAt: { $gte: new Date(now.getTime() - COOLDOWN_MS) },
  }).select("userIdA userIdB");
  const excludeIds: number[] = [currentTelegramId];
  for (const h of recentHistory) {
    excludeIds.push(h.userIdA === currentTelegramId ? h.userIdB : h.userIdA);
  }

  // Pre-generate match ObjectId so it can be written atomically to the partner doc
  const matchObjectId = new mongoose.Types.ObjectId();
  const matchId = matchObjectId.toString();

  console.log(`[ATOMIC_PARTNER_CLAIM_ATTEMPT] telegramId=${currentTelegramId} seeking partner. Excluding ${excludeIds.length - 1} recently paired user(s).`);

  // Atomically claim the oldest eligible waiting user
  const partner = await User.findOneAndUpdate(
    {
      telegramId: { $nin: excludeIds },
      state: "inqueue",
      isWaiting: true,
      activeMatchId: null,
      isBanned: false,
      $or: [{ suspendedUntil: null }, { suspendedUntil: { $lte: now } }],
    },
    {
      $set: {
        state: "in_match",
        isWaiting: false,
        queuedAt: null,
        activeMatchId: matchId,
        lastMatchPartnerId: currentTelegramId,
      },
    },
    { sort: { queuedAt: 1 }, new: true },
  );

  if (!partner) {
    console.log(`[ATOMIC_PARTNER_CLAIM_FAILED] telegramId=${currentTelegramId} — no eligible partner found in queue.`);
    return false;
  }

  console.log(`[ATOMIC_PARTNER_CLAIM_SUCCESS] telegramId=${currentTelegramId} claimed partner telegramId=${partner.telegramId} (@${partner.tiktokUsername}) for matchId=${matchId}`);

  // Update current user to in_match
  await User.updateOne(
    { telegramId: currentTelegramId },
    {
      $set: {
        state: "in_match",
        isWaiting: false,
        queuedAt: null,
        activeMatchId: matchId,
        lastMatchPartnerId: partner.telegramId,
        pendingLink,
      },
    },
  );

  // Remove both from Queue (partner may have a Queue entry; current user has not been queued yet)
  await Queue.deleteMany({ telegramId: { $in: [currentTelegramId, partner.telegramId] } });

  const partnerPendingLink = partner.pendingLink ?? "";
  const expiresAt = new Date(now.getTime() + 4 * 60 * 1000);

  // Create Match (with pre-generated _id) and MatchHistory in parallel
  const pairKey = [currentTelegramId, partner.telegramId].sort((a, b) => a - b).join(":");
  const [matchDoc] = await Promise.all([
    Match.create({
      _id: matchObjectId,
      user1Id: currentTelegramId,
      user2Id: partner.telegramId,
      link1: pendingLink,
      link2: partnerPendingLink,
      expiresAt,
    }),
    MatchHistory.create({
      userIdA: currentTelegramId,
      userIdB: partner.telegramId,
      pairKey,
      matchedAt: now,
    }),
  ]);

  const currentUser = await User.findOne({ telegramId: currentTelegramId }).select("tiktokUsername");
  console.log(`[MATCH_CREATED] matchId=${matchId} | userA=${currentTelegramId} (@${currentUser?.tiktokUsername}) link="${pendingLink}" | userB=${partner.telegramId} (@${partner.tiktokUsername}) link="${partnerPendingLink}"`);
  console.log(`[MATCH_HISTORY_CREATED] pairKey=${pairKey} matchedAt=${now.toISOString()}`);

  const matchButtons = Markup.inlineKeyboard([
    Markup.button.callback("✅ Done Cut", "done_cut"),
    Markup.button.callback("❌ Cancel Match (24h cooldown)", "cancel_match"),
  ]);

  await Promise.all([
    bot.telegram.sendMessage(
      currentTelegramId,
      `🎉 Cut buddy found!\n\nYour partner:\n@${partner.tiktokUsername} 👀\n\nTheir cut link:\n${partnerPendingLink}\n\nGo show some love and finish the cut first 🤝✨`,
      { ...matchButtons },
    ),
    bot.telegram.sendMessage(
      partner.telegramId,
      `🎉 Cut buddy found!\n\nYour partner:\n@${currentUser?.tiktokUsername} 👀\n\nTheir cut link:\n${pendingLink}\n\nGo show some love and finish the cut first 🤝✨`,
      { ...matchButtons },
    ),
  ]);

  const timer = setTimeout(async () => {
    await handleMatchExpiry(bot, matchId, currentTelegramId, partner.telegramId);
  }, 4 * 60 * 1000);
  matchTimers.set(matchId, timer);

  void matchDoc; // silence unused-var warning
  return true;
}

// Add a user to the Queue collection (called only when tryMatchAtomic found no partner).
async function addToQueue(_bot: Telegraf, telegramId: number, pendingLink: string): Promise<void> {
  await Queue.deleteOne({ telegramId });
  const queuedAt = new Date();
  await Queue.create({ telegramId, pendingLink, createdAt: queuedAt });
  await User.updateOne({ telegramId }, { state: "inqueue", isWaiting: true, queuedAt, pendingLink, activeMatchId: null });

  const queueSize = await Queue.countDocuments();
  console.log(`[USER_QUEUED_AFTER_NO_PARTNER] telegramId=${telegramId} entered queue. Queue size: ${queueSize}.`);
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

  // If referrer is already at the max balance, mark reward granted but don't add cuts
  if (referrer.cutBalance >= MAX_CUT_BALANCE) {
    console.log(`[REFERRAL_CUT_LIMIT_REACHED] telegramId=${referral.referrerId} (@${referrer.tiktokUsername}) already at max balance (${referrer.cutBalance}/${MAX_CUT_BALANCE}). Reward skipped for referredId=${referredUserId}.`);
    await Referral.updateOne({ _id: referral._id }, { rewardGranted: true, rewardGrantedAt: now });
    return;
  }

  // Cap new balance at MAX_CUT_BALANCE
  const rawBalance = referrer.cutBalance + REFERRAL_CUT_REWARD;
  const newBalance = Math.min(rawBalance, MAX_CUT_BALANCE);
  const actualReward = newBalance - referrer.cutBalance;

  if (actualReward < REFERRAL_CUT_REWARD) {
    console.log(`[CUT_BALANCE_CAPPED] telegramId=${referral.referrerId} (@${referrer.tiktokUsername}) — referral reward capped from +${REFERRAL_CUT_REWARD} to +${actualReward} cuts to stay within ${MAX_CUT_BALANCE} max.`);
  }

  await Promise.all([
    User.updateOne({ telegramId: referral.referrerId }, { cutBalance: newBalance }),
    Referral.updateOne({ _id: referral._id }, { rewardGranted: true, rewardGrantedAt: now }),
  ]);

  console.log(`[REFERRAL_REWARD_GRANTED] telegramId=${referral.referrerId} (@${referrer.tiktokUsername}) received +${actualReward} cuts for referredId=${referredUserId}. New balance: ${newBalance}/${MAX_CUT_BALANCE}.`);

  try {
    await bot.telegram.sendMessage(
      referral.referrerId,
      `🎉 Your referral buddy just completed their first swap!\n\n+${actualReward} cuts added to your balance 🔥\n\nCut balance: *${newBalance}*`,
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
  // Clear any pending proof timers for both participants
  for (const uid of [match.user1Id, match.user2Id]) {
    const ptKey = `proof:${matchId}:${uid}`;
    const pt = proofTimers.get(ptKey);
    if (pt) { clearTimeout(pt); proofTimers.delete(ptKey); }
  }

  await Match.updateOne({ _id: matchId }, { status: "completed" });
  console.log(`[MATCH_COMPLETED] matchId=${matchId} — both proofs submitted and approved.`);

  for (const uid of [match.user1Id, match.user2Id]) {
    const user = await User.findOne({ telegramId: uid });
    if (!user) continue;

    const isFirstSwap = !user.firstSwapCompleted;

    // Step 1 — compute deduction
    const newBalance = Math.max(0, user.cutBalance - 1);
    console.log(`[CUT_DEDUCTED] telegramId=${uid} (@${user.tiktokUsername}) cutBalance: ${user.cutBalance} → ${newBalance} for matchId=${matchId}.`);

    // Step 2 — persist to DB first, confirm success before sending any message
    let saveOk = false;
    try {
      const saveResult = await User.updateOne(
        { telegramId: uid },
        {
          state: "awaiting_cut_link",
          cutBalance: newBalance,
          pendingLink: null,
          queuedAt: null,
          isWaiting: false,
          firstSwapCompleted: true,
          activeMatchId: null,
        },
      );
      if (saveResult.modifiedCount > 0) {
        console.log(`[CUT_SAVE_SUCCESS] telegramId=${uid} (@${user.tiktokUsername}) cutBalance saved as ${newBalance} for matchId=${matchId}.`);
        saveOk = true;
      } else {
        console.warn(`[CUT_SAVE_FAILED] telegramId=${uid} (@${user.tiktokUsername}) updateOne matched no document for matchId=${matchId}. Balance NOT deducted.`);
      }
    } catch (err) {
      console.error(`[CUT_SAVE_FAILED] telegramId=${uid} (@${user.tiktokUsername}) DB error for matchId=${matchId}: ${(err as Error).message}`);
    }

    // Step 3 — send message only after DB write is confirmed
    if (saveOk) {
      if (newBalance === 0) {
        const me = await bot.telegram.getMe();
        const refLink = `https://t.me/${me.username}?start=ref_${user.referralCode}`;
        await bot.telegram.sendMessage(
          uid,
          `🎉 Swap completed successfully!\n\nThanks for using CutPricebot 🤝✨\n\nRemaining cuts: *0* 💖\n\nYou've used all your cuts!\n\n🔥 Refer a friend and get *+${REFERRAL_CUT_REWARD} cuts* when they complete their first swap!\n\n${refLink}`,
          { parse_mode: "Markdown" },
        );
      } else {
        await bot.telegram.sendMessage(
          uid,
          `🎉 Swap completed successfully!\n\nThanks for using CutPricebot 🤝✨\n\nRemaining cuts: *${newBalance}* 💖`,
          {
            parse_mode: "Markdown",
            ...Markup.inlineKeyboard([Markup.button.callback("🔁 Cut More!", "cut_more")]),
          },
        );
      }
    }

    if (isFirstSwap) {
      await grantReferralReward(bot, uid);
    }
  }
}

function getAdminIds(): number[] {
  return (process.env["ADMIN_IDS"] ?? "")
    .split(",")
    .map(s => parseInt(s.trim(), 10))
    .filter(n => !isNaN(n));
}

const WEEKLY_REJECT_THRESHOLD = 5;
const AUTO_BAN_REJECT_THRESHOLD = 10;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

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

      const firstName = ctx.from.first_name ?? "there";
      const tgUsername = existingUser.telegramUsername || ctx.from.username || "unknown";

      const now = new Date();
      const updatedTime = now.toUTCString().replace("GMT", "UTC");

      const registeredUserCount = await User.countDocuments();
      console.log(`[REGISTERED_USER_COUNT_FETCHED] count=${registeredUserCount}`);
      const displayCount = registeredUserCount + 9;
      console.log(`[TOTAL_ACTIVE_RENDERED] displayCount=${displayCount} (registeredUsers=${registeredUserCount} + offset=9)`);

      const me = await bot.telegram.getMe();
      const refLink = `https://t.me/${me.username}?start=ref_${existingUser.referralCode}`;

      await ctx.reply(
        `Welcome to CutPricebot!!!\nUpdated: ${updatedTime}\n\n` +
        `👋 Hi ${firstName}!\n\n` +
        `👤 Account\n` +
        `• ID: ${telegramId}\n` +
        `• Username: @${tgUsername}\n\n` +
        `📊 Store Stats\n` +
        `• Total Active Now: ${displayCount}\n\n` +
        `━━━━━━━━━━━━━━━\n\n` +
        `Ayy @${existingUser.tiktokUsername} is back again 😆\n\n` +
        `🎟 Remaining cuts: ${existingUser.cutBalance}\n\n` +
        `🎁 Invite friends & earn extra cuts!\n\n` +
        `🔗 Your Referral Link:\n` +
        `\`${refLink}\`\n\n` +
        `✨ Earn +3 cuts for every valid referral\n` +
        `📌 Max balance: 20 cuts\n\n` +
        `━━━━━━━━━━━━━━━\n\n` +
        `Drop your TikTok cut price link below to start swapping 🔗✨`,
        { parse_mode: "Markdown" },
      );
      // Clear any stale Queue entry before resetting state
      await Queue.deleteOne({ telegramId });
      await User.updateOne({ telegramId }, { state: "awaiting_cut_link" });
      return;
    }

    // Conflict-reset users: their username was removed due to a duplicate — prompt them to register a new one
    if (existingUser && existingUser.tiktokUsername === "__pending__" && existingUser.usernameConflictReset) {
      console.log(`[USERNAME_RESET_REQUIRED] telegramId=${telegramId} — prompted to re-register after conflict reset.`);
      await User.updateOne({ telegramId }, { usernameConflictReset: false, state: "awaiting_tiktok_profile" });
      await ctx.reply(
        "⚠️ Your previous TikTok username was removed because it conflicted with another account.\n\nPlease register a new TikTok username to continue ✨\n\n_(Send your TikTok profile link, e.g. https://www.tiktok.com/@username)_",
        { parse_mode: "Markdown" },
      );
      return;
    }

    let referralCode: string | null = null;
    if (payload && payload.startsWith("ref_")) referralCode = payload.slice(4);

    // Detect whether this is a brand-new user (no prior document at all)
    const isNewUser = existingUser === null;

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

    // Admin notification — only for brand-new users, never for returning __pending__ users
    if (isNewUser) {
      const joinedAt = new Date().toLocaleString("en-MY", {
        timeZone: "Asia/Kuala_Lumpur",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      });
      const displayName = ctx.from.first_name ?? "Unknown";
      const displayUsername = ctx.from.username ? `@${ctx.from.username}` : "No username";
      const totalUsers = await User.countDocuments();

      const adminMsg =
        `👤 NEW USER JOINED!\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `• User Number: #${totalUsers}\n` +
        `• Name: ${displayName}\n` +
        `• Username: ${displayUsername}\n` +
        `• ID: ${telegramId}\n` +
        `• Time: ${joinedAt} MYT\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `🆕 A new user just joined CutPricebot ✨`;

      for (const adminId of getAdminIds()) {
        try {
          await bot.telegram.sendMessage(adminId, adminMsg);
          console.log(`[NEW_USER_ADMIN_NOTIFIED] telegramId=${telegramId} (@${ctx.from.username ?? "no_username"}) — notified adminId=${adminId}. Total users: ${totalUsers}.`);
        } catch (err) {
          console.error(`[NEW_USER_ADMIN_NOTIFY_FAILED] telegramId=${telegramId} — failed to notify adminId=${adminId}: ${(err as Error).message}`);
        }
      }
    }

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
      `🔥 Your referral link:\n\n${refLink}\n\nShare it — every friend who joins and completes their first swap = *+${REFERRAL_CUT_REWARD} cuts* for you! 🎁\n\n_(Max balance: ${MAX_CUT_BALANCE} cuts per account)_`,
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

  bot.command("clear_match_history", async (ctx) => {
    const adminIds = (process.env["ADMIN_IDS"] ?? "")
      .split(",")
      .map(s => parseInt(s.trim(), 10))
      .filter(n => !isNaN(n));
    if (!adminIds.includes(ctx.from.id)) {
      await ctx.reply("🚫 Unauthorized.");
      return;
    }

    const args = ctx.message.text.split(/\s+/).slice(1);

    if (args.length === 0) {
      const since = new Date(Date.now() - COOLDOWN_MS);
      const result = await MatchHistory.deleteMany({ matchedAt: { $gte: since } });
      // Also reset stale per-user fields that could block notifications
      const userResetResult = await User.updateMany(
        {},
        { $set: { lastMatchPartnerId: null, lastNotifiedAt: null } },
      );
      console.log(`[MATCH_HISTORY_CLEARED] Wiped ${result.deletedCount} MatchHistory record(s) from last 24h. Reset lastMatchPartnerId+lastNotifiedAt on ${userResetResult.modifiedCount} user(s). Admin telegramId=${ctx.from.id}`);
      await ctx.reply(
        `🗑️ Cleared *${result.deletedCount}* match history record(s) from the last 24 hours.\n` +
        `🔄 Reset notification cooldown & partner cache on *${userResetResult.modifiedCount}* user(s).\n\n` +
        `✅ All users can now receive notifications immediately.`,
        { parse_mode: "Markdown" },
      );
      return;
    }

    if (args.length === 2) {
      const usernameA = args[0]!.replace(/^@/, "");
      const usernameB = args[1]!.replace(/^@/, "");
      const [uA, uB] = await Promise.all([
        User.findOne({ tiktokUsername: usernameA }).select("telegramId"),
        User.findOne({ tiktokUsername: usernameB }).select("telegramId"),
      ]);
      if (!uA) { await ctx.reply(`❌ User @${usernameA} not found.`); return; }
      if (!uB) { await ctx.reply(`❌ User @${usernameB} not found.`); return; }
      const pairKey = [uA.telegramId, uB.telegramId].sort((a, b) => a - b).join(":");
      const result = await MatchHistory.deleteMany({ pairKey });
      // Reset lastMatchPartnerId and lastNotifiedAt for both users in this pair
      await Promise.all([
        User.updateOne({ telegramId: uA.telegramId }, { $set: { lastMatchPartnerId: null, lastNotifiedAt: null } }),
        User.updateOne({ telegramId: uB.telegramId }, { $set: { lastMatchPartnerId: null, lastNotifiedAt: null } }),
      ]);
      console.log(`[MATCH_HISTORY_CLEARED] Wiped ${result.deletedCount} record(s) for pairKey=${pairKey} (@${usernameA} ↔️ @${usernameB}). Reset lastMatchPartnerId+lastNotifiedAt for both users. Admin telegramId=${ctx.from.id}`);
      await ctx.reply(
        `🗑️ Cleared *${result.deletedCount}* history record(s) for @${usernameA} ↔️ @${usernameB}\n` +
        `\`pairKey: ${pairKey}\`\n` +
        `🔄 Reset notification cooldown & partner cache for both users.`,
        { parse_mode: "Markdown" },
      );
      return;
    }

    await ctx.reply(
      "ℹ️ Usage:\n" +
      "`/clear_match_history` — clear all last-24h history\n" +
      "`/clear_match_history @userA @userB` — clear history for a specific pair",
      { parse_mode: "Markdown" },
    );
  });

  bot.command("debug_notifications", async (ctx) => {
    const adminIds = (process.env["ADMIN_IDS"] ?? "")
      .split(",")
      .map(s => parseInt(s.trim(), 10))
      .filter(n => !isNaN(n));
    if (!adminIds.includes(ctx.from.id)) {
      await ctx.reply("🚫 Unauthorized.");
      return;
    }

    const args = ctx.message.text.split(/\s+/).slice(1);
    const targetTikTok = args[0]?.replace(/^@/, "") ?? null;

    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
    const now = new Date();

    // Find a reference user (the "new user" who would be joining the queue)
    let newUserTelegramId: number | null = null;
    let newUserTikTok = targetTikTok ?? "(unknown)";
    if (targetTikTok) {
      const targetUser = await User.findOne({ tiktokUsername: targetTikTok }).select("telegramId tiktokUsername");
      if (!targetUser) {
        await ctx.reply(`❌ User @${targetTikTok} not found.`);
        return;
      }
      newUserTelegramId = targetUser.telegramId;
    }

    // Pull all candidate users (same filter as notifyQueueUsers)
    const candidateFilter: Record<string, unknown> = {
      tiktokUsername: { $nin: ["__pending__", ""] },
      isBanned: false,
      state: { $in: ["awaiting_cut_link", "idle"] },
      $and: [
        { $or: [{ suspendedUntil: null }, { suspendedUntil: { $lte: now } }] },
        { $or: [{ cancelCooldownUntil: null }, { cancelCooldownUntil: { $lte: now } }] },
        { $or: [{ lastNotifiedAt: null }, { lastNotifiedAt: { $lte: tenMinutesAgo } }] },
      ],
    };
    if (newUserTelegramId !== null) {
      candidateFilter["telegramId"] = { $ne: newUserTelegramId };
    }
    const candidates = await User.find(candidateFilter);

    const willReceive: string[] = [];
    const willSkip: string[] = [];

    for (const u of candidates) {
      if (newUserTelegramId !== null) {
        const since = new Date(Date.now() - COOLDOWN_MS);
        const pairKey = [u.telegramId, newUserTelegramId].sort((a, b) => a - b).join(":");
        const existing = await MatchHistory.findOne({ pairKey, matchedAt: { $gte: since } });
        if (existing) {
          const ageMin = Math.round((Date.now() - existing.matchedAt.getTime()) / (1000 * 60));
          const resetInMin = Math.round((COOLDOWN_MS - (Date.now() - existing.matchedAt.getTime())) / (1000 * 60));
          willSkip.push(`@${u.tiktokUsername} (tgId=${u.telegramId}) — RECENT_PAIR, matched ${ageMin} min ago, resets in ${resetInMin} min`);
          continue;
        }
      }
      const notifAge = u.lastNotifiedAt ? Math.round((Date.now() - u.lastNotifiedAt.getTime()) / (1000 * 60)) : null;
      willReceive.push(`@${u.tiktokUsername} (tgId=${u.telegramId}) state=${u.state}${notifAge !== null ? ` lastNotified=${notifAge} min ago` : " lastNotified=never"}`);
    }

    const lines: string[] = [];
    lines.push(`🔍 *Notification Debug*`);
    lines.push(`Target (new user): @${newUserTikTok}${newUserTelegramId ? ` (tgId=${newUserTelegramId})` : " (no target specified — showing all candidates)"}`);
    lines.push(`\nCandidates found: ${candidates.length}`);

    if (willReceive.length > 0) {
      lines.push(`\n✅ *Will RECEIVE (${willReceive.length}):*`);
      willReceive.forEach(r => lines.push(`  • ${r}`));
    } else {
      lines.push(`\n✅ Will RECEIVE: none`);
    }

    if (willSkip.length > 0) {
      lines.push(`\n⛔ *Will SKIP (${willSkip.length}):*`);
      willSkip.forEach(s => lines.push(`  • ${s}`));
    } else {
      lines.push(`\n⛔ Will SKIP: none`);
    }

    console.log(`[DEBUG_NOTIFICATIONS] Admin telegramId=${ctx.from.id} ran debug. Target=@${newUserTikTok} candidates=${candidates.length} willReceive=${willReceive.length} willSkip=${willSkip.length}`);
    await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
  });

  bot.command("reset_user", async (ctx) => {
    const adminIds = (process.env["ADMIN_IDS"] ?? "")
      .split(",")
      .map(s => parseInt(s.trim(), 10))
      .filter(n => !isNaN(n));
    if (!adminIds.includes(ctx.from.id)) {
      await ctx.reply("🚫 Unauthorized.");
      return;
    }

    const args = ctx.message.text.split(/\s+/).slice(1);
    if (args.length === 0) {
      await ctx.reply(
        "ℹ️ *Usage:*\n" +
        "`/reset_user @username` — reset state & queue\n" +
        "`/reset_user @username --cooldown` — also clear all cooldowns\n" +
        "`/reset_user @username --strikes` — also clear strikes & unban\n" +
        "`/reset_user @username --all` — full reset (state + cooldowns + strikes)",
        { parse_mode: "Markdown" },
      );
      return;
    }

    const usernameArg = args[0]!.replace(/^@/, "");
    const flags = new Set(args.slice(1));
    const clearCooldowns = flags.has("--cooldown") || flags.has("--all");
    const clearStrikes   = flags.has("--strikes")  || flags.has("--all");

    const user = await User.findOne({ tiktokUsername: usernameArg });
    if (!user) {
      await ctx.reply(`❌ User @${usernameArg} not found.`);
      return;
    }

    const { telegramId } = user;

    // Always: remove from queue + reset core state
    await Queue.deleteOne({ telegramId });

    // Cancel any active match for this user
    const activeMatch = await Match.findOne({
      $or: [{ user1Id: telegramId }, { user2Id: telegramId }],
      status: "active",
    });
    if (activeMatch) {
      await Match.updateOne({ _id: activeMatch._id }, { status: "cancelled" });
      const timerId = activeMatch._id.toString();
      const existingTimer = matchTimers.get(timerId);
      if (existingTimer) { clearTimeout(existingTimer); matchTimers.delete(timerId); }
      // Notify partner if present
      const partnerId = activeMatch.user1Id === telegramId ? activeMatch.user2Id : activeMatch.user1Id;
      const partner = await User.findOne({ telegramId: partnerId });
      try {
        await bot.telegram.sendMessage(
          partnerId,
          "⚠️ *Partner anda telah di-reset oleh admin.*\n\nSistem sedang mencari partner baru untuk anda 🤝",
          { parse_mode: "Markdown" },
        );
      } catch { /* partner may have blocked bot */ }
      if (partner?.pendingLink) {
        await addToQueue(bot, partnerId, partner.pendingLink);
      } else {
        await User.updateOne({ telegramId: partnerId }, { state: "awaiting_cut_link", isWaiting: false, queuedAt: null, activeMatchId: null });
      }
    }

    const update: Record<string, unknown> = {
      state: "awaiting_cut_link",
      isWaiting: false,
      queuedAt: null,
      pendingLink: null,
      activeMatchId: null,
    };

    if (clearCooldowns) {
      update["cancelCooldownUntil"] = null;
      update["suspendedUntil"] = null;
    }
    if (clearStrikes) {
      update["strikes"] = 0;
      update["isBanned"] = false;
    }

    await User.updateOne({ telegramId }, update);

    const appliedFlags: string[] = ["state reset", "queue cleared"];
    if (clearCooldowns) appliedFlags.push("cooldowns cleared");
    if (clearStrikes)   appliedFlags.push("strikes cleared", "ban lifted");
    if (activeMatch)    appliedFlags.push("active match cancelled");

    console.log(`[ADMIN] reset_user: telegramId=${telegramId} (@${usernameArg}) reset by admin telegramId=${ctx.from.id}. Applied: ${appliedFlags.join(", ")}.`);

    const lines = [
      `✅ *@${usernameArg} has been reset.*\n`,
      `• State → \`awaiting_cut_link\``,
      `• Queue entry removed`,
      clearCooldowns ? `• Cooldowns cleared (cancelCooldownUntil + suspendedUntil)` : null,
      clearStrikes   ? `• Strikes reset to 0, ban lifted` : null,
      activeMatch    ? `• Active match cancelled, partner notified` : null,
    ].filter(Boolean).join("\n");

    await ctx.reply(lines, { parse_mode: "Markdown" });

    // Notify the reset user
    try {
      await bot.telegram.sendMessage(
        telegramId,
        "🔄 Akaun anda telah di-reset oleh admin.\n\nAnda boleh menggunakan sistem semula sekarang. Hantar TikTok cut price link kau 👇",
      );
    } catch { /* user may have blocked bot */ }
  });

  bot.command("rejectlist", async (ctx) => {
    if (!getAdminIds().includes(ctx.from.id)) { await ctx.reply("🚫 Unauthorized."); return; }

    const flagged = await User.find({ totalRejectCount: { $gt: 0 } })
      .sort({ totalRejectCount: -1 })
      .limit(15)
      .select("tiktokUsername telegramId totalRejectCount cooldownCount lastRejectAt isFlagged isBanned");

    if (flagged.length === 0) {
      await ctx.reply("✅ No users with rejected proofs.");
      return;
    }

    const lines = flagged.map((u, i) => {
      const age = u.lastRejectAt
        ? `${Math.round((Date.now() - u.lastRejectAt.getTime()) / (1000 * 60 * 60))}h ago`
        : "never";
      const badges = [
        u.isBanned ? "🚫 BANNED" : null,
        u.isFlagged ? "🚨 FLAGGED" : null,
      ].filter(Boolean).join(" ");
      return (
        `${i + 1}. @${u.tiktokUsername} (${u.telegramId})${badges ? `  ${badges}` : ""}\n` +
        `   Rejects: *${u.totalRejectCount}* | Cooldowns: ${u.cooldownCount}\n` +
        `   Last reject: ${age}`
      );
    });

    await ctx.reply(`🚨 *Frequently Rejected Users:*\n\n` + lines.join("\n\n"), { parse_mode: "Markdown" });
  });

  bot.command("ban", async (ctx) => {
    if (!getAdminIds().includes(ctx.from.id)) { await ctx.reply("🚫 Unauthorized."); return; }

    const args = ctx.message.text.split(/\s+/).slice(1);
    if (args.length === 0) {
      await ctx.reply("ℹ️ Usage: `/ban USER_ID`", { parse_mode: "Markdown" });
      return;
    }

    const targetId = parseInt(args[0]!, 10);
    if (isNaN(targetId)) { await ctx.reply("❌ Invalid USER_ID."); return; }

    const user = await User.findOne({ telegramId: targetId });
    if (!user) { await ctx.reply(`❌ User ${targetId} not found.`); return; }
    if (user.isBanned) { await ctx.reply(`⚠️ @${user.tiktokUsername} is already banned.`); return; }

    await User.updateOne({ telegramId: targetId }, { isBanned: true, state: "idle", isWaiting: false, queuedAt: null, pendingLink: null });
    await Queue.deleteOne({ telegramId: targetId });

    const activeMatch = await Match.findOne({ $or: [{ user1Id: targetId }, { user2Id: targetId }], status: "active" });
    if (activeMatch) {
      await Match.updateOne({ _id: activeMatch._id }, { status: "cancelled" });
      const timerId = activeMatch._id.toString();
      const t = matchTimers.get(timerId);
      if (t) { clearTimeout(t); matchTimers.delete(timerId); }
      const partnerId = activeMatch.user1Id === targetId ? activeMatch.user2Id : activeMatch.user1Id;
      const partner = await User.findOne({ telegramId: partnerId });
      try { await bot.telegram.sendMessage(partnerId, "⚠️ *Partner anda telah di-ban oleh admin.*\nSistem sedang mencari partner baru untuk anda 🤝", { parse_mode: "Markdown" }); } catch {}
      if (partner?.pendingLink) { await addToQueue(bot, partnerId, partner.pendingLink); }
      else { await User.updateOne({ telegramId: partnerId }, { state: "awaiting_cut_link", isWaiting: false, queuedAt: null }); }
    }

    console.log(`[ADMIN_BAN] telegramId=${targetId} (@${user.tiktokUsername}) banned by admin telegramId=${ctx.from.id}.`);
    try { await bot.telegram.sendMessage(targetId, "🚫 Akaun anda telah di-ban secara kekal oleh admin."); } catch {}
    await ctx.reply(`🚫 *@${user.tiktokUsername}* (${targetId}) has been permanently banned.`, { parse_mode: "Markdown" });
  });

  bot.command("unban", async (ctx) => {
    if (!getAdminIds().includes(ctx.from.id)) { await ctx.reply("🚫 Unauthorized."); return; }

    const args = ctx.message.text.split(/\s+/).slice(1);
    if (args.length === 0) {
      await ctx.reply("ℹ️ Usage: `/unban USER_ID`", { parse_mode: "Markdown" });
      return;
    }

    const targetId = parseInt(args[0]!, 10);
    if (isNaN(targetId)) { await ctx.reply("❌ Invalid USER_ID."); return; }

    const user = await User.findOne({ telegramId: targetId });
    if (!user) { await ctx.reply(`❌ User ${targetId} not found.`); return; }
    if (!user.isBanned) { await ctx.reply(`⚠️ @${user.tiktokUsername} is not banned.`); return; }

    await User.updateOne({ telegramId: targetId }, { isBanned: false, isFlagged: false, state: "awaiting_cut_link" });

    console.log(`[ADMIN_UNBAN] telegramId=${targetId} (@${user.tiktokUsername}) unbanned by admin telegramId=${ctx.from.id}.`);
    try { await bot.telegram.sendMessage(targetId, "✅ Akaun anda telah di-unban oleh admin. Anda boleh menggunakan sistem semula sekarang."); } catch {}
    await ctx.reply(`✅ *@${user.tiktokUsername}* (${targetId}) has been unbanned.`, { parse_mode: "Markdown" });
  });

  bot.command("userstats", async (ctx) => {
    if (!getAdminIds().includes(ctx.from.id)) { await ctx.reply("🚫 Unauthorized."); return; }

    const args = ctx.message.text.split(/\s+/).slice(1);
    if (args.length === 0) {
      await ctx.reply("ℹ️ Usage: `/userstats USER_ID`", { parse_mode: "Markdown" });
      return;
    }

    const targetId = parseInt(args[0]!, 10);
    if (isNaN(targetId)) { await ctx.reply("❌ Invalid USER_ID."); return; }

    const u = await User.findOne({ telegramId: targetId });
    if (!u) { await ctx.reply(`❌ User ${targetId} not found.`); return; }

    const lastRejectStr = u.lastRejectAt
      ? `${Math.round((Date.now() - u.lastRejectAt.getTime()) / (1000 * 60))} min ago`
      : "never";
    const cooldownStr = u.cancelCooldownUntil && u.cancelCooldownUntil > new Date()
      ? `${Math.round((u.cancelCooldownUntil.getTime() - Date.now()) / (1000 * 60))} min left`
      : "none";
    const suspendStr = u.suspendedUntil && u.suspendedUntil > new Date()
      ? `${Math.round((u.suspendedUntil.getTime() - Date.now()) / (1000 * 60))} min left`
      : "none";
    const badges = [
      u.isBanned ? "🚫 BANNED" : null,
      u.isFlagged ? "🚨 FLAGGED" : null,
    ].filter(Boolean).join(" ") || "none";

    const report = [
      `👤 *User Stats: @${u.tiktokUsername}*`,
      `TelegramID: \`${u.telegramId}\``,
      `TG username: @${u.telegramUsername || "—"}`,
      ``,
      `State: \`${u.state}\``,
      `Cut balance: ${u.cutBalance}`,
      `Strikes: ${u.strikes}/3`,
      `Flags: ${badges}`,
      ``,
      `Total rejects: ${u.totalRejectCount}`,
      `Total approved: ${u.totalApprovedCount}`,
      `Cooldown count: ${u.cooldownCount}`,
      `Weekly rejects: ${u.weeklyRejectWindowCount}`,
      `Last reject: ${lastRejectStr}`,
      ``,
      `Cancel cooldown: ${cooldownStr}`,
      `Suspension: ${suspendStr}`,
      `Joined: ${u.createdAt.toISOString().slice(0, 10)}`,
    ].join("\n");

    await ctx.reply(report, { parse_mode: "Markdown" });
  });

  bot.command("broadcast", async (ctx) => {
    if (!getAdminIds().includes(ctx.from.id)) { await ctx.reply("🚫 Unauthorized."); return; }

    const text = ctx.message.text.replace(/^\/broadcast\s*/i, "").trim();
    if (!text) {
      await ctx.reply("ℹ️ Usage: `/broadcast <your message>`\n\nThe message will be sent to all registered users.", { parse_mode: "Markdown" });
      return;
    }

    const users = await User.find({ tiktokUsername: { $ne: "__pending__" }, isBanned: false }).select("telegramId");
    if (users.length === 0) {
      await ctx.reply("⚠️ No registered users found.");
      return;
    }

    const statusMsg = await ctx.reply(`📡 Sending to ${users.length} user(s)…`);
    let sent = 0;
    let failed = 0;

    for (const u of users) {
      try {
        await bot.telegram.sendMessage(u.telegramId, text);
        sent++;
      } catch {
        failed++;
      }
      // Small delay to avoid Telegram rate limits
      await new Promise(resolve => setTimeout(resolve, 50));
    }

    await bot.telegram.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      undefined,
      `✅ Broadcast complete!\n\n📨 Sent: ${sent}\n❌ Failed: ${failed}\n👥 Total: ${users.length}`,
    );
    console.log(`[BROADCAST] adminId=${ctx.from.id} — sent=${sent} failed=${failed} total=${users.length}`);
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
      await ctx.reply("Oopsie 😭\n\nThere's no active cut match to verify right now.");
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
    await ctx.reply("✅ Proof received successfully!\n\nYour cut buddy is checking it now 👀✨");

    const approveButtons = Markup.inlineKeyboard([
      Markup.button.callback("✅ Approve Proof", `approve_proof:${matchId}:${telegramId}`),
      Markup.button.callback("❌ Reject Proof", `reject_proof:${matchId}:${telegramId}`),
    ]);

    await bot.telegram.sendPhoto(partnerId, proofFileId, {
      caption: `📸 Your cut buddy just sent their proof!\n\nTake a quick look below and make sure everything's valid 👀✨`,
      parse_mode: "Markdown",
      ...approveButtons,
    });
    console.log(`[PROOF_SENT_TO_PARTNER] telegramId=${telegramId} proof forwarded to partnerId=${partnerId} for matchId=${matchId}.`);

    // Start 4-minute no-response timeout — if partner doesn't approve/reject, punish them
    const proofTimerKey = `proof:${matchId}:${telegramId}`;
    if (proofTimers.has(proofTimerKey)) clearTimeout(proofTimers.get(proofTimerKey)!);
    const proofTimer = setTimeout(async () => {
      proofTimers.delete(proofTimerKey);
      await handleProofTimeout(bot, matchId, telegramId, partnerId);
    }, NO_RESPONSE_TIMEOUT_MS);
    proofTimers.set(proofTimerKey, proofTimer);
    console.log(`[NO_RESPONSE_TIMEOUT_STARTED] matchId=${matchId} proofOwnerId=${telegramId} inactivePartnerId=${partnerId} — 4-min timer started.`);
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
        const rawUsername = await extractTikTokUsername(text);
        if (!rawUsername) {
          console.warn(`[INVALID_TIKTOK_PROFILE_LINK] telegramId=${telegramId} input="${text.slice(0, 100)}"`);
          await ctx.reply("❌ Invalid TikTok profile link.\n\nPlease send a valid TikTok username or profile link 👀\n\nExample: https://www.tiktok.com/@username");
          return;
        }
        console.log(`[TIKTOK_USERNAME_PARSED] telegramId=${telegramId} raw="${text.slice(0, 100)}" → username="${rawUsername}"`);
        const username = normalizeTikTokUsername(rawUsername);

        // Check for duplicate — reject if taken by another account
        const existingOwner = await User.findOne({
          tiktokUsername: { $regex: new RegExp(`^${username.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i") },
          telegramId: { $ne: telegramId },
        });
        if (existingOwner) {
          console.log(`[TIKTOK_USERNAME_DUPLICATE_BLOCKED] telegramId=${telegramId} tried to register "@${username}" — already owned by telegramId=${existingOwner.telegramId}.`);
          await ctx.reply("Sorry 😵\n\nThis TikTok username is already taken by another user.");
          return;
        }

        const referralDoc = await User.findOne({ telegramId });
        const pendingRef = (referralDoc as any)?.pendingReferralCode ?? null;

        await User.updateOne(
          { telegramId },
          { tiktokUsername: username, tiktokProfileLink: text, telegramUsername: ctx.from.username ?? "", state: "awaiting_cut_link", tiktokUsernameLocked: true, tiktokLockedAt: new Date() },
        );
        console.log(`[TIKTOK_USERNAME_LOCKED] telegramId=${telegramId} permanently locked to "@${username}".`);

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

      // If this user already has a locked username, block any change attempt
      if (user.tiktokUsernameLocked && user.tiktokUsername && user.tiktokUsername !== "__pending__") {
        const rawAttempt = await extractTikTokUsername(text);
        const attempt = rawAttempt ? normalizeTikTokUsername(rawAttempt) : null;
        if (attempt && attempt === normalizeTikTokUsername(user.tiktokUsername)) {
          // Same username — just restore state
          await User.updateOne({ telegramId }, { state: "awaiting_cut_link" });
          await ctx.reply(`✅ TikTok username @${user.tiktokUsername} confirmed!\n\nNow send your cut price link to start swapping 🔗✨`);
        } else {
          console.log(`[TIKTOK_USERNAME_CHANGE_BLOCKED] telegramId=${telegramId} tried to change from "@${user.tiktokUsername}" to "${attempt ?? text.slice(0, 50)}".`);
          await ctx.reply(`Sorry 😭\n\nYour TikTok username is already locked to this account.\n\nLocked username: @${user.tiktokUsername}`);
        }
        return;
      }

      const rawUsername = await extractTikTokUsername(text);
      if (!rawUsername) {
        console.warn(`[INVALID_TIKTOK_PROFILE_LINK] telegramId=${telegramId} input="${text.slice(0, 100)}"`);
        await ctx.reply("❌ Invalid TikTok profile link.\n\nPlease send a valid TikTok username or profile link 👀\n\nExample: https://www.tiktok.com/@username");
        return;
      }
      console.log(`[TIKTOK_USERNAME_PARSED] telegramId=${telegramId} raw="${text.slice(0, 100)}" → username="${rawUsername}"`);
      const username = normalizeTikTokUsername(rawUsername);

      // Check for duplicate — reject if taken by another account
      const existingOwner = await User.findOne({
        tiktokUsername: { $regex: new RegExp(`^${username.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i") },
        telegramId: { $ne: telegramId },
      });
      if (existingOwner) {
        console.log(`[TIKTOK_USERNAME_DUPLICATE_BLOCKED] telegramId=${telegramId} tried to register "@${username}" — already owned by telegramId=${existingOwner.telegramId}.`);
        await ctx.reply("Sorry 😵\n\nThis TikTok username is already taken by another user.");
        return;
      }

      await User.updateOne({ telegramId }, { tiktokUsername: username, tiktokProfileLink: text, state: "awaiting_cut_link", tiktokUsernameLocked: true, tiktokLockedAt: new Date() });
      console.log(`[TIKTOK_USERNAME_LOCKED] telegramId=${telegramId} permanently locked to "@${username}".`);
      await ctx.reply(`Welcome @${username}! ✅\n\nNow send your TikTok cut price link to start swapping 🔗✨`);
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
          "Please complete your current swap first 🤝\n\nYou can submit a new link after both proofs are approved.\n\nDon't worry — I'll send you a notification once your current swap is fully completed 🔔✨",
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

      await ctx.reply("Locked in! 🔒 Hunting for your next cut buddy… ✨\n\n_(You're in the queue right now — matching you with someone active 👀)_", { parse_mode: "Markdown" });

      // Try atomic match first — skip queue and notification if partner found immediately
      const immediatelyMatched = await tryMatchAtomic(bot, telegramId, text);
      if (!immediatelyMatched) {
        // No partner available — enter queue and notify idle users
        await addToQueue(bot, telegramId, text);
        await notifyQueueUsers(bot, user.tiktokUsername, telegramId);
      }

      // Admin notification — sent every time a valid cut link is submitted
      const linkSubmitTime = new Date().toLocaleString("en-MY", {
        timeZone: "Asia/Kuala_Lumpur",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      });
      const linkSubmitDisplayName = ctx.from.first_name ?? "Unknown";
      const linkSubmitTgUsername = ctx.from.username ? `@${ctx.from.username}` : "No username";
      const adminLinkMsg =
        `🔗 USER SUBMITTED CUT LINK!\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `• Name: ${linkSubmitDisplayName}\n` +
        `• Telegram Username: ${linkSubmitTgUsername}\n` +
        `• TikTok Username: @${user.tiktokUsername}\n` +
        `• ID: ${telegramId}\n` +
        `• Link: ${text}\n` +
        `• Time: ${linkSubmitTime} MYT\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `📌 Current user is now looking for a cut partner ✨`;
      for (const adminId of getAdminIds()) {
        try {
          await bot.telegram.sendMessage(adminId, adminLinkMsg);
          console.log(`[ADMIN_LINK_SUBMIT_NOTIFIED] telegramId=${telegramId} (@${user.tiktokUsername}) — notified adminId=${adminId} with link="${text}"`);
        } catch (err) {
          console.error(`[ADMIN_LINK_SUBMIT_NOTIFY_FAILED] telegramId=${telegramId} — failed to notify adminId=${adminId}: ${(err as Error).message}`);
        }
      }

      return;
    }

    if (user.state === "inqueue") {
      await ctx.reply("Still finding your cut buddy 🔒✨\n\nHang tight for a few more seconds 👀");
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

    // Remove buttons immediately — prevents double-clicks visually
    try {
      await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
      console.log(`[BUTTONS_REMOVED] done_cut — telegramId=${telegramId}`);
    } catch { /* already edited or message not found */ }

    // Atomic state transition: only succeeds if user is still in_match
    const updated = await User.findOneAndUpdate(
      { telegramId, state: "in_match" },
      { state: "awaiting_proof" },
    );
    if (!updated) {
      console.log(`[DUPLICATE_CALLBACK_BLOCKED] done_cut — telegramId=${telegramId} — not in_match state.`);
      await ctx.reply("⚠️ Action already processed.");
      return;
    }
    await ctx.reply("📸 Okieee now send a screenshot as proof that you've completed your partner's cut ✨");
  });

  bot.action("cancel_match", async (ctx) => {
    await ctx.answerCbQuery();
    const telegramId = ctx.from!.id;

    // Remove buttons immediately — prevents double-clicks visually
    try {
      await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
      console.log(`[BUTTONS_REMOVED] cancel_match — telegramId=${telegramId}`);
    } catch { /* already edited or message not found */ }

    const user = await User.findOne({ telegramId });
    if (!user || user.state !== "in_match") {
      console.log(`[DUPLICATE_CALLBACK_BLOCKED] cancel_match — telegramId=${telegramId} — not in_match state.`);
      await ctx.reply("⚠️ Action already processed.");
      return;
    }

    // Atomic cancel: only succeeds if match is still active (prevents duplicate cancellation)
    const match = await Match.findOneAndUpdate(
      { $or: [{ user1Id: telegramId }, { user2Id: telegramId }], status: "active" },
      { status: "cancelled" },
      { new: false },
    );
    if (!match) {
      console.log(`[DUPLICATE_CALLBACK_BLOCKED] cancel_match — telegramId=${telegramId} — no active match found.`);
      await ctx.reply("⚠️ Action already processed.");
      return;
    }

    const partnerId = match.user1Id === telegramId ? match.user2Id : match.user1Id;
    const partner = await User.findOne({ telegramId: partnerId });

    const timerId = match._id.toString();
    const existingTimer = matchTimers.get(timerId);
    if (existingTimer) { clearTimeout(existingTimer); matchTimers.delete(timerId); }

    const cooldownUntil = new Date(Date.now() + COOLDOWN_MS);
    await User.updateOne(
      { telegramId },
      { state: "idle", isWaiting: false, queuedAt: null, cancelCooldownUntil: cooldownUntil, pendingLink: null, activeMatchId: null },
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
        await User.updateOne({ telegramId: partnerId }, { state: "awaiting_cut_link", isWaiting: false, queuedAt: null, activeMatchId: null });
        console.log(`[PARTNER_NO_LINK] telegramId=${partnerId} has no pendingLink — set to awaiting_cut_link.`);
      }
    }
  });

  bot.action(/^approve_proof:(.+):(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const telegramId = ctx.from!.id;
    const matchId = ctx.match[1];
    const proofOwnerId = parseInt(ctx.match[2], 10);

    // Remove buttons immediately — prevents double-clicks visually
    try {
      await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
      console.log(`[BUTTONS_REMOVED] approve_proof — telegramId=${telegramId} matchId=${matchId}`);
    } catch { /* already edited or message not found */ }

    if (telegramId === proofOwnerId) {
      console.log(`[SELF_APPROVAL_BLOCKED] telegramId=${telegramId} tried to approve their own proof for matchId=${matchId}.`);
      await ctx.reply("❌ Anda tidak boleh approve bukti anda sendiri.");
      return;
    }

    const match = await Match.findById(matchId);
    if (!match || match.status !== "active") {
      console.log(`[DUPLICATE_CALLBACK_BLOCKED] approve_proof — telegramId=${telegramId} matchId=${matchId} — match no longer active.`);
      await ctx.reply("⚠️ Action already processed.");
      return;
    }

    if (match.user1Id !== telegramId && match.user2Id !== telegramId) {
      console.log(`[INVALID_CALLBACK_BLOCKED] telegramId=${telegramId} tried to approve proof for matchId=${matchId} but is not a participant.`);
      await ctx.reply("Anda bukan sebahagian daripada match ini.");
      return;
    }

    const isProofOwnerUser1 = match.user1Id === proofOwnerId;
    const approvedField = isProofOwnerUser1 ? "user1ProofApprovedByPartner" : "user2ProofApprovedByPartner";

    // Atomic lock: only sets the flag if it is still false — blocks duplicate approvals
    const locked = await Match.findOneAndUpdate(
      { _id: matchId, status: "active", [approvedField]: false },
      { [approvedField]: true },
      { new: true },
    );
    if (!locked) {
      console.log(`[CALLBACK_LOCKED] approve_proof — telegramId=${telegramId} matchId=${matchId} — already approved or match inactive.`);
      await ctx.reply("⚠️ Action already processed.");
      return;
    }

    await User.updateOne({ telegramId: proofOwnerId }, { $inc: { totalApprovedCount: 1 } });
    console.log(`[PROOF_APPROVED] telegramId=${telegramId} approved proof of telegramId=${proofOwnerId} for matchId=${matchId}.`);
    await bot.telegram.sendMessage(proofOwnerId, "🎉 Your cut buddy approved your proof!\n\nSwap completed successfully 🤝✨");
    await checkAndCompleteMatch(bot, matchId);
  });

  bot.action(/^reject_proof:(.+):(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const telegramId = ctx.from!.id;
    const matchId = ctx.match[1];
    const proofOwnerId = parseInt(ctx.match[2], 10);

    // Remove buttons immediately — prevents double-clicks visually
    try {
      await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
      console.log(`[BUTTONS_REMOVED] reject_proof — telegramId=${telegramId} matchId=${matchId}`);
    } catch { /* already edited or message not found */ }

    if (telegramId === proofOwnerId) {
      console.log(`[SELF_APPROVAL_BLOCKED] telegramId=${telegramId} tried to reject their own proof for matchId=${matchId}.`);
      await ctx.reply("❌ Anda tidak boleh reject bukti anda sendiri.");
      return;
    }

    // Read match first for participant validation
    const matchDoc = await Match.findById(matchId);
    if (!matchDoc || matchDoc.status !== "active") {
      console.log(`[DUPLICATE_CALLBACK_BLOCKED] reject_proof — telegramId=${telegramId} matchId=${matchId} — match no longer active.`);
      await ctx.reply("⚠️ Action already processed.");
      return;
    }

    if (matchDoc.user1Id !== telegramId && matchDoc.user2Id !== telegramId) {
      console.log(`[INVALID_CALLBACK_BLOCKED] telegramId=${telegramId} tried to reject proof for matchId=${matchId} but is not a participant.`);
      await ctx.reply("Anda bukan sebahagian daripada match ini.");
      return;
    }

    // Atomic cancel: only succeeds if match is still active — blocks duplicate rejection
    const match = await Match.findOneAndUpdate(
      { _id: matchId, status: "active" },
      { status: "cancelled" },
      { new: false },
    );
    if (!match) {
      console.log(`[DUPLICATE_CALLBACK_BLOCKED] reject_proof — telegramId=${telegramId} matchId=${matchId} — already cancelled.`);
      await ctx.reply("⚠️ Action already processed.");
      return;
    }

    const timerId = match._id.toString();
    const existingTimer = matchTimers.get(timerId);
    if (existingTimer) { clearTimeout(existingTimer); matchTimers.delete(timerId); }
    // Clear proof timer for the proof owner so no-response timeout doesn't fire
    const ptKey = `proof:${timerId}:${proofOwnerId}`;
    const existingProofTimer = proofTimers.get(ptKey);
    if (existingProofTimer) { clearTimeout(existingProofTimer); proofTimers.delete(ptKey); }

    // Apply 24h cooldown to the proof owner (User A — the one whose proof was rejected)
    const cooldownUntil = new Date(Date.now() + COOLDOWN_MS);
    await User.updateOne(
      { telegramId: proofOwnerId },
      { state: "idle", isWaiting: false, queuedAt: null, pendingLink: null, cancelCooldownUntil: cooldownUntil, activeMatchId: null },
    );
    await Queue.deleteOne({ telegramId: proofOwnerId });

    console.log(`[PROOF_REJECTED] telegramId=${telegramId} rejected proof of telegramId=${proofOwnerId} for matchId=${matchId}.`);
    console.log(`[USER_COOLDOWN_24H] telegramId=${proofOwnerId} placed on 24h cooldown until ${cooldownUntil.toISOString()} due to proof rejection.`);

    // Track rejection stats on the proof owner
    {
      const rejectNow = new Date();
      const ownerBefore = await User.findOne({ telegramId: proofOwnerId });
      const windowStart = ownerBefore?.weeklyRejectWindowStart ?? null;
      const windowExpired = !windowStart || (rejectNow.getTime() - windowStart.getTime() > SEVEN_DAYS_MS);
      const newWeeklyCount = windowExpired ? 1 : (ownerBefore?.weeklyRejectWindowCount ?? 0) + 1;

      await User.updateOne(
        { telegramId: proofOwnerId },
        {
          $inc: { totalRejectCount: 1, cooldownCount: 1 },
          $set: {
            lastRejectAt: rejectNow,
            weeklyRejectWindowCount: newWeeklyCount,
            ...(windowExpired ? { weeklyRejectWindowStart: rejectNow } : {}),
          },
        },
      );
      const owner = await User.findOne({ telegramId: proofOwnerId });
      const totalRejects = owner?.totalRejectCount ?? 0;
      console.log(`[USER_REJECT_INCREMENT] telegramId=${proofOwnerId} totalRejectCount=${totalRejects} weeklyCount=${newWeeklyCount}.`);

      // Auto-ban: 10 total rejects
      if (totalRejects >= AUTO_BAN_REJECT_THRESHOLD && !owner?.isBanned) {
        await User.updateOne({ telegramId: proofOwnerId }, { isBanned: true });
        console.log(`[USER_AUTO_BANNED] telegramId=${proofOwnerId} auto-banned after ${totalRejects} total rejected proofs.`);
        for (const adminId of getAdminIds()) {
          try {
            await bot.telegram.sendMessage(
              adminId,
              `🚫 *Auto-ban triggered.*\n\n@${owner?.tiktokUsername ?? proofOwnerId} (telegramId: ${proofOwnerId}) has been permanently banned after *${totalRejects} total proof rejections*.`,
              { parse_mode: "Markdown" },
            );
          } catch { /* admin may be unavailable */ }
        }
      }
      // Auto-flag: 5 rejects within 7 days
      else if (newWeeklyCount >= WEEKLY_REJECT_THRESHOLD && !owner?.isFlagged) {
        await User.updateOne({ telegramId: proofOwnerId }, { isFlagged: true });
        console.log(`[USER_FLAGGED] telegramId=${proofOwnerId} flagged after ${newWeeklyCount} rejected proofs within 7 days.`);
        for (const adminId of getAdminIds()) {
          try {
            await bot.telegram.sendMessage(
              adminId,
              `🚨 *User flagged for repeated rejected proof submissions.*\n\n@${owner?.tiktokUsername ?? proofOwnerId} (telegramId: ${proofOwnerId})\nWeekly rejects: *${newWeeklyCount}* | Total rejects: *${totalRejects}*`,
              { parse_mode: "Markdown" },
            );
          } catch { /* admin may be unavailable */ }
        }
      }
    }

    // Notify User A (proof owner) — rejection + cooldown
    try {
      await bot.telegram.sendMessage(
        proofOwnerId,
        "❌ *Bukti anda ditolak oleh partner.*\n\nAkaun anda dikenakan cooldown selama 24 jam kerana gagal melengkapkan swap dengan betul.",
        { parse_mode: "Markdown" },
      );
    } catch { /* user may have blocked bot */ }

    // Notify User B (rejecter) — match cancelled, thank you
    await ctx.reply("✅ *Match dibatalkan.*\nTerima kasih kerana membantu menjaga sistem CutSquad.", { parse_mode: "Markdown" });

    // Re-queue User B if they have a pendingLink, otherwise reset to awaiting_cut_link
    const rejecter = await User.findOne({ telegramId });
    if (rejecter?.pendingLink) {
      console.log(`[PARTNER_REQUEUED] telegramId=${telegramId} re-entering queue after proof rejection.`);
      await addToQueue(bot, telegramId, rejecter.pendingLink);
    } else {
      await User.updateOne({ telegramId }, { state: "awaiting_cut_link", isWaiting: false, queuedAt: null });
    }
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
