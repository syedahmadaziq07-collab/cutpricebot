// Rebuild: 2026-05-24
import mongoose from "mongoose";
import { Telegraf, Markup } from "telegraf";
import { message } from "telegraf/filters";
import { schedule } from "node-cron";
import { createReadStream } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { User } from "./models/user";
import { Match } from "./models/match";
import { MatchHistory } from "./models/matchHistory";
import { Referral } from "./models/referral";
import { Queue } from "./models/queue";
import { logger } from "../lib/logger";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TUTORIAL_IMAGE_PATH = join(__dirname, "../assets/tutorial_profile_link.jpeg");

const TUTORIAL_CAPTION =
  "📌 How to copy your TikTok profile link:\n\n" +
  "1. Open TikTok profile 👤\n" +
  "2. Tap Share button ↗️\n" +
  "3. Tap \"Copy Link\" 🔗\n" +
  "4. Paste link here ✨";

async function sendTutorialImage(bot: Telegraf, chatId: number, caption?: string): Promise<void> {
  try {
    await bot.telegram.sendPhoto(chatId, { source: createReadStream(TUTORIAL_IMAGE_PATH) }, { caption: caption ?? TUTORIAL_CAPTION });
  } catch (err) {
    console.error(`[TUTORIAL_IMAGE_SEND_FAILED] chatId=${chatId}: ${(err as Error).message}`);
  }
}

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
    .select("telegramId pendingLink queuedAt telegramUsername tiktokUsername");
  for (const u of queuedUsers) {
    const exists = await Queue.findOne({ telegramId: u.telegramId });
    if (!exists) {
      await Queue.create({
        telegramId: u.telegramId,
        pendingLink: u.pendingLink!,
        telegramUsername: u.telegramUsername ?? "",
        telegramName: u.telegramUsername ?? "",
        tiktokUsername: u.tiktokUsername ?? "",
        status: "waiting",
        createdAt: u.queuedAt ?? new Date(),
        updatedAt: new Date(),
      });
      console.log(`[STARTUP_CLEANUP] Restored missing Queue entry for telegramId=${u.telegramId} tiktokUsername=@${u.tiktokUsername ?? "?"}.`);
    }
  }

  // MIGRATION: enrich legacy Queue entries that are missing status/user info
  const legacyEntries = await Queue.find({ $or: [{ status: { $exists: false } }, { tiktokUsername: "" }, { tiktokUsername: { $exists: false } }] });
  for (const entry of legacyEntries) {
    const user = await User.findOne({ telegramId: entry.telegramId }).select("telegramUsername tiktokUsername");
    await Queue.updateOne(
      { _id: entry._id },
      {
        $set: {
          status: "waiting",
          telegramUsername: user?.telegramUsername ?? "",
          telegramName: user?.telegramUsername ?? "",
          tiktokUsername: user?.tiktokUsername ?? "",
          updatedAt: new Date(),
        },
      },
    );
    console.log(`[STARTUP_CLEANUP] Migrated legacy Queue entry for telegramId=${entry.telegramId} → added status/user info.`);
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

// FIX 1: Cancel stale pending_ready matches on restart — called after bot is created.
// Handles the timer-loss gap: in-memory readyTimers are wiped on restart, so matches
// that never resolved stay pending_ready forever. No punishment for either user.
export async function cleanupStalePendingReady(bot: Telegraf): Promise<void> {
  const sixtySecondsAgo = new Date(Date.now() - 60 * 1000);
  const staleMatches = await Match.find({
    status: "pending_ready",
    createdAt: { $lte: sixtySecondsAgo },
  });

  if (staleMatches.length === 0) {
    console.log("[STARTUP_CLEANUP] No stale pending_ready matches found.");
    return;
  }

  console.log(`[STARTUP_CLEANUP] Found ${staleMatches.length} stale pending_ready match(es) older than 60s — cancelling with no punishment.`);

  for (const match of staleMatches) {
    await Match.updateOne({ _id: match._id }, { status: "cancelled" });
    for (const uid of [match.user1Id, match.user2Id]) {
      await User.updateOne(
        { telegramId: uid },
        { state: "awaiting_cut_link", activeMatchId: null, pendingLink: null, isWaiting: false, queuedAt: null },
      );
      await Queue.deleteOne({ telegramId: uid });
      try {
        await bot.telegram.sendMessage(
          uid,
          "⏰ Your previous match was reset due to a server restart. No cooldown applied — submit a new cut link to start again.",
        );
      } catch { /* user may have blocked bot */ }
    }
    console.log(`[STARTUP_CLEANUP] Cancelled stale pending_ready matchId=${match._id} — both users reset to awaiting_cut_link. No punishment.`);
  }
}

const DAILY_CUT_FLOOR = 7;
const REFERRAL_CUT_REWARD = 3;
const MAX_CUT_BALANCE = 20;
const COOLDOWN_MS = 24 * 60 * 60 * 1000;

const matchTimers = new Map<string, ReturnType<typeof setTimeout>>();
const proofTimers = new Map<string, ReturnType<typeof setTimeout>>();
const proofReminderTimers = new Map<string, ReturnType<typeof setTimeout>[]>();
const readyTimers = new Map<string, ReturnType<typeof setTimeout>>();
const inactivityReminderTimers = new Map<string, ReturnType<typeof setTimeout>[]>();
const adminBroadcastPending = new Set<number>(); // admins awaiting broadcast message input
const pendingRejectReasons = new Map<number, { matchId: string; proofOwnerId: number }>(); // rejecters awaiting reason input

// New-user join notification lock — prevents duplicate admin notifications for the same telegramId
const newUserNotifyLocks = new Set<number>();

// Submit dedup — in-memory lock to prevent concurrent/duplicate cut link submissions per user
const cutLinkSubmitLocks = new Set<number>();
// Anti-spam — tracks last cut link submission timestamp per user (in-memory; 60s window)
const lastCutLinkSubmittedAt = new Map<number, number>();
const CUT_LINK_SPAM_COOLDOWN_MS = 60_000;
// Broadcast idempotency — prevents double-broadcast for the same user+link within the spam window
const broadcastedSubmissions = new Map<string, number>(); // `${telegramId}:${link}` → timestamp

const NO_RESPONSE_TIMEOUT_MS = 10 * 60 * 1000;
const NO_RESPONSE_REMINDER_MS = 8 * 60 * 1000;
const NO_RESPONSE_COOLDOWN_30M_MS = 30 * 60 * 1000;
const NO_RESPONSE_24H_MS = 24 * 60 * 60 * 1000;
const READY_TIMEOUT_MS = 60 * 1000;

const INACTIVITY_ACTIVE_STATES = [
  "pending_ready",
  "in_match",
  "awaiting_proof_account_selection",
  "awaiting_proof_cut_username",
  "awaiting_proof",
  "awaiting_partner_approval",
];

function getStateHint(state: string): string {
  switch (state) {
    case "pending_ready": return "👉 Please press ✅ Ready To Cut or ❌ Cancel Match.";
    case "in_match": return "👉 Please press ✅ Done Cut once you've completed the cut.";
    case "awaiting_proof_account_selection": return "👉 Please choose which TikTok account you used.";
    case "awaiting_proof_cut_username": return "👉 Please type the TikTok username you used to cut your partner's link.";
    case "awaiting_proof": return "👉 Please upload your screenshot proof now.";
    case "awaiting_partner_approval": return "👉 Please approve or reject your partner's proof.";
    default: return "";
  }
}

function stopInactivityReminders(matchId: string, userId: number): void {
  const key = `inactivity:${matchId}:${userId}`;
  const timers = inactivityReminderTimers.get(key);
  if (timers && timers.length > 0) {
    for (const t of timers) clearTimeout(t);
    inactivityReminderTimers.delete(key);
    console.log(`[REMINDER_STOPPED_AFTER_ACTION] matchId=${matchId} userId=${userId}`);
  }
}

async function startInactivityReminders(
  bot: Telegraf,
  matchId: string,
  userId: number,
  state: string,
  customCheck?: (matchId: string) => Promise<boolean>,
): Promise<void> {
  stopInactivityReminders(matchId, userId);
  const key = `inactivity:${matchId}:${userId}`;
  const hint = getStateHint(state);

  const steps: Array<{ delayMin: number; msg: string; isFinal?: true }> = [
    {
      delayMin: 1,
      msg: `👀 Your cut buddy is waiting for your action.\nPlease complete this step now.${hint ? "\n\n" + hint : ""}`,
    },
    {
      delayMin: 2,
      msg: "⚠️ System Warning:\nIgnoring active swaps may result in account restrictions.",
    },
    {
      delayMin: 4,
      msg: "🚨 Your partner is still waiting.\nRepeated incomplete swaps are monitored as suspicious activity.",
    },
    {
      delayMin: 6,
      msg: "⛔ Serious Warning:\nUsers who repeatedly abandon swaps may receive temporary or permanent restrictions.",
    },
    {
      delayMin: 8,
      msg: "📛 FINAL WARNING\nFailure to complete this swap may trigger automatic enforcement action on your account.",
      isFinal: true,
    },
  ];

  const timers: ReturnType<typeof setTimeout>[] = steps.map(({ delayMin, msg, isFinal }) =>
    setTimeout(async () => {
      try {
        const liveMatch = await Match.findOne({ _id: matchId, status: "active" });
        if (!liveMatch) return;
        let shouldSend: boolean;
        if (customCheck) {
          shouldSend = await customCheck(matchId);
        } else {
          const liveUser = await User.findOne({ telegramId: userId });
          shouldSend = !!liveUser && INACTIVITY_ACTIVE_STATES.includes(liveUser.state);
        }
        if (!shouldSend) return;
        await bot.telegram.sendMessage(userId, msg);
        if (isFinal) {
          console.log(`[FINAL_TIMEOUT_WARNING_SENT] matchId=${matchId} userId=${userId} state=${state}`);
        } else {
          console.log(`[INACTIVITY_REMINDER_SENT] matchId=${matchId} userId=${userId} state=${state} minuteMark=${delayMin}`);
        }
      } catch (err) {
        console.error(`[INACTIVITY_REMINDER_FAILED] matchId=${matchId} userId=${userId} min=${delayMin}: ${(err as Error).message}`);
      }
    }, delayMin * 60 * 1000),
  );

  inactivityReminderTimers.set(key, timers);
  console.log(`[INACTIVITY_REMINDERS_ARMED] matchId=${matchId} userId=${userId} state=${state} — reminders at min 1,2,4,6,8.`);
}

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

// Detects TikTok cut/short links that must be blocked during profile registration.
// vt.tiktok.com short links and tiktok.com/t/xxx are cut-price link formats,
// NOT profile links — following their redirects would yield video URLs which
// extractTikTokUsername would incorrectly parse as a username.
function isTikTokCutLink(input: string): boolean {
  const trimmed = input.trim();
  if (/https?:\/\/vt\.tiktok\.com\//i.test(trimmed)) return true;
  if (/https?:\/\/(?:www\.)?tiktok\.com\/t\//i.test(trimmed)) return true;
  return false;
}

function isValidTikTokLink(url: string): boolean {
  return /(?:https?:\/\/)?(?:www\.)?(tiktok\.com|vm\.tiktok\.com|vt\.tiktok\.com)\//i.test(url);
}

// Returns true ONLY for valid cut/campaign/share links.
// Accepts: vt.tiktok.com/... | tiktok.com/t/... (with or without https/www)
function isValidCutLink(input: string): boolean {
  const trimmed = input.trim();
  if (/https?:\/\/vt\.tiktok\.com\//i.test(trimmed)) return true;
  if (/(?:https?:\/\/)?(?:www\.)?tiktok\.com\/t\//i.test(trimmed)) return true;
  return false;
}

// Returns true for TikTok profile links (tiktok.com/@username or @username paths).
function isTikTokProfileLink(input: string): boolean {
  const trimmed = input.trim();
  if (/(?:https?:\/\/)?(?:www\.)?tiktok\.com\/@/i.test(trimmed)) return true;
  if (/^@[\w.]+$/i.test(trimmed)) return true;
  return false;
}

// Returns true for ANY TikTok link (cut link, profile link, or any tiktok.com URL).
function isAnyTikTokLink(input: string): boolean {
  const trimmed = input.trim();
  if (/(?:https?:\/\/)?(?:www\.|vt\.)?tiktok\.com\//i.test(trimmed)) return true;
  if (/https?:\/\/vm\.tiktok\.com\//i.test(trimmed)) return true;
  if (isTikTokCutLink(trimmed)) return true;
  if (isTikTokProfileLink(trimmed)) return true;
  return false;
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

// ─── Stuck Session Cleanup ───────────────────────────────────────────────────

const STUCK_STATES = [
  "inqueue",
  "pending_ready",
  "in_match",
  "awaiting_proof_account_selection",
  "awaiting_proof_cut_username",
  "awaiting_proof",
  "awaiting_reject_reason",
];
const STUCK_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes

async function performStuckCleanup(bot: Telegraf): Promise<{ clearedMatches: number; clearedQueue: number; clearedProof: number }> {
  const cutoff = new Date(Date.now() - STUCK_THRESHOLD_MS);
  console.log(`[STUCK_CLEANUP_STARTED] cutoff=${cutoff.toISOString()}`);

  let clearedMatches = 0;
  let clearedQueue = 0;
  let clearedProof = 0;

  const proofStates = new Set([
    "awaiting_proof_account_selection",
    "awaiting_proof_cut_username",
    "awaiting_proof",
    "awaiting_reject_reason",
  ]);

  // First: attempt to match any inqueue users with each other before resetting them.
  // This fixes the case where 2+ users are all in queue but nobody new submits a link.
  await retryQueueMatchingInternal(bot);

  // Now fetch users who are STILL stuck (not just matched above)
  const stuckUsers = await User.find({
    state: { $in: STUCK_STATES },
    updatedAt: { $lt: cutoff },
  });

  for (const user of stuckUsers) {
    const { telegramId, state, activeMatchId } = user;

    // Cancel active or pending_ready match if any
    if (activeMatchId) {
      const activeMatch = await Match.findOne({ _id: activeMatchId, status: { $in: ["active", "pending_ready"] } });
      if (activeMatch) {
        await Match.updateOne({ _id: activeMatch._id }, { status: "cancelled" });

        const timerId = activeMatch._id.toString();
        const existingTimer = matchTimers.get(timerId);
        if (existingTimer) { clearTimeout(existingTimer); matchTimers.delete(timerId); }
        const existingReadyTimer = readyTimers.get(timerId);
        if (existingReadyTimer) { clearTimeout(existingReadyTimer); readyTimers.delete(timerId); }

        for (const uid of [activeMatch.user1Id, activeMatch.user2Id]) {
          const ptKey = `proof:${timerId}:${uid}`;
          const pt = proofTimers.get(ptKey);
          if (pt) { clearTimeout(pt); proofTimers.delete(ptKey); }
          const rptKey = `proof_reminder:${timerId}:${uid}`;
          const rpt = proofReminderTimers.get(rptKey);
          if (rpt) { clearTimeout(rpt); proofReminderTimers.delete(rptKey); }
          stopInactivityReminders(timerId, uid);
        }

        clearedMatches++;
        console.log(`[STUCK_MATCH_CLEARED] matchId=${timerId} telegramId=${telegramId} state=${state} matchStatus=${activeMatch.status}`);

        // Admin notification — stuck cleanup cancelled this match
        const stuckOtherId = activeMatch.user1Id === telegramId ? activeMatch.user2Id : activeMatch.user1Id;
        const stuckOtherDoc = await User.findOne({ telegramId: stuckOtherId }).select("state");
        const stuckU1Status = activeMatch.user1Id === telegramId ? matchStateToStatus(state) : matchStateToStatus(stuckOtherDoc?.state);
        const stuckU2Status = activeMatch.user2Id === telegramId ? matchStateToStatus(state) : matchStateToStatus(stuckOtherDoc?.state);
        const isPreLinkReveal = activeMatch.status === "pending_ready";
        await notifyAdminMatchCancelled(
          bot, activeMatch.user1Id, activeMatch.user2Id,
          `Stuck cleanup detected inactive match${isPreLinkReveal ? " (pending_ready — links not revealed)" : ""}. Responsible user last seen in state: ${state}.`,
          timerId,
          {
            responsibleId: telegramId,
            user1Status: stuckU1Status,
            user2Status: stuckU2Status,
            systemActions: ["Match cancelled", "No cooldown applied", "No strike issued"],
          },
        );
      }
    }

    // Remove from queue
    const queueResult = await Queue.deleteOne({ telegramId });
    if (queueResult.deletedCount > 0) {
      clearedQueue++;
      console.log(`[STUCK_QUEUE_CLEARED] telegramId=${telegramId}`);
    }

    // Track proof state clears
    if (proofStates.has(state)) {
      clearedProof++;
      console.log(`[STUCK_PROOF_STATE_CLEARED] telegramId=${telegramId} state=${state}`);
    }

    // Reset user — preserve account, profile, cuts, bans, cooldowns
    await User.updateOne(
      { telegramId },
      {
        state: "awaiting_cut_link",
        isWaiting: false,
        queuedAt: null,
        pendingLink: null,
        activeMatchId: null,
        proofCutByUsername: null,
      },
    );
    console.log(`[MATCH_STATE_FULLY_CLEARED] telegramId=${telegramId} path=stuck_cleanup`);

    // Notify user
    try {
      await bot.telegram.sendMessage(
        telegramId,
        "⏰ Your previous session expired because it was inactive for too long.\n\nNo worries — you can submit a new cut link anytime 👀✨",
      );
    } catch { /* user may have blocked bot */ }
  }

  console.log(`[STUCK_CLEANUP_FINISHED] clearedMatches=${clearedMatches} clearedQueue=${clearedQueue} clearedProof=${clearedProof} totalUsers=${stuckUsers.length}`);

  // Auto-recovery: clear stale activeMatchId for users in awaiting_cut_link with a dead match reference
  const staleActiveMatchUsers = await User.find({
    state: "awaiting_cut_link",
    activeMatchId: { $ne: null },
  });
  for (const user of staleActiveMatchUsers) {
    const { telegramId, activeMatchId } = user;
    const linkedMatch = await Match.findOne({ _id: activeMatchId, status: { $in: ["active", "pending_ready"] } });
    if (!linkedMatch) {
      await User.updateOne({ telegramId }, { activeMatchId: null });
      console.log(`[STALE_ACTIVE_MATCH_ID_CLEARED] telegramId=${telegramId}`);
    }
  }

  return { clearedMatches, clearedQueue, clearedProof };
}

export function scheduleStuckCleanup(bot: Telegraf): void {
  // Runs every 30 minutes
  schedule("*/30 * * * *", async () => {
    const now = new Date();
    console.log(`[STUCK_CLEANUP_AUTO] Auto stuck cleanup triggered at ${now.toISOString()}`);
    try {
      await performStuckCleanup(bot);
    } catch (err) {
      console.error(`[STUCK_CLEANUP_AUTO_FAILED] ${(err as Error).message}`);
    }
  });
  console.log("[STUCK_CLEANUP_AUTO] Scheduler registered: stuck cleanup every 30 minutes.");
}

// ─── Queue Retry Matching ─────────────────────────────────────────────────────

interface QueueRetryResult {
  matched: number;
  reasons: Map<number, string>;
}

async function retryQueueMatchingInternal(bot: Telegraf): Promise<QueueRetryResult> {
  console.log(`[RETRY_QUEUE_MATCHING_STARTED] Scanning all inqueue users for eligible matches.`);

  const queuedUsers = await User.find({
    state: "inqueue",
    isWaiting: true,
    activeMatchId: null,
    pendingLink: { $nin: [null, ""] },
  }).sort({ queuedAt: 1 }); // FIFO

  if (queuedUsers.length === 0) {
    return { matched: 0, reasons: new Map() };
  }

  console.log(`[QUEUE_STUCK_DETECTED] ${queuedUsers.length} user(s) found in queue. Attempting retry matching.`);

  let matched = 0;
  const reasons = new Map<number, string>();

  for (const user of queuedUsers) {
    const { telegramId, pendingLink } = user;

    // Re-fetch: skip users already claimed by a prior iteration in this run
    const fresh = await User.findOne({ telegramId }).select("state");
    if (!fresh || fresh.state !== "inqueue") {
      reasons.set(telegramId, "ALREADY_MATCHED");
      continue;
    }

    // Must have a pending link
    if (!pendingLink) {
      reasons.set(telegramId, "STALE_QUEUE");
      console.log(`[RETRY_QUEUE_SKIPPED_REASON] telegramId=${telegramId} reason=STALE_QUEUE`);
      continue;
    }

    // Skip banned / on cooldown
    const sus = await checkSuspension(telegramId);
    if (sus.suspended) {
      reasons.set(telegramId, "COOLDOWN");
      console.log(`[RETRY_QUEUE_SKIPPED_REASON] telegramId=${telegramId} reason=COOLDOWN`);
      continue;
    }

    // Attempt atomic match — respects ALL existing rules (24h exclusion, ban, cooldown, FIFO, active match check)
    const didMatch = await tryMatchAtomic(bot, telegramId, pendingLink);
    if (didMatch) {
      matched++;
      console.log(`[RETRY_QUEUE_MATCH_CREATED] telegramId=${telegramId} — matched via queue retry.`);
    } else {
      reasons.set(telegramId, "NO_ELIGIBLE_PARTNER");
      console.log(`[QUEUE_NO_ELIGIBLE_PARTNER] telegramId=${telegramId} — no eligible partner found during retry.`);
    }
  }

  console.log(`[RETRY_QUEUE_MATCHING_FINISHED] matched=${matched} stillWaiting=${reasons.size} total=${queuedUsers.length}`);
  return { matched, reasons };
}

export function scheduleQueueRetry(bot: Telegraf): void {
  // Runs every 30 seconds as a safety net — catches users who missed an immediate match
  // (e.g. both users entered queue simultaneously before either had a partner).
  // The primary matching path is immediate: tryMatchAtomic inside addToQueue.
  schedule("*/30 * * * * *", async () => {
    try {
      const queueSize = await User.countDocuments({ state: "inqueue", isWaiting: true });
      if (queueSize >= 2) {
        console.log(`[QUEUE_RETRY_CRON] ${queueSize} user(s) in queue — triggering safety-net retry matching.`);
        await retryQueueMatchingInternal(bot);
      }
    } catch (err) {
      console.error(`[QUEUE_RETRY_CRON_FAILED] ${(err as Error).message}`);
    }
  });
  console.log("[QUEUE_RETRY_CRON] Scheduler registered: safety-net queue retry every 30 seconds.");
}

// ─────────────────────────────────────────────────────────────────────────────

// Track last broadcast counts for /debug_broadcast
const lastBroadcastStats = {
  total: 0, eligible: 0, sent: 0, failed: 0,
  skippedSelf: 0, skippedBanned: 0, skippedCooldown: 0,
  senderTikTok: "", cutLink: "", triggerSource: "", submitTime: 0, ts: 0,
};

async function broadcastCutLinkNotification(
  bot: Telegraf,
  senderTikTok: string,
  senderTelegramId: number,
  triggerSource: string = "cut_link_submit",
  cutLink: string = "",
): Promise<void> {
  const now = new Date();
  const submitTime = Date.now();

  // Send to ALL users who have ever pressed /start
  const allUsers = await User.find({}).select("telegramId tiktokUsername isBanned suspendedUntil cancelCooldownUntil");

  console.log(`[CUSTOMER_BROADCAST_TOTAL_USERS] count=${allUsers.length} sender=@${senderTikTok} triggerSource=${triggerSource}`);

  let sentCount = 0;
  let failedCount = 0;
  let skippedSelf = 0;
  let skippedBanned = 0;
  let skippedCooldown = 0;

  setImmediate(async () => {
    for (const u of allUsers) {
      if (u.telegramId === senderTelegramId) {
        console.log(`[CUSTOMER_BROADCAST_SKIPPED_SELF] telegramId=${u.telegramId} sender=@${senderTikTok}`);
        skippedSelf++;
        continue;
      }
      if (u.isBanned) {
        console.log(`[CUSTOMER_BROADCAST_SKIPPED_BANNED] telegramId=${u.telegramId} (@${u.tiktokUsername})`);
        skippedBanned++;
        continue;
      }
      const onCooldown = (u.suspendedUntil && u.suspendedUntil > now) || (u.cancelCooldownUntil && u.cancelCooldownUntil > now);
      if (onCooldown) {
        console.log(`[CUSTOMER_BROADCAST_SKIPPED_COOLDOWN] telegramId=${u.telegramId} (@${u.tiktokUsername})`);
        skippedCooldown++;
        continue;
      }

      try {
        await bot.telegram.sendMessage(
          u.telegramId,
          `🔔 Someone new just dropped their cut link! 👀✨\n\nTikTok username:\n@${senderTikTok}`,
        );
        sentCount++;
        console.log(`[CUSTOMER_BROADCAST_SENT] telegramId=${u.telegramId} (@${u.tiktokUsername}) sender=@${senderTikTok}`);
      } catch (err) {
        failedCount++;
        console.error(`[CUSTOMER_BROADCAST_FAILED] telegramId=${u.telegramId} (@${u.tiktokUsername}): ${(err as Error).message}`);
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    const eligible = allUsers.length - skippedSelf - skippedBanned - skippedCooldown;
    console.log(`[CUSTOMER_BROADCAST_COMPLETED] sender=@${senderTikTok} triggerSource=${triggerSource} total=${allUsers.length} eligible=${eligible} sent=${sentCount} failed=${failedCount} skipped_self=${skippedSelf} skipped_banned=${skippedBanned} skipped_cooldown=${skippedCooldown}`);

    // Update debug stats
    lastBroadcastStats.total = allUsers.length;
    lastBroadcastStats.eligible = eligible;
    lastBroadcastStats.sent = sentCount;
    lastBroadcastStats.failed = failedCount;
    lastBroadcastStats.skippedSelf = skippedSelf;
    lastBroadcastStats.skippedBanned = skippedBanned;
    lastBroadcastStats.skippedCooldown = skippedCooldown;
    lastBroadcastStats.senderTikTok = senderTikTok;
    lastBroadcastStats.cutLink = cutLink;
    lastBroadcastStats.triggerSource = triggerSource;
    lastBroadcastStats.submitTime = submitTime;
    lastBroadcastStats.ts = Date.now();
  });
}

// Keep old name as alias so no other call site breaks
const notifyQueueUsers = broadcastCutLinkNotification;

const BANNED_MESSAGE =
  "🚫 Your account has been permanently banned from CutPriceBot.\n\n" +
  "Reason:\nRepeated rule violations or suspicious swap activity.\n\n" +
  "To appeal/unban, please contact the owner.";

const COOLDOWN_MESSAGE =
  "🚫 You're currently on cooldown.\n\n" +
  "Reason:\nYou ignored or failed to complete a previous swap properly.\n\n" +
  "⏳ Please wait until your cooldown ends before using CutPriceBot again.\n\n" +
  "⚠️ Important:\n" +
  "• 1st serious offence → 24h cooldown\n" +
  "• 2nd serious offence → another 24h cooldown\n" +
  "• 3rd serious offence → permanent ban\n\n" +
  "Please complete every swap honestly.\n" +
  "Fake proof, ghosting, ignoring proof, or abandoning swaps can lead to restrictions.";

async function checkSuspension(telegramId: number): Promise<{ suspended: boolean; message: string; reason: "banned" | "cooldown" | null }> {
  const user = await User.findOne({ telegramId });
  if (!user) return { suspended: false, message: "", reason: null };
  if (user.isBanned) return { suspended: true, message: BANNED_MESSAGE, reason: "banned" };
  const now = new Date();
  if ((user.suspendedUntil && user.suspendedUntil > now) || (user.cancelCooldownUntil && user.cancelCooldownUntil > now)) {
    return { suspended: true, message: COOLDOWN_MESSAGE, reason: "cooldown" };
  }
  return { suspended: false, message: "", reason: null };
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

  if (newCount >= 3) {
    // 3rd no-response → permanent ban
    await User.updateOne(
      { telegramId: inactivePartnerId },
      { ...baseUpdate, isBanned: true, state: "idle", pendingLink: null, activeMatchId: null },
    );
    console.log(`[NO_RESPONSE_PERMANENT_BAN] telegramId=${inactivePartnerId} — permanently banned after ${newCount} no-response strikes.`);
    try {
      await bot.telegram.sendMessage(
        inactivePartnerId,
        `🚫 You've been *permanently banned*.\n\nReason: Repeated failure to respond to partner proof.\n\nStrike: ${newCount}/3`,
        { parse_mode: "Markdown" },
      );
    } catch { /* user may have blocked bot */ }
  } else {
    // 1st and 2nd no-response → 24h ban
    const banUntil = new Date(now.getTime() + NO_RESPONSE_24H_MS);
    await User.updateOne(
      { telegramId: inactivePartnerId },
      { ...baseUpdate, cancelCooldownUntil: banUntil, state: "idle", pendingLink: null, activeMatchId: null },
    );
    console.log(`[NO_RESPONSE_24H_BAN] telegramId=${inactivePartnerId} — 24h ban applied (strike ${newCount}/3) until ${banUntil.toISOString()}.`);
    try {
      await bot.telegram.sendMessage(
        inactivePartnerId,
        `⚠️ You didn't respond to your partner's proof in time.\n\nStrike: ${newCount}/3\n\n🚫 You've been banned for *24 hours*.\n\n• 1st no-response → 24h ban 🚫\n• 2nd no-response → 24h ban 🚫\n• 3rd no-response → permanent ban`,
        { parse_mode: "Markdown" },
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
  const expiredReminder = proofReminderTimers.get(`proof_reminder:${matchId}:${proofOwnerId}`);
  if (expiredReminder) { clearTimeout(expiredReminder); proofReminderTimers.delete(`proof_reminder:${matchId}:${proofOwnerId}`); }
  stopInactivityReminders(matchId, proofOwnerId);
  stopInactivityReminders(matchId, inactivePartnerId);

  // Admin notification — proof approval timeout
  const ptU1Status = match.user1Id === proofOwnerId ? "✅ Proof Submitted" : "❌ Did Not Approve/Reject Proof";
  const ptU2Status = match.user2Id === proofOwnerId ? "✅ Proof Submitted" : "❌ Did Not Approve/Reject Proof";
  await notifyAdminMatchCancelled(
    bot, match.user1Id, match.user2Id,
    `Partner did not approve/reject proof within allowed time.`,
    matchId,
    {
      responsibleId: inactivePartnerId,
      user1Status: ptU1Status,
      user2Status: ptU2Status,
      systemActions: [
        "Match cancelled",
        "Strike issued to inactive partner",
        "No cooldown applied to proof owner",
      ],
    },
  );

  // Clean reset for honest proof owner — NO auto-requeue; manual new link required
  const proofOwnerUser = await User.findOne({ telegramId: proofOwnerId }).select("cutBalance tiktokUsername");
  const _proofOwnerQueueDel = await Queue.deleteOne({ telegramId: proofOwnerId });
  if (_proofOwnerQueueDel.deletedCount > 0) {
    console.log(`[QUEUE_RECORD_REMOVED] telegramId=${proofOwnerId} reason=proof_timeout_honest_owner`);
  }
  await User.updateOne(
    { telegramId: proofOwnerId },
    { state: "awaiting_cut_link", isWaiting: false, queuedAt: null, pendingLink: null, activeMatchId: null, proofCutByUsername: null },
  );
  console.log(`[MATCH_STATE_FULLY_CLEARED] telegramId=${proofOwnerId} path=proof_timeout_honest_owner`);
  console.log(`[AUTO_REMATCH_BLOCKED] matchId=${matchId} — honest user ${proofOwnerId} NOT auto-requeued. Manual link required.`);
  console.log(`[HONEST_USER_REMATCH_STOPPED] telegramId=${proofOwnerId} — reset to awaiting_cut_link, no queue insertion.`);
  console.log(`[USER_MANUAL_REMATCH_REQUIRED] telegramId=${proofOwnerId} — must submit new cut link to rejoin queue.`);
  console.log(`[MATCH_FULLY_TERMINATED] matchId=${matchId} — proof timeout, both users reset, no auto-rematch.`);

  const remainingCuts = Math.max(0, proofOwnerUser?.cutBalance ?? 0);
  try {
    await bot.telegram.sendMessage(
      proofOwnerId,
      `❌ Your previous partner did not respond in time.\n\n✅ Your proof was successfully submitted.\n\n⚠️ Your partner has received a cooldown/restriction for inactivity.\n\nYou are NOT currently in queue.\n\nIf you want a new partner, please send a new cut link to start again 👀✨\n\n🎟 Remaining cuts: ${remainingCuts}`,
    );
  } catch { /* user may have blocked bot */ }

  // Reset inactive partner state then issue strike (punishment unchanged)
  const _inactivePartnerQueueDel = await Queue.deleteOne({ telegramId: inactivePartnerId });
  if (_inactivePartnerQueueDel.deletedCount > 0) {
    console.log(`[QUEUE_RECORD_REMOVED] telegramId=${inactivePartnerId} reason=proof_timeout_inactive_partner`);
  }
  await User.updateOne(
    { telegramId: inactivePartnerId },
    { state: "awaiting_cut_link", isWaiting: false, queuedAt: null, pendingLink: null, activeMatchId: null, proofCutByUsername: null },
  );
  console.log(`[MATCH_STATE_FULLY_CLEARED] telegramId=${inactivePartnerId} path=proof_timeout_inactive_partner`);
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

  // Admin notification — match timer expired; determine responsible user from DB states
  const [u1state, u2state] = await Promise.all([
    User.findOne({ telegramId: user1Id }).select("state"),
    User.findOne({ telegramId: user2Id }).select("state"),
  ]);
  let expiryResponsible: number | "both" | null = null;
  let expiryReason = "Match timer expired — 10-minute match window elapsed with no action.";
  if (u1state?.state === "in_match" && u2state?.state === "in_match") {
    expiryResponsible = "both";
    expiryReason = "Both users inactive — neither pressed Done Cut within the 10-minute window.";
  } else if (u1state?.state === "in_match" && u2state?.state !== "in_match") {
    expiryResponsible = user1Id;
    expiryReason = "Did not press Done Cut — 10-minute match window elapsed while user had not acted.";
  } else if (u2state?.state === "in_match" && u1state?.state !== "in_match") {
    expiryResponsible = user2Id;
    expiryReason = "Did not press Done Cut — 10-minute match window elapsed while user had not acted.";
  } else if (u1state?.state === "awaiting_proof_account_selection") {
    expiryResponsible = user1Id;
    expiryReason = "User did not choose TikTok account — 10-minute match window elapsed.";
  } else if (u2state?.state === "awaiting_proof_account_selection") {
    expiryResponsible = user2Id;
    expiryReason = "User did not choose TikTok account — 10-minute match window elapsed.";
  } else if (u1state?.state === "awaiting_proof_cut_username") {
    expiryResponsible = user1Id;
    expiryReason = "User did not enter TikTok username — 10-minute match window elapsed.";
  } else if (u2state?.state === "awaiting_proof_cut_username") {
    expiryResponsible = user2Id;
    expiryReason = "User did not enter TikTok username — 10-minute match window elapsed.";
  } else if (u1state?.state === "awaiting_proof") {
    expiryResponsible = user1Id;
    expiryReason = "User did not upload screenshot proof — 10-minute match window elapsed.";
  } else if (u2state?.state === "awaiting_proof") {
    expiryResponsible = user2Id;
    expiryReason = "User did not upload screenshot proof — 10-minute match window elapsed.";
  }
  await notifyAdminMatchCancelled(
    bot, user1Id, user2Id,
    expiryReason,
    matchId,
    {
      responsibleId: expiryResponsible,
      user1Status: matchStateToStatus(u1state?.state),
      user2Status: matchStateToStatus(u2state?.state),
      systemActions: ["Match cancelled", "No cooldown applied", "No strike issued"],
    },
  );

  const activeStates = ["in_match", "awaiting_proof_account_selection", "awaiting_proof_cut_username", "awaiting_proof", "awaiting_partner_approval", "awaiting_reject_reason"];

  for (const uid of [user1Id, user2Id]) {
    const user = await User.findOne({ telegramId: uid });
    if (!user) continue;
    if (!activeStates.includes(user.state)) continue;
    // Clear any pending proof timer and reminder for this user in this match
    const proofTimerKey = `proof:${matchId}:${uid}`;
    const existingProofTimer = proofTimers.get(proofTimerKey);
    if (existingProofTimer) { clearTimeout(existingProofTimer); proofTimers.delete(proofTimerKey); }
    const reminderKey = `proof_reminder:${matchId}:${uid}`;
    const existingReminder = proofReminderTimers.get(reminderKey);
    if (existingReminder) { clearTimeout(existingReminder); proofReminderTimers.delete(reminderKey); }
    await Queue.deleteOne({ telegramId: uid });
    console.log(`[QUEUE_REMOVE] telegramId=${uid} removed from queue (match expired).`);
    // Clean reset — NO auto-requeue; user must manually submit a new cut link
    await User.updateOne({ telegramId: uid }, { state: "awaiting_cut_link", pendingLink: null, isWaiting: false, queuedAt: null, activeMatchId: null, proofCutByUsername: null });
    console.log(`[MATCH_STATE_FULLY_CLEARED] telegramId=${uid} path=match_expiry`);
    console.log(`[AUTO_REMATCH_BLOCKED] matchId=${matchId} telegramId=${uid} — NOT auto-requeued after match expiry.`);
    console.log(`[USER_MANUAL_REMATCH_REQUIRED] telegramId=${uid} — must submit new cut link to rejoin queue.`);
    const remainingCuts = Math.max(0, user.cutBalance ?? 0);
    try {
      await bot.telegram.sendMessage(
        uid,
        `❌ This match has expired due to inactivity.\n\nYou are NOT currently in queue.\n\nIf you want a new partner, please send a new cut link to start again 👀✨\n\n🎟 Remaining cuts: ${remainingCuts}`,
      );
    } catch { /* user may have blocked bot */ }
  }
  console.log(`[MATCH_FULLY_TERMINATED] matchId=${matchId} — match expired, both users reset, no auto-rematch.`);
  matchTimers.delete(matchId);
  stopInactivityReminders(matchId, user1Id);
  stopInactivityReminders(matchId, user2Id);
  console.log(`[MATCH_AUTO_CANCELLED_FOR_INACTIVITY] matchId=${matchId} — 10-minute window elapsed, match cancelled due to inactivity.`);
}

// Maps a user DB state to a human-readable status label for admin notifications
function matchStateToStatus(state: string | undefined | null): string {
  switch (state) {
    case "pending_ready":                    return "⏳ Waiting for Ready Confirmation";
    case "in_match":                         return "❌ Did Not Press Done Cut";
    case "awaiting_proof_account_selection": return "❌ Did Not Choose TikTok Account";
    case "awaiting_proof_cut_username":      return "❌ Did Not Enter TikTok Username";
    case "awaiting_proof":                   return "❌ Did Not Upload Screenshot";
    case "awaiting_partner_approval":        return "✅ Proof Submitted";
    case "awaiting_reject_reason":           return "✅ Proof Submitted (under review)";
    default:                                 return "❓ Unknown";
  }
}

interface NotifyMatchCancelledOptions {
  responsibleId?: number | "both" | null;
  user1Status?: string;
  user2Status?: string;
  systemActions?: string[];
}

// Shared helper — sends ⚠️ MATCH CANCELLED / TIMEOUT notification to all admins.
// Wrapped in try/catch: never throws, never crashes the bot.
async function notifyAdminMatchCancelled(
  bot: Telegraf,
  user1Id: number,
  user2Id: number,
  reason: string,
  matchId?: string,
  options?: NotifyMatchCancelledOptions,
): Promise<void> {
  try {
    const responsibleId = options?.responsibleId ?? null;
    const numericResponsibleId = typeof responsibleId === "number" ? responsibleId : null;
    const uniqueIds = [...new Set([user1Id, user2Id, ...(numericResponsibleId != null ? [numericResponsibleId] : [])])];
    const docs = await User.find({ telegramId: { $in: uniqueIds } }).select("telegramId telegramUsername tiktokUsername");
    const byId = new Map(docs.map(d => [d.telegramId, d]));

    const fmtUser = (id: number, status: string | undefined) => {
      const u = byId.get(id);
      return (
        `• Telegram: @${u?.telegramUsername || "N/A"}\n` +
        `• TikTok: @${u?.tiktokUsername || "N/A"}\n` +
        `• ID: ${id}\n` +
        `• Status: ${status ?? "❓ Unknown"}`
      );
    };

    let responsibleBlock: string;
    if (responsibleId === "both") {
      const tgA = byId.get(user1Id)?.telegramUsername || String(user1Id);
      const tgB = byId.get(user2Id)?.telegramUsername || String(user2Id);
      responsibleBlock = `@${tgA} AND @${tgB}\n(Both users inactive)`;
      console.log(`[RESPONSIBLE_USER_DETECTED]${matchId ? ` matchId=${matchId}` : ""} responsible=BOTH user1=${user1Id} user2=${user2Id}`);
    } else if (numericResponsibleId != null) {
      const u = byId.get(numericResponsibleId);
      responsibleBlock =
        `• Telegram: @${u?.telegramUsername || "N/A"}\n` +
        `• TikTok: @${u?.tiktokUsername || "N/A"}\n` +
        `• ID: ${numericResponsibleId}`;
      console.log(`[RESPONSIBLE_USER_DETECTED]${matchId ? ` matchId=${matchId}` : ""} responsibleId=${numericResponsibleId} tg=@${u?.telegramUsername || "N/A"}`);
    } else {
      responsibleBlock = "Unknown / needs manual review";
      console.log(`[RESPONSIBLE_USER_UNKNOWN]${matchId ? ` matchId=${matchId}` : ""} — could not determine responsible user`);
    }

    const systemActions = options?.systemActions ?? ["Match cancelled"];
    const systemActionsText = systemActions.map(a => `• ${a}`).join("\n");

    const mytime = new Date().toLocaleString("en-MY", {
      timeZone: "Asia/Kuala_Lumpur",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
      hour12: false,
    });

    const adminMsg =
      `⚠️ MATCH CANCELLED / TIMEOUT\n` +
      `━━━━━━━━━━━━━━━━━━\n\n` +
      `User A:\n${fmtUser(user1Id, options?.user1Status)}\n\n` +
      `User B:\n${fmtUser(user2Id, options?.user2Status)}\n\n` +
      `Responsible User:\n${responsibleBlock}\n\n` +
      `Reason:\n${reason}\n\n` +
      `System Action:\n${systemActionsText}\n\n` +
      `• Time: ${mytime} MYT\n` +
      `━━━━━━━━━━━━━━━━━━`;

    for (const adminId of getAdminIds()) {
      try {
        await bot.telegram.sendMessage(adminId, adminMsg);
        console.log(`[ADMIN_MATCH_CANCELLED_DETAIL_RENDERED]${matchId ? ` matchId=${matchId}` : ""} user1=${user1Id} user2=${user2Id} responsible=${responsibleId ?? "unknown"} notified adminId=${adminId}`);
      } catch (err) {
        console.error(`[ADMIN_MATCH_RESULT_NOTIFY_FAILED]${matchId ? ` matchId=${matchId}` : ""} cancel-notify adminId=${adminId}: ${(err as Error).message}`);
      }
    }
  } catch (err) {
    console.error(`[ADMIN_MATCH_RESULT_NOTIFY_FAILED]${matchId ? ` matchId=${matchId}` : ""} cancel-notify fetch error: ${(err as Error).message}`);
  }
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
  // Block if current user already has an active or pending_ready match
  const existingMatch = await Match.findOne({
    $or: [{ user1Id: currentTelegramId }, { user2Id: currentTelegramId }],
    status: { $in: ["active", "pending_ready"] },
  });
  if (existingMatch) {
    console.log(`[DOUBLE_MATCH_BLOCKED] telegramId=${currentTelegramId} already has activeMatchId=${existingMatch._id} (status=${existingMatch.status}) — skipping new match.`);
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

  console.log(`[ATOMIC_PARTNER_CLAIM_ATTEMPT] telegramId=${currentTelegramId} seeking partner. Excluding ${excludeIds.length - 1} recently paired user(s): [${excludeIds.slice(1).join(", ")}]`);

  // Validate current user has no stale state before claiming a partner
  const currentUserDoc = await User.findOne({ telegramId: currentTelegramId }).select("state isWaiting activeMatchId pendingLink");
  if (currentUserDoc && currentUserDoc.activeMatchId && currentUserDoc.activeMatchId !== null) {
    console.log(`[STALE_USER_STATE_DETECTED] telegramId=${currentTelegramId} has stale activeMatchId=${currentUserDoc.activeMatchId} — cleaning`);
    await User.updateOne({ telegramId: currentTelegramId }, { activeMatchId: null, isWaiting: false, queuedAt: null, pendingLink: null, state: "awaiting_cut_link", proofCutByUsername: null });
    await Queue.deleteOne({ telegramId: currentTelegramId });
    console.log(`[STALE_USER_STATE_CLEANED] telegramId=${currentTelegramId}`);
    return false;
  }

  // Log detailed candidate diagnostics before claiming
  const totalInQueue = await Queue.countDocuments();
  const broadCandidates = await User.find({
    telegramId: { $ne: currentTelegramId },
    state: "inqueue",
    isWaiting: true,
  }).select("telegramId isBanned suspendedUntil activeMatchId pendingLink").lean();

  console.log(`[CANDIDATE_SCAN] telegramId=${currentTelegramId} — ${totalInQueue} total in queue, ${broadCandidates.length} raw candidate(s) (before eligibility filters):`);
  for (const c of broadCandidates) {
    const recentlyPaired = excludeIds.includes(c.telegramId);
    const banned = c.isBanned;
    const onCooldown = c.suspendedUntil && (c.suspendedUntil as Date) > now;
    const hasActiveMatch = !!c.activeMatchId;
    const noLink = !c.pendingLink;
    if (recentlyPaired) console.log(`  ❌ telegramId=${c.telegramId} — REJECTED: recently paired (24h rule)`);
    else if (banned)    console.log(`  ❌ telegramId=${c.telegramId} — REJECTED: banned`);
    else if (onCooldown) console.log(`  ❌ telegramId=${c.telegramId} — REJECTED: on cooldown until ${(c.suspendedUntil as Date).toISOString()}`);
    else if (hasActiveMatch) console.log(`  ❌ telegramId=${c.telegramId} — REJECTED: has active match ${c.activeMatchId}`);
    else if (noLink)    console.log(`  ❌ telegramId=${c.telegramId} — REJECTED: no pending link`);
    else                console.log(`  ✅ telegramId=${c.telegramId} — ELIGIBLE`);
  }

  // Atomically claim the oldest eligible waiting user (strict FIFO via queuedAt: 1 sort)
  const partner = await User.findOneAndUpdate(
    {
      telegramId: { $nin: excludeIds },
      state: "inqueue",
      isWaiting: true,
      activeMatchId: null,
      pendingLink: { $nin: [null, ""] },
      isBanned: false,
      $or: [{ suspendedUntil: null }, { suspendedUntil: { $lte: now } }],
    },
    {
      $set: {
        state: "pending_ready",
        isWaiting: false,
        queuedAt: null,
        activeMatchId: matchId,
        lastMatchPartnerId: currentTelegramId,
      },
    },
    { sort: { queuedAt: 1 }, new: true },
  );

  if (!partner) {
    console.log(`[ATOMIC_PARTNER_CLAIM_FAILED] telegramId=${currentTelegramId} — no eligible partner found in queue after filters.`);
    return false;
  }

  console.log(`[FIFO_MATCH_FOUND] telegramId=${currentTelegramId} found partner telegramId=${partner.telegramId} (@${partner.tiktokUsername}) queuedAt=${partner.queuedAt?.toISOString() ?? "null"}.`);
  console.log(`[FIFO_MATCH_SUCCESS] matchId=${matchId} — FIFO pair: claimer=${currentTelegramId} partner=${partner.telegramId} (oldest in queue).`);
  console.log(`[ATOMIC_PARTNER_CLAIM_SUCCESS] telegramId=${currentTelegramId} claimed partner telegramId=${partner.telegramId} (@${partner.tiktokUsername}) for matchId=${matchId}`);

  // Update current user to pending_ready
  await User.updateOne(
    { telegramId: currentTelegramId },
    {
      $set: {
        state: "pending_ready",
        isWaiting: false,
        queuedAt: null,
        activeMatchId: matchId,
        lastMatchPartnerId: partner.telegramId,
        pendingLink,
      },
    },
  );

  // Remove both from Queue (partner may have a Queue entry; current user has not been queued yet)
  const matchRemoveResult = await Queue.deleteMany({ telegramId: { $in: [currentTelegramId, partner.telegramId] } });
  if (matchRemoveResult.deletedCount > 0) {
    const remaining = await Queue.countDocuments({ status: "waiting" });
    console.log(`[QUEUE_RECORD_REMOVED] matchId=${matchId} removed ${matchRemoveResult.deletedCount} Queue entry(ies) — users matched. reason=matched`);
    console.log(`[DASHBOARD_QUEUE_COUNT] count=${remaining}`);
  }

  const partnerPendingLink = partner.pendingLink ?? "";
  // expiresAt is set relative to when links are revealed; we store a generous window here
  const expiresAt = new Date(now.getTime() + 20 * 60 * 1000);
  const readyTimeoutAt = new Date(now.getTime() + READY_TIMEOUT_MS);

  // Create Match (pending_ready status — links NOT revealed yet) and MatchHistory in parallel
  const pairKey = [currentTelegramId, partner.telegramId].sort((a, b) => a - b).join(":");
  const [matchDoc] = await Promise.all([
    Match.create({
      _id: matchObjectId,
      user1Id: currentTelegramId,
      user2Id: partner.telegramId,
      link1: pendingLink,
      link2: partnerPendingLink,
      status: "pending_ready",
      expiresAt,
      readyTimeoutAt,
    }),
    MatchHistory.create({
      userIdA: currentTelegramId,
      userIdB: partner.telegramId,
      pairKey,
      matchedAt: now,
    }),
  ]);

  const currentUser = await User.findOne({ telegramId: currentTelegramId }).select("tiktokUsername");
  console.log(`[MATCH_PENDING_READY_CREATED] matchId=${matchId} | userA=${currentTelegramId} (@${currentUser?.tiktokUsername}) | userB=${partner.telegramId} (@${partner.tiktokUsername}) — awaiting ready confirmations.`);
  console.log(`[MATCH_HISTORY_CREATED] pairKey=${pairKey} matchedAt=${now.toISOString()}`);

  const readyButtons = Markup.inlineKeyboard([
    [Markup.button.callback("✅ Ready To Cut", `ready_to_cut:${matchId}`)],
    [Markup.button.callback("❌ Cancel", `cancel_ready:${matchId}`)],
  ]);

  // Send confirmation message — do NOT reveal cut links yet
  await Promise.all([
    bot.telegram.sendMessage(
      currentTelegramId,
      `🎯 Cut buddy found!\n\nPartner found.\nBefore links are revealed, both users must confirm they are active now.`,
      { ...readyButtons },
    ),
    bot.telegram.sendMessage(
      partner.telegramId,
      `🎯 Cut buddy found!\n\nPartner found.\nBefore links are revealed, both users must confirm they are active now.`,
      { ...readyButtons },
    ),
  ]);

  // Start 60-second ready timeout — if neither/one user confirms, cancel without punishment
  console.log(`[READY_TIMEOUT_STARTED] matchId=${matchId} — 60-second ready timeout started.`);
  const readyTimer = setTimeout(async () => {
    console.log(`[READY_TIMEOUT_TRIGGERED] matchId=${matchId} — 60-second ready window elapsed.`);
    await handleReadyTimeout(bot, matchId, currentTelegramId, partner.telegramId);
  }, READY_TIMEOUT_MS);
  readyTimers.set(matchId, readyTimer);

  void startInactivityReminders(bot, matchId, currentTelegramId, "pending_ready");
  void startInactivityReminders(bot, matchId, partner.telegramId, "pending_ready");

  void matchDoc; // silence unused-var warning
  return true;
}

// Handles ready timeout — no punishment; auto-requeue users who had already pressed Ready
async function handleReadyTimeout(
  bot: Telegraf,
  matchId: string,
  user1Id: number,
  user2Id: number,
): Promise<void> {
  const match = await Match.findOne({ _id: matchId, status: "pending_ready" });
  if (!match) {
    console.log(`[READY_TIMEOUT_SKIPPED] matchId=${matchId} — match no longer pending_ready.`);
    return;
  }

  const cancelResult = await Match.findOneAndUpdate(
    { _id: matchId, status: "pending_ready" },
    { status: "cancelled" },
    { new: false },
  );
  if (!cancelResult) {
    console.log(`[READY_TIMEOUT_SKIPPED] matchId=${matchId} — match already activated, skipping cancel.`);
    return;
  }
  readyTimers.delete(matchId);

  console.log(`[READY_TIMEOUT_CANCELLED] matchId=${matchId} — 60-second window elapsed without both confirming. No punishment.`);

  stopInactivityReminders(matchId, user1Id);
  stopInactivityReminders(matchId, user2Id);

  for (const uid of [user1Id, user2Id]) {
    const user = await User.findOne({ telegramId: uid });
    if (!user) continue;
    if (!["pending_ready", "inqueue"].includes(user.state)) continue;

    await Queue.deleteOne({ telegramId: uid });

    const wasReady = uid === user1Id ? match.user1ReadyToCut : match.user2ReadyToCut;
    const storedLink = uid === user1Id ? match.link1 : match.link2;
    const userLink = user.pendingLink ?? storedLink;

    if (wasReady && userLink) {
      // This user had confirmed Ready — auto-requeue them for a new partner
      await User.updateOne(
        { telegramId: uid },
        { state: "awaiting_cut_link", isWaiting: false, queuedAt: null, activeMatchId: null },
      );
      console.log(`[READY_TIMEOUT_REQUEUE] telegramId=${uid} — was ready, auto-requeueing for new partner.`);
      try {
        await bot.telegram.sendMessage(
          uid,
          `⏰ Partner did not confirm in time.\n\n❌ Match expired. Searching for a new cut buddy...`,
        );
      } catch { /* user may have blocked bot */ }
      await addToQueue(bot, uid, userLink);
    } else {
      // This user had not pressed Ready yet (or no link) — just reset them
      await User.updateOne(
        { telegramId: uid },
        { state: "awaiting_cut_link", isWaiting: false, queuedAt: null, pendingLink: null, activeMatchId: null },
      );
      console.log(`[READY_TIMEOUT_RESET] telegramId=${uid} — had not confirmed ready, reset. No punishment.`);
      try {
        await bot.telegram.sendMessage(
          uid,
          `⏰ Ready confirmation timed out. No cooldown applied.\n\nSubmit a new cut link whenever you are ready to match again.`,
        );
      } catch { /* user may have blocked bot */ }
    }
  }

  console.log(`[MATCH_FULLY_TERMINATED] matchId=${matchId} — ready timeout, both users handled, no punishment.`);
}

// Add a user to the Queue collection and immediately attempt a match.
// This is the primary entry point into the queue — always tries matching right away
// so two users submitting links near-simultaneously find each other within seconds.
async function addToQueue(bot: Telegraf, telegramId: number, pendingLink: string): Promise<void> {
  const existing = await Queue.findOne({ telegramId });
  if (existing) {
    console.log(`[DUPLICATE_QUEUE_ENTRY_REMOVED] telegramId=${telegramId} — removed stale queue entry (pendingLink="${existing.pendingLink ?? "null"}")`);
  }
  await Queue.deleteOne({ telegramId });

  // Fetch user info to enrich the queue record for the admin dashboard
  const userInfo = await User.findOne({ telegramId }).select("telegramUsername tiktokUsername");
  const telegramUsername = userInfo?.telegramUsername ?? "";
  const tiktokUsername = userInfo?.tiktokUsername ?? "";

  const queuedAt = new Date();
  await Queue.create({
    telegramId,
    pendingLink,
    telegramUsername,
    telegramName: telegramUsername,
    tiktokUsername,
    status: "waiting",
    createdAt: queuedAt,
    updatedAt: queuedAt,
  });
  await User.updateOne({ telegramId }, { state: "inqueue", isWaiting: true, queuedAt, originalQueuedAt: queuedAt, pendingLink, activeMatchId: null });

  const queueSize = await Queue.countDocuments({ status: "waiting" });
  console.log(`[QUEUE_RECORD_CREATED] telegramId=${telegramId} tiktokUsername=@${tiktokUsername} telegramUsername=@${telegramUsername} tiktokLink="${pendingLink}" status=waiting`);
  console.log(`[USER_QUEUED] telegramId=${telegramId} entered queue. Queue size (waiting): ${queueSize}. Attempting immediate match...`);
  console.log(`[DASHBOARD_QUEUE_COUNT] count=${queueSize}`);

  // Immediately attempt to match — catches the case where another user entered the queue
  // between this user's initial tryMatchAtomic call and now (the race-condition window).
  const matched = await tryMatchAtomic(bot, telegramId, pendingLink);
  if (matched) {
    console.log(`[IMMEDIATE_QUEUE_MATCH] telegramId=${telegramId} — matched immediately after joining queue.`);
  } else {
    const remaining = await Queue.countDocuments({ status: "waiting" });
    console.log(`[QUEUE_WAITING] telegramId=${telegramId} — no partner yet. ${remaining} user(s) in queue. Waiting for next submission or scheduler.`);
    console.log(`[DASHBOARD_QUEUE_COUNT] count=${remaining}`);
  }
}

// Requeue an innocent/remaining user after a match failure.
// Restores their original FIFO priority if available, then immediately attempts a new atomic match.
async function requeueUser(bot: Telegraf, telegramId: number, pendingLink: string): Promise<void> {
  const user = await User.findOne({ telegramId }).select("originalQueuedAt tiktokUsername telegramUsername");
  if (!user) return;

  // Never requeue banned or cooldown users
  const sus = await checkSuspension(telegramId);
  if (sus.suspended) {
    console.log(`[REQUEUE_SKIPPED_COOLDOWN] telegramId=${telegramId} (@${user.tiktokUsername}) — requeue skipped (suspended/banned).`);
    await User.updateOne({ telegramId }, { state: "awaiting_cut_link", isWaiting: false, queuedAt: null, activeMatchId: null });
    return;
  }

  const originalQueuedAt = user.originalQueuedAt ?? null;
  const queuedAt = originalQueuedAt ?? new Date();
  const restoredPriority = originalQueuedAt !== null;
  const telegramUsername = user.telegramUsername ?? "";
  const tiktokUsername = user.tiktokUsername ?? "";

  // Re-insert into Queue with the original createdAt to preserve FIFO position
  await Queue.deleteOne({ telegramId });
  await Queue.create({
    telegramId,
    pendingLink,
    telegramUsername,
    telegramName: telegramUsername,
    tiktokUsername,
    status: "waiting",
    createdAt: queuedAt,
    updatedAt: new Date(),
  });
  await User.updateOne(
    { telegramId },
    { state: "inqueue", isWaiting: true, queuedAt, pendingLink, activeMatchId: null },
  );

  const queueSize = await Queue.countDocuments({ status: "waiting" });
  console.log(`[QUEUE_RECORD_CREATED] telegramId=${telegramId} tiktokUsername=@${tiktokUsername} (requeue) status=waiting`);
  console.log(`[DASHBOARD_QUEUE_COUNT] count=${queueSize}`);

  if (restoredPriority) {
    console.log(`[ORIGINAL_QUEUE_PRIORITY_RESTORED] telegramId=${telegramId} (@${user.tiktokUsername}) requeued with original queuedAt=${queuedAt.toISOString()}`);
  }
  console.log(`[PARTNER_REQUEUED] telegramId=${telegramId} (@${user.tiktokUsername}) requeued after match failure. originalPriority=${restoredPriority} queuedAt=${queuedAt.toISOString()}`);

  // Immediately try to claim a new partner
  console.log(`[REQUEUE_MATCH_RETRY] telegramId=${telegramId} — triggering atomic match attempt after requeue.`);
  await tryMatchAtomic(bot, telegramId, pendingLink);
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
  // Clear any pending proof timers and reminders for both participants
  for (const uid of [match.user1Id, match.user2Id]) {
    const ptKey = `proof:${matchId}:${uid}`;
    const pt = proofTimers.get(ptKey);
    if (pt) { clearTimeout(pt); proofTimers.delete(ptKey); }
    const rKey = `proof_reminder:${matchId}:${uid}`;
    const rt = proofReminderTimers.get(rKey);
    if (rt) { clearTimeout(rt); proofReminderTimers.delete(rKey); }
    stopInactivityReminders(matchId, uid);
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
          proofCutByUsername: null,
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

  // Admin notification — swap completed
  try {
    const [uA, uB] = await Promise.all([
      User.findOne({ telegramId: match.user1Id }).select("telegramUsername tiktokUsername"),
      User.findOne({ telegramId: match.user2Id }).select("telegramUsername tiktokUsername"),
    ]);
    const mytime = new Date().toLocaleString("en-MY", {
      timeZone: "Asia/Kuala_Lumpur",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
      hour12: false,
    });
    const adminMsg =
      `✅ SWAP COMPLETED!\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `User A:\n` +
      `• Telegram: @${uA?.telegramUsername || "N/A"}\n` +
      `• TikTok: @${uA?.tiktokUsername || "N/A"}\n` +
      `• ID: ${match.user1Id}\n\n` +
      `User B:\n` +
      `• Telegram: @${uB?.telegramUsername || "N/A"}\n` +
      `• TikTok: @${uB?.tiktokUsername || "N/A"}\n` +
      `• ID: ${match.user2Id}\n\n` +
      `• Time: ${mytime} MYT\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `Both users completed proof approval successfully 🤝✨`;
    for (const adminId of getAdminIds()) {
      try {
        await bot.telegram.sendMessage(adminId, adminMsg);
        console.log(`[ADMIN_SWAP_COMPLETED_NOTIFIED] matchId=${matchId} notified adminId=${adminId}`);
      } catch (err) {
        console.error(`[ADMIN_MATCH_RESULT_NOTIFY_FAILED] matchId=${matchId} adminId=${adminId}: ${(err as Error).message}`);
      }
    }
  } catch (err) {
    console.error(`[ADMIN_MATCH_RESULT_NOTIFY_FAILED] matchId=${matchId} swap-completed fetch error: ${(err as Error).message}`);
  }

  // Social proof broadcast — single combined notification to all bystanders
  try {
    const [pA, pB] = await Promise.all([
      User.findOne({ telegramId: match.user1Id }).select("telegramUsername"),
      User.findOne({ telegramId: match.user2Id }).select("telegramUsername"),
    ]);
    const maskUsername = (username?: string | null): string => {
      if (!username || username.trim() === "") return "Someone cute ✨";
      const clean = username.replace(/^@/, "");
      return `@${clean.slice(0, 2)}*****`;
    };
    const maskedA = maskUsername(pA?.telegramUsername);
    const maskedB = maskUsername(pB?.telegramUsername);
    const socialMsg =
      `🎉 Another cut swap just got completed 👀✨\n\n` +
      `Users:\n${maskedA}\n${maskedB}\n\n` +
      `More people are swapping right now 🔥`;

    const now = new Date();
    const bystanders = await User.find({
      telegramId: { $nin: [match.user1Id, match.user2Id] },
      tiktokUsername: { $nin: ["__pending__", ""] },
      isBanned: false,
      $and: [
        { $or: [{ suspendedUntil: null }, { suspendedUntil: { $lte: now } }] },
        { $or: [{ cancelCooldownUntil: null }, { cancelCooldownUntil: { $lte: now } }] },
      ],
    }).select("telegramId tiktokUsername");

    for (const u of bystanders) {
      try {
        await bot.telegram.sendMessage(u.telegramId, socialMsg);
        console.log(`[SWAP_COMPLETE_SOCIAL_PROOF_SENT] matchId=${matchId} → telegramId=${u.telegramId} (@${u.tiktokUsername})`);
      } catch {
        console.log(`[SWAP_COMPLETE_SOCIAL_PROOF_SKIPPED] matchId=${matchId} → telegramId=${u.telegramId} (@${u.tiktokUsername}) — send failed (blocked or unavailable)`);
      }
    }
  } catch (err) {
    console.error(`[SWAP_COMPLETE_SOCIAL_PROOF_SKIPPED] matchId=${matchId} — broadcast aborted: ${(err as Error).message}`);
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

    // Guard: user is mid-proof account selection — do NOT restart flow
    if (existingUser && existingUser.state === "awaiting_proof_account_selection") {
      console.log(`[PROOF_FLOW_COMMAND_BLOCKED] telegramId=${telegramId} — /start blocked during awaiting_proof_account_selection`);
      const registeredUsername = existingUser.tiktokUsername ?? "unknown";
      await ctx.reply(
        `Hii 👀✨\n\nWhich TikTok account did you use to cut your partner's link?\n\nExample:\n@username`,
        Markup.inlineKeyboard([
          [Markup.button.callback(`✅ Use registered account (@${registeredUsername})`, "proof_use_registered")],
          [Markup.button.callback("✍️ Enter another username", "proof_enter_other")],
          [Markup.button.callback("❌ Cancel", "proof_cancel_account_selection")],
        ]),
      );
      console.log(`[PROOF_ACCOUNT_SELECTION_RESENT] telegramId=${telegramId} — resent via /start block`);
      return;
    }

    // Guard: active match states — do NOT reset state or clear queue
    if (existingUser && (existingUser.state === "pending_ready" || existingUser.state === "in_match")) {
      await ctx.reply("⚠️ You have an active match in progress. Please complete or cancel it first before restarting.\n\nUse the buttons in your previous message.");
      return;
    }

    // Guard: proof submission stages — do NOT reset state
    if (existingUser && (
      existingUser.state === "awaiting_proof" ||
      existingUser.state === "awaiting_partner_approval" ||
      existingUser.state === "awaiting_proof_cut_username" ||
      existingUser.state === "awaiting_proof_account_selection"
    )) {
      await ctx.reply("⚠️ You are currently in the proof submission stage. Please complete it first.");
      return;
    }

    if (existingUser && existingUser.tiktokUsername && existingUser.tiktokUsername !== "__pending__") {
      const sus = await checkSuspension(telegramId);
      if (sus.suspended) {
        if (sus.reason === "banned") { console.log(`[BANNED_USER_BLOCKED_ACTION] telegramId=${telegramId} action=start`); }
        else { console.log(`[COOLDOWN_USER_BLOCKED_ACTION] telegramId=${telegramId} action=start`); }
        await ctx.reply(sus.message); return;
      }

      const firstName = ctx.from.first_name ?? "there";
      const tgUsername = existingUser.telegramUsername || ctx.from.username || "unknown";

      const now = new Date();
      const updatedTime = now.toUTCString().replace("GMT", "UTC");

      const totalUserCount = await User.countDocuments();
      console.log(`[REGISTERED_USER_COUNT_FETCHED] count=${totalUserCount}`);
      const displayCount = 200 + (totalUserCount * 3);
      console.log(`[TOTAL_ACTIVE_SOCIAL_PROOF_RENDERED] displayCount=${displayCount} (formula: 200 + (${totalUserCount} * 3))`);
      console.log(`[TOTAL_ACTIVE_SOCIAL_PROOF_INCREMENTED] totalUniqueUsers=${totalUserCount} displayCount=${displayCount}`);

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
        $setOnInsert: { pendingReferralCode: referralCode, adminJoinNotified: false },
      },
      { upsert: true, new: true },
    );

    if (isNewUser) {
      console.log(`[NEW_USER_CREATED] telegramId=${telegramId} (@${telegramUsername || "no_username"}) — brand-new user document created.`);
    } else {
      console.log(`[EXISTING_USER_DETECTED] telegramId=${telegramId} (@${telegramUsername || "no_username"}) — returning user with state=awaiting_tiktok_profile.`);
    }
    console.log(`[NEW_USER_AWAITING_PROFILE] telegramId=${telegramId} (@${telegramUsername || "no_username"}) — state set to awaiting_tiktok_profile.`);

    // Admin notification — strictly once per user, guarded by in-memory lock + atomic DB claim
    if (isNewUser) {
      // Guard 1: in-memory lock (same-process concurrent duplicate /start)
      if (newUserNotifyLocks.has(telegramId)) {
        console.log(`[DUPLICATE_ADMIN_NOTIFICATION_BLOCKED] telegramId=${telegramId} — in-memory lock already held, skipping admin notify.`);
      } else {
        newUserNotifyLocks.add(telegramId);
        try {
          // Guard 2: atomic DB claim — only succeeds if adminJoinNotified is still false
          const claimed = await User.updateOne(
            { telegramId, adminJoinNotified: false },
            { $set: { adminJoinNotified: true } },
          );

          if (claimed.modifiedCount === 0) {
            // Already notified (race condition caught at DB level)
            console.log(`[DUPLICATE_ADMIN_NOTIFICATION_BLOCKED] telegramId=${telegramId} — adminJoinNotified already true in DB, skipping.`);
          } else {
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
        } finally {
          newUserNotifyLocks.delete(telegramId);
        }
      }
    }

    await ctx.reply(
      "👋 Weh selamat datang ke *CutSquad*!\n\nBot ni untuk swap TikTok cut price links — kau cut gue, gue cut kau! 🔁\n\nHantar link profile TikTok kau 👇\n_(contoh: https://www.tiktok.com/@username)_",
      { parse_mode: "Markdown" },
    );
    await sendTutorialImage(bot, ctx.from.id);
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

  bot.command("debug_broadcast", async (ctx) => {
    if (!getAdminIds().includes(ctx.from.id)) { await ctx.reply("🚫 Unauthorized."); return; }

    const now = new Date();
    // All users who ever pressed /start
    const allStartedUsers = await User.find({}).select("telegramId tiktokUsername isBanned suspendedUntil cancelCooldownUntil");
    const registeredUsers = allStartedUsers.filter(u => u.tiktokUsername && u.tiktokUsername !== "__pending__" && u.tiktokUsername !== "");

    let eligible = 0;
    let skippedBanned = 0;
    let skippedCooldown = 0;

    for (const u of allStartedUsers) {
      if (u.isBanned) { skippedBanned++; continue; }
      const onCooldown = (u.suspendedUntil && u.suspendedUntil > now) || (u.cancelCooldownUntil && u.cancelCooldownUntil > now);
      if (onCooldown) { skippedCooldown++; continue; }
      eligible++;
    }

    const lastTs = lastBroadcastStats.ts
      ? new Date(lastBroadcastStats.ts).toLocaleString("en-MY", { timeZone: "Asia/Kuala_Lumpur", hour12: false })
      : "Never";

    const lastSubmitTime = lastBroadcastStats.submitTime
      ? new Date(lastBroadcastStats.submitTime).toLocaleString("en-MY", { timeZone: "Asia/Kuala_Lumpur", hour12: false })
      : "N/A";

    const msg =
      `📊 *Broadcast Debug*\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `*Total users who pressed /start:* ${allStartedUsers.length}\n` +
      `*Users with TikTok profile registered:* ${registeredUsers.length}\n` +
      `*Eligible broadcast receivers:* ${eligible}\n` +
      `*Skipped — banned:* ${skippedBanned}\n` +
      `*Skipped — cooldown:* ${skippedCooldown}\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `*Last broadcast:*\n` +
      `• Sender: @${lastBroadcastStats.senderTikTok || "N/A"}\n` +
      `• Cut link: ${lastBroadcastStats.cutLink || "N/A"}\n` +
      `• Submit time: ${lastSubmitTime} MYT\n` +
      `• Trigger source: ${lastBroadcastStats.triggerSource || "N/A"}\n` +
      `• Total users: ${lastBroadcastStats.total}\n` +
      `• Eligible: ${lastBroadcastStats.eligible}\n` +
      `• Sent: ${lastBroadcastStats.sent}\n` +
      `• Failed: ${lastBroadcastStats.failed}\n` +
      `• Skipped self: ${lastBroadcastStats.skippedSelf}\n` +
      `• Skipped banned: ${lastBroadcastStats.skippedBanned}\n` +
      `• Skipped cooldown: ${lastBroadcastStats.skippedCooldown}\n` +
      `• Broadcast time: ${lastTs} MYT`;

    console.log(`[DEBUG_BROADCAST] Admin telegramId=${ctx.from.id} — started=${allStartedUsers.length} registered=${registeredUsers.length} eligible=${eligible}`);
    await ctx.reply(msg, { parse_mode: "Markdown" });
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

    // Cancel any active or pending_ready match for this user
    const activeMatch = await Match.findOne({
      $or: [{ user1Id: telegramId }, { user2Id: telegramId }],
      status: { $in: ["active", "pending_ready"] },
    });
    if (activeMatch) {
      await Match.updateOne({ _id: activeMatch._id }, { status: "cancelled" });
      const timerId = activeMatch._id.toString();
      const existingTimer = matchTimers.get(timerId);
      if (existingTimer) { clearTimeout(existingTimer); matchTimers.delete(timerId); }
      const existingReadyTimer = readyTimers.get(timerId);
      if (existingReadyTimer) { clearTimeout(existingReadyTimer); readyTimers.delete(timerId); }
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

    const activeMatch = await Match.findOne({ $or: [{ user1Id: targetId }, { user2Id: targetId }], status: { $in: ["active", "pending_ready"] } });
    if (activeMatch) {
      await Match.updateOne({ _id: activeMatch._id }, { status: "cancelled" });
      const timerId = activeMatch._id.toString();
      const t = matchTimers.get(timerId);
      if (t) { clearTimeout(t); matchTimers.delete(timerId); }
      const rt = readyTimers.get(timerId);
      if (rt) { clearTimeout(rt); readyTimers.delete(timerId); }
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

  bot.command("block", async (ctx) => {
    if (!getAdminIds().includes(ctx.from.id)) { await ctx.reply("🚫 Unauthorized."); return; }

    const args = ctx.message.text.split(/\s+/).slice(1);
    if (args.length === 0) { await ctx.reply("ℹ️ Usage: `/block USER_ID`", { parse_mode: "Markdown" }); return; }

    const targetId = parseInt(args[0]!, 10);
    if (isNaN(targetId)) { await ctx.reply("❌ Invalid USER_ID."); return; }

    const user = await User.findOne({ telegramId: targetId });
    if (!user) { await ctx.reply(`❌ User ${targetId} not found.`); return; }

    try {
      await User.updateOne({ telegramId: targetId }, { isBanned: true, state: "idle", isWaiting: false, queuedAt: null, pendingLink: null, activeMatchId: null });
      await Queue.deleteOne({ telegramId: targetId });

      const activeMatch = await Match.findOne({ $or: [{ user1Id: targetId }, { user2Id: targetId }], status: { $in: ["active", "pending_ready"] } });
      if (activeMatch) {
        await Match.updateOne({ _id: activeMatch._id }, { status: "cancelled" });
        const timerId = activeMatch._id.toString();
        const t = matchTimers.get(timerId);
        if (t) { clearTimeout(t); matchTimers.delete(timerId); }
        const rt = readyTimers.get(timerId);
        if (rt) { clearTimeout(rt); readyTimers.delete(timerId); }
        const partnerId = activeMatch.user1Id === targetId ? activeMatch.user2Id : activeMatch.user1Id;
        const partner = await User.findOne({ telegramId: partnerId });
        try { await bot.telegram.sendMessage(partnerId, "⚠️ *Partner anda telah di-ban oleh admin.*\nSistem sedang mencari partner baru untuk anda 🤝", { parse_mode: "Markdown" }); } catch {}
        if (partner?.pendingLink) { await addToQueue(bot, partnerId, partner.pendingLink); }
        else { await User.updateOne({ telegramId: partnerId }, { state: "awaiting_cut_link", isWaiting: false, queuedAt: null }); }
      }

      console.log(`[ADMIN_USER_BLOCKED] telegramId=${targetId} (@${user.tiktokUsername}) blocked by admin telegramId=${ctx.from.id}.`);
      try { await bot.telegram.sendMessage(targetId, "🚫 Your account has been permanently blocked by admin."); } catch {}
      await ctx.reply(`✅ User has been permanently blocked.\n\nUser ID: ${targetId}`);
    } catch (err) {
      console.error(`[ADMIN_MODERATION_FAILED] /block targetId=${targetId}: ${(err as Error).message}`);
      await ctx.reply("❌ Failed to block user. Check logs.");
    }
  });

  bot.command("cooldown24", async (ctx) => {
    if (!getAdminIds().includes(ctx.from.id)) { await ctx.reply("🚫 Unauthorized."); return; }

    const args = ctx.message.text.split(/\s+/).slice(1);
    if (args.length === 0) { await ctx.reply("ℹ️ Usage: `/cooldown24 USER_ID`", { parse_mode: "Markdown" }); return; }

    const targetId = parseInt(args[0]!, 10);
    if (isNaN(targetId)) { await ctx.reply("❌ Invalid USER_ID."); return; }

    const user = await User.findOne({ telegramId: targetId });
    if (!user) { await ctx.reply(`❌ User ${targetId} not found.`); return; }

    try {
      const cooldownUntil = new Date(Date.now() + 24 * 60 * 60 * 1000);
      await User.updateOne(
        { telegramId: targetId },
        { cancelCooldownUntil: cooldownUntil, state: "idle", isWaiting: false, queuedAt: null, pendingLink: null, activeMatchId: null },
      );
      await Queue.deleteOne({ telegramId: targetId });

      const activeMatch = await Match.findOne({ $or: [{ user1Id: targetId }, { user2Id: targetId }], status: { $in: ["active", "pending_ready"] } });
      if (activeMatch) {
        await Match.updateOne({ _id: activeMatch._id }, { status: "cancelled" });
        const timerId = activeMatch._id.toString();
        const t = matchTimers.get(timerId);
        if (t) { clearTimeout(t); matchTimers.delete(timerId); }
        const rt = readyTimers.get(timerId);
        if (rt) { clearTimeout(rt); readyTimers.delete(timerId); }
        const partnerId = activeMatch.user1Id === targetId ? activeMatch.user2Id : activeMatch.user1Id;
        const partner = await User.findOne({ telegramId: partnerId });
        try { await bot.telegram.sendMessage(partnerId, "⚠️ *Partner anda telah dikenakan cooldown oleh admin.*\nSistem sedang mencari partner baru untuk anda 🤝", { parse_mode: "Markdown" }); } catch {}
        if (partner?.pendingLink) { await addToQueue(bot, partnerId, partner.pendingLink); }
        else { await User.updateOne({ telegramId: partnerId }, { state: "awaiting_cut_link", isWaiting: false, queuedAt: null }); }
      }

      console.log(`[ADMIN_USER_COOLDOWN_24H] telegramId=${targetId} (@${user.tiktokUsername}) placed on 24h cooldown by admin telegramId=${ctx.from.id} until ${cooldownUntil.toISOString()}.`);
      try { await bot.telegram.sendMessage(targetId, "⏳ Your account has been placed on 24h cooldown by admin."); } catch {}
      await ctx.reply(`✅ User has been placed on 24h cooldown.\n\nUser ID: ${targetId}`);
    } catch (err) {
      console.error(`[ADMIN_MODERATION_FAILED] /cooldown24 targetId=${targetId}: ${(err as Error).message}`);
      await ctx.reply("❌ Failed to apply cooldown. Check logs.");
    }
  });

  bot.command("unblock", async (ctx) => {
    if (!getAdminIds().includes(ctx.from.id)) { await ctx.reply("🚫 Unauthorized."); return; }

    const args = ctx.message.text.split(/\s+/).slice(1);
    if (args.length === 0) { await ctx.reply("ℹ️ Usage: `/unblock USER_ID`", { parse_mode: "Markdown" }); return; }

    const targetId = parseInt(args[0]!, 10);
    if (isNaN(targetId)) { await ctx.reply("❌ Invalid USER_ID."); return; }

    const user = await User.findOne({ telegramId: targetId });
    if (!user) { await ctx.reply(`❌ User ${targetId} not found.`); return; }
    if (!user.isBanned) { await ctx.reply(`⚠️ User ${targetId} is not currently blocked.`); return; }

    try {
      await User.updateOne({ telegramId: targetId }, { isBanned: false, isFlagged: false, state: "awaiting_cut_link" });

      console.log(`[ADMIN_USER_UNBLOCKED] telegramId=${targetId} (@${user.tiktokUsername}) unblocked by admin telegramId=${ctx.from.id}.`);
      try { await bot.telegram.sendMessage(targetId, "✅ Your account has been unblocked by admin."); } catch {}
      await ctx.reply(`✅ User has been unblocked successfully.\n\nUser ID: ${targetId}`);
    } catch (err) {
      console.error(`[ADMIN_MODERATION_FAILED] /unblock targetId=${targetId}: ${(err as Error).message}`);
      await ctx.reply("❌ Failed to unblock user. Check logs.");
    }
  });

  bot.command("uncooldown", async (ctx) => {
    if (!getAdminIds().includes(ctx.from.id)) { await ctx.reply("🚫 Unauthorized."); return; }

    const args = ctx.message.text.split(/\s+/).slice(1);
    if (args.length === 0) { await ctx.reply("ℹ️ Usage: `/uncooldown USER_ID`", { parse_mode: "Markdown" }); return; }

    const targetId = parseInt(args[0]!, 10);
    if (isNaN(targetId)) { await ctx.reply("❌ Invalid USER_ID."); return; }

    const user = await User.findOne({ telegramId: targetId });
    if (!user) { await ctx.reply(`❌ User ${targetId} not found.`); return; }

    try {
      await User.updateOne(
        { telegramId: targetId },
        { $unset: { cancelCooldownUntil: "", suspendedUntil: "" } },
      );

      console.log(`[ADMIN_USER_UNCOOLDOWNED] telegramId=${targetId} (@${user.tiktokUsername}) cooldown cleared by admin telegramId=${ctx.from.id}.`);
      try { await bot.telegram.sendMessage(targetId, "✅ Your cooldown has been removed by admin."); } catch {}
      await ctx.reply(`✅ User cooldown has been removed.\n\nUser ID: ${targetId}`);
    } catch (err) {
      console.error(`[ADMIN_MODERATION_FAILED] /uncooldown targetId=${targetId}: ${(err as Error).message}`);
      await ctx.reply("❌ Failed to remove cooldown. Check logs.");
    }
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
    const adminId = ctx.from.id;
    if (!getAdminIds().includes(adminId)) { await ctx.reply("🚫 Unauthorized."); return; }

    const inlineText = ctx.message.text.replace(/^\/broadcast\s*/i, "").trim();

    if (!inlineText) {
      // Two-step flow: enter awaiting state
      adminBroadcastPending.add(adminId);
      console.log(`[BROADCAST_FLOW_STARTED] adminId=${adminId} — awaiting broadcast message input.`);
      await ctx.reply("📢 Send the announcement message you want to broadcast.\n\nType /cancel to cancel.");
      return;
    }

    // Inline shortcut: /broadcast your message here
    await executeBroadcast(bot, ctx.chat.id, adminId, inlineText);
  });

  async function executeBroadcast(bot: Telegraf, chatId: number, adminId: number, text: string): Promise<void> {
    console.log(`[BROADCAST_MESSAGE_RECEIVED] adminId=${adminId} message="${text.slice(0, 80)}"`);

    const users = await User.find({ isBanned: false }).select("telegramId");
    if (users.length === 0) {
      await bot.telegram.sendMessage(chatId, "⚠️ No users found.");
      return;
    }

    const statusMsg = await bot.telegram.sendMessage(chatId, `📡 Sending to ${users.length} user(s)…`);
    let sent = 0;
    let failed = 0;

    for (const u of users) {
      try {
        await bot.telegram.sendMessage(u.telegramId, text);
        sent++;
        console.log(`[BROADCAST_SENT_TO_USER] telegramId=${u.telegramId}`);
      } catch (err) {
        failed++;
        console.error(`[BROADCAST_SEND_FAILED] telegramId=${u.telegramId}: ${(err as Error).message}`);
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }

    await bot.telegram.editMessageText(
      chatId,
      statusMsg.message_id,
      undefined,
      `✅ Broadcast complete!\n\n📨 Sent: ${sent}\n❌ Failed: ${failed}\n👥 Total: ${users.length}`,
    );
    console.log(`[BROADCAST_FINISHED] adminId=${adminId} — sent=${sent} failed=${failed} total=${users.length}`);
  }

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
      pending_ready: "🎯 Partner found — confirm ready",
      in_match: "🤝 In match",
      awaiting_proof_account_selection: "🔍 Pilih akaun bukti",
      awaiting_proof_cut_username: "✍️ Masukkan username",
      awaiting_proof: "📸 Menunggu bukti",
      awaiting_partner_approval: "⏳ Menunggu kelulusan partner",
      awaiting_reject_reason: "✍️ Masukkan sebab tolak",
    };
    await ctx.reply(
      `📊 *Status kau:*\n\nTikTok: @${user.tiktokUsername}\nCut baki: ${user.cutBalance}\nStrikes: ${user.strikes}/3\nStatus: ${statusMap[user.state] ?? user.state}`,
      { parse_mode: "Markdown" },
    );
  });

  bot.command("debug_queue_reasons", async (ctx) => {
    if (!getAdminIds().includes(ctx.from.id)) { await ctx.reply("🚫 Unauthorized."); return; }

    const queuedUsers = await User.find({ state: "inqueue", isWaiting: true }).sort({ queuedAt: 1 });

    if (queuedUsers.length === 0) {
      await ctx.reply("✅ Queue is empty — no users waiting.");
      return;
    }

    const now = new Date();
    const since = new Date(now.getTime() - COOLDOWN_MS);

    const lines = await Promise.all(queuedUsers.map(async (user, i) => {
      const { telegramId, tiktokUsername, pendingLink, queuedAt, isBanned, suspendedUntil, activeMatchId } = user;
      const ageMin = queuedAt ? Math.round((Date.now() - queuedAt.getTime()) / (1000 * 60)) : "?";

      const reasons: string[] = [];

      if (isBanned) reasons.push("BANNED");
      if (suspendedUntil && suspendedUntil > now) reasons.push("COOLDOWN");
      if (!pendingLink) reasons.push("STALE_QUEUE");

      if (activeMatchId) {
        const activeMatch = await Match.findOne({ _id: activeMatchId, status: { $in: ["active", "pending_ready"] } });
        if (activeMatch) reasons.push(activeMatch.status === "pending_ready" ? "PENDING_READY_MATCH" : "ACTIVE_MATCH");
      }

      // Build 24h exclusion set for this user
      const recentHistory = await MatchHistory.find({
        $or: [{ userIdA: telegramId }, { userIdB: telegramId }],
        matchedAt: { $gte: since },
      }).select("userIdA userIdB");
      const excludedIds = new Set(recentHistory.map(h => h.userIdA === telegramId ? h.userIdB : h.userIdA));

      if (reasons.length === 0) {
        const otherQueued = queuedUsers.filter(u => u.telegramId !== telegramId);
        const eligible = otherQueued.filter(u =>
          !u.isBanned &&
          !(u.suspendedUntil && u.suspendedUntil > now) &&
          u.pendingLink &&
          !excludedIds.has(u.telegramId),
        );
        if (otherQueued.length > 0 && eligible.length === 0) {
          const allBlockedBy24h = otherQueued.every(u => excludedIds.has(u.telegramId));
          reasons.push(allBlockedBy24h ? "RECENT_PAIR_24H" : "NO_ELIGIBLE_PARTNER");
        } else if (otherQueued.length === 0) {
          reasons.push("NO_ELIGIBLE_PARTNER");
        }
      }

      const reasonStr = reasons.length > 0 ? reasons.join(", ") : "ELIGIBLE — retry pending";

      return (
        `${i + 1}. @${tiktokUsername} (${telegramId})\n` +
        `   In queue: ${ageMin} min | pendingLink: ${pendingLink ? "SET" : "NULL"}\n` +
        `   Excluded 24h pairs: ${excludedIds.size}\n` +
        `   Reason: ${reasonStr}`
      );
    }));

    const header = `🔍 *Queue Reasons (${queuedUsers.length} user(s)):*\n\n`;
    const body = lines.join("\n\n");
    const full = header + body;

    if (full.length <= 4000) {
      await ctx.reply(full, { parse_mode: "Markdown" });
    } else {
      await ctx.reply(header + `(sending in chunks)`, { parse_mode: "Markdown" });
      for (const line of lines) {
        await ctx.reply(line);
      }
    }
  });

  bot.command("retry_queue_matching", async (ctx) => {
    if (!getAdminIds().includes(ctx.from.id)) { await ctx.reply("🚫 Unauthorized."); return; }

    const queueSize = await User.countDocuments({ state: "inqueue", isWaiting: true });
    if (queueSize === 0) {
      await ctx.reply("✅ Queue is empty — nothing to retry.");
      return;
    }

    await ctx.reply(`🔄 Retrying queue matching for ${queueSize} user(s)...`);

    try {
      const { matched, reasons } = await retryQueueMatchingInternal(bot);

      const reasonSummary = new Map<string, number>();
      for (const reason of reasons.values()) {
        reasonSummary.set(reason, (reasonSummary.get(reason) ?? 0) + 1);
      }
      const reasonLines = [...reasonSummary.entries()]
        .filter(([reason]) => reason !== "ALREADY_MATCHED")
        .map(([reason, count]) => `  • ${reason}: ${count}`)
        .join("\n");

      await ctx.reply(
        `✅ Queue retry complete.\n\nMatched: ${matched}\nStill waiting: ${reasons.size - (reasonSummary.get("ALREADY_MATCHED") ?? 0)}\n` +
        (reasonLines ? `\nReasons not matched:\n${reasonLines}` : ""),
      );
    } catch (err) {
      console.error(`[RETRY_QUEUE_MATCHING_ADMIN_FAILED] ${(err as Error).message}`);
      await ctx.reply(`❌ Retry failed: ${(err as Error).message}`);
    }
  });

  bot.command("clear_stuck_matches", async (ctx) => {
    if (!getAdminIds().includes(ctx.from.id)) { await ctx.reply("🚫 Unauthorized."); return; }

    await ctx.reply("🔄 Running stuck cleanup...");

    try {
      const { clearedMatches, clearedQueue, clearedProof } = await performStuckCleanup(bot);
      await ctx.reply(
        `✅ Stuck cleanup completed.\n\nCleared matches: ${clearedMatches}\nCleared queue users: ${clearedQueue}\nCleared proof states: ${clearedProof}`,
      );
    } catch (err) {
      console.error(`[STUCK_CLEANUP_ADMIN_FAILED] ${(err as Error).message}`);
      await ctx.reply(`❌ Cleanup failed: ${(err as Error).message}`);
    }
  });

  bot.command("fix_stale_users", async (ctx) => {
    if (!getAdminIds().includes(ctx.from.id)) { await ctx.reply("🚫 Unauthorized."); return; }
    console.log(`[FIX_STALE_USERS_COMMAND_RUN] by adminId=${ctx.from.id}`);

    let usersFixed = 0;
    let queueRemoved = 0;
    let orphanMatchesCleared = 0;

    try {
      // 1. Users with activeMatchId pointing to a non-active/non-pending_ready match
      const usersWithMatchId = await User.find({ activeMatchId: { $ne: null } }).select("telegramId activeMatchId state");
      for (const u of usersWithMatchId) {
        const match = await Match.findOne({ _id: u.activeMatchId, status: { $in: ["active", "pending_ready"] } });
        if (!match) {
          console.log(`[STALE_USER_STATE_DETECTED] telegramId=${u.telegramId} has stale activeMatchId=${u.activeMatchId} state=${u.state}`);
          await User.updateOne(
            { telegramId: u.telegramId },
            { activeMatchId: null, isWaiting: false, queuedAt: null, pendingLink: null, state: "awaiting_cut_link", proofCutByUsername: null },
          );
          await Queue.deleteOne({ telegramId: u.telegramId });
          console.log(`[STALE_USER_STATE_CLEANED] telegramId=${u.telegramId}`);
          usersFixed++;
        }
      }

      // 2. Queue entries with missing or null pendingLink
      const orphanQueue = await Queue.find({ $or: [{ pendingLink: null }, { pendingLink: "" }] }).select("telegramId");
      for (const q of orphanQueue) {
        await Queue.deleteOne({ telegramId: q.telegramId });
        await User.updateOne(
          { telegramId: q.telegramId },
          { isWaiting: false, queuedAt: null, pendingLink: null, state: "awaiting_cut_link", activeMatchId: null, proofCutByUsername: null },
        );
        console.log(`[ORPHAN_QUEUE_ENTRY_REMOVED] telegramId=${q.telegramId} — queue entry had no pendingLink`);
        queueRemoved++;
      }

      // 3. Users stuck in match states but no valid active match exists for them
      const matchStates = ["pending_ready", "in_match", "awaiting_proof_account_selection", "awaiting_proof_cut_username", "awaiting_proof", "awaiting_partner_approval", "awaiting_reject_reason"];
      const stuckUsers = await User.find({ state: { $in: matchStates }, activeMatchId: null }).select("telegramId state");
      for (const u of stuckUsers) {
        console.log(`[STALE_USER_STATE_DETECTED] telegramId=${u.telegramId} stuck in state=${u.state} with no activeMatchId`);
        await User.updateOne(
          { telegramId: u.telegramId },
          { state: "awaiting_cut_link", isWaiting: false, queuedAt: null, pendingLink: null, activeMatchId: null, proofCutByUsername: null },
        );
        await Queue.deleteOne({ telegramId: u.telegramId });
        console.log(`[STALE_USER_STATE_CLEANED] telegramId=${u.telegramId}`);
        usersFixed++;
      }

      // 4. Matches marked active but expired (expiresAt in the past)
      const expiredActiveMatches = await Match.find({ status: "active", expiresAt: { $lt: new Date() } }).select("_id user1Id user2Id");
      for (const m of expiredActiveMatches) {
        await Match.updateOne({ _id: m._id }, { status: "expired" });
        console.log(`[ORPHAN_MATCH_CLEARED] matchId=${m._id} — active match past expiresAt, marked expired`);
        orphanMatchesCleared++;
      }

      await ctx.reply(
        `✅ Stale user cleanup completed.\n\nUsers fixed: ${usersFixed}\nQueue entries removed: ${queueRemoved}\nOrphan matches cleared: ${orphanMatchesCleared}`,
      );
      console.log(`[FIX_STALE_USERS_COMMAND_DONE] usersFixed=${usersFixed} queueRemoved=${queueRemoved} orphanMatchesCleared=${orphanMatchesCleared}`);
    } catch (err) {
      console.error(`[FIX_STALE_USERS_COMMAND_FAILED] ${(err as Error).message}`);
      await ctx.reply(`❌ Fix stale users failed: ${(err as Error).message}`);
    }
  });

  bot.on(message("photo"), async (ctx) => {
    const telegramId = ctx.from.id;
    console.log(`[MSG] photo from telegramId=${telegramId}`);

    const sus = await checkSuspension(telegramId);
    if (sus.suspended) {
      if (sus.reason === "banned") { console.log(`[BANNED_USER_BLOCKED_ACTION] telegramId=${telegramId} action=photo`); }
      else { console.log(`[COOLDOWN_USER_BLOCKED_ACTION] telegramId=${telegramId} action=photo`); }
      await ctx.reply(sus.message); return;
    }

    await checkAndApplyDailyReset(bot, telegramId);

    const user = await User.findOne({ telegramId });
    if (!user || user.tiktokUsername === "__pending__") {
      await ctx.reply("Kau belum register lagi. Taip /start dulu k!");
      return;
    }

    if (user.state === "pending_ready") {
      await ctx.reply("👉 Please press ✅ Ready To Cut or ❌ Cancel Match using the buttons above first.");
      return;
    }

    if (user.state === "in_match") {
      await ctx.reply("Sila tekan butang *✅ Done Cut* dahulu sebelum menghantar bukti ya.", { parse_mode: "Markdown" });
      return;
    }

    if (user.state === "awaiting_proof_account_selection") {
      await ctx.reply("Sila pilih akaun TikTok yang anda gunakan dahulu 👆✨");
      return;
    }

    if (user.state === "awaiting_proof_cut_username") {
      await ctx.reply("Sila taip username TikTok yang anda gunakan dahulu ✍️");
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

    const freshUser = await User.findOne({ telegramId }).select("proofCutByUsername");
    const proofCutByUsername = freshUser?.proofCutByUsername ?? null;

    if (isUser1) {
      await Match.updateOne({ _id: match._id }, {
        user1ProofSubmitted: true,
        user1ProofMessageId: proofMessageId,
        user1ProofSubmittedAt: now,
        user1Confirmed: true,
        user1ProofCutByUsername: proofCutByUsername,
      });
    } else {
      await Match.updateOne({ _id: match._id }, {
        user2ProofSubmitted: true,
        user2ProofMessageId: proofMessageId,
        user2ProofSubmittedAt: now,
        user2Confirmed: true,
        user2ProofCutByUsername: proofCutByUsername,
      });
    }

    console.log(`[PROOF_SUBMITTED] telegramId=${telegramId} submitted proof for matchId=${matchId} proofCutByUsername=${proofCutByUsername ?? "null"}.`);
    await User.updateOne({ telegramId }, { state: "awaiting_partner_approval", proofCutByUsername: null });
    await ctx.reply("✅ Proof received successfully!\n\nYour cut buddy is checking it now 👀✨");

    stopInactivityReminders(matchId, telegramId);
    const isUser1ForApproval = isUser1;
    void startInactivityReminders(bot, matchId, partnerId, "awaiting_partner_approval", async (mid) => {
      const m = await Match.findOne({ _id: mid, status: "active" });
      if (!m) return false;
      return isUser1ForApproval ? !m.user1ProofApprovedByPartner : !m.user2ProofApprovedByPartner;
    });

    const approveButtons = Markup.inlineKeyboard([
      Markup.button.callback("✅ Approve Proof", `approve_proof:${matchId}:${telegramId}`),
      Markup.button.callback("❌ Reject Proof", `reject_proof:${matchId}:${telegramId}`),
    ]);

    const proofAccountLine = proofCutByUsername
      ? `\n\nCut done using TikTok account:\n@${proofCutByUsername}`
      : "";

    await bot.telegram.sendPhoto(partnerId, proofFileId, {
      caption: `📸 Your cut buddy just sent their proof!${proofAccountLine}\n\nTake a quick look below and make sure everything's valid 👀✨`,
      parse_mode: "Markdown",
      ...approveButtons,
    });
    console.log(`[PROOF_SENT_TO_PARTNER] telegramId=${telegramId} proof forwarded to partnerId=${partnerId} for matchId=${matchId}.`);

    // Start 10-minute no-response timeout — if partner doesn't approve/reject, punish them
    const proofTimerKey = `proof:${matchId}:${telegramId}`;
    if (proofTimers.has(proofTimerKey)) clearTimeout(proofTimers.get(proofTimerKey)!);
    const proofTimer = setTimeout(async () => {
      proofTimers.delete(proofTimerKey);
      await handleProofTimeout(bot, matchId, telegramId, partnerId);
    }, NO_RESPONSE_TIMEOUT_MS);
    proofTimers.set(proofTimerKey, proofTimer);
    console.log(`[NO_RESPONSE_TIMEOUT_STARTED] matchId=${matchId} proofOwnerId=${telegramId} inactivePartnerId=${partnerId} — 10-min timer started.`);
  });

  // ── Document handler: accept image documents as proof, reject everything else ──
  bot.on(message("document"), async (ctx) => {
    const telegramId = ctx.from.id;
    const doc = ctx.message.document;
    console.log(`[MSG] document from telegramId=${telegramId} mime=${doc.mime_type ?? "unknown"}`);

    const sus = await checkSuspension(telegramId);
    if (sus.suspended) {
      if (sus.reason === "banned") { console.log(`[BANNED_USER_BLOCKED_ACTION] telegramId=${telegramId} action=document`); }
      else { console.log(`[COOLDOWN_USER_BLOCKED_ACTION] telegramId=${telegramId} action=document`); }
      await ctx.reply(sus.message); return;
    }

    await checkAndApplyDailyReset(bot, telegramId);

    const user = await User.findOne({ telegramId });
    if (!user || user.tiktokUsername === "__pending__") {
      await ctx.reply("Kau belum register lagi. Taip /start dulu k!");
      return;
    }

    const isImageDocument = (doc.mime_type ?? "").startsWith("image/");

    if (!isImageDocument) {
      console.log(`[NON_IMAGE_DOCUMENT_REJECTED] telegramId=${telegramId} mime=${doc.mime_type ?? "unknown"} state=${user.state}`);
      await ctx.reply("❌ Hanya gambar/screenshot sahaja diterima sebagai bukti.\n\nSila hantar screenshot, bukan fail lain.");
      return;
    }

    // Image document — treat same as photo proof, subject to same state guards
    if (user.state === "pending_ready") {
      await ctx.reply("👉 Please press ✅ Ready To Cut or ❌ Cancel Match using the buttons above first.");
      return;
    }
    if (user.state === "in_match") {
      await ctx.reply("Sila tekan butang *✅ Done Cut* dahulu sebelum menghantar bukti ya.", { parse_mode: "Markdown" });
      return;
    }
    if (user.state === "awaiting_proof_account_selection") {
      await ctx.reply("Sila pilih akaun TikTok yang anda gunakan dahulu 👆✨");
      return;
    }
    if (user.state === "awaiting_proof_cut_username") {
      await ctx.reply("Sila taip username TikTok yang anda gunakan dahulu ✍️");
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

    const proofMessageId = ctx.message.message_id.toString();
    const proofFileId = doc.file_id;
    const now = new Date();

    const freshUser = await User.findOne({ telegramId }).select("proofCutByUsername");
    const proofCutByUsername = freshUser?.proofCutByUsername ?? null;

    if (isUser1) {
      await Match.updateOne({ _id: match._id }, {
        user1ProofSubmitted: true,
        user1ProofMessageId: proofMessageId,
        user1ProofSubmittedAt: now,
        user1Confirmed: true,
        user1ProofCutByUsername: proofCutByUsername,
      });
    } else {
      await Match.updateOne({ _id: match._id }, {
        user2ProofSubmitted: true,
        user2ProofMessageId: proofMessageId,
        user2ProofSubmittedAt: now,
        user2Confirmed: true,
        user2ProofCutByUsername: proofCutByUsername,
      });
    }

    console.log(`[PROOF_SUBMITTED_DOC] telegramId=${telegramId} submitted image document proof for matchId=${matchId} proofCutByUsername=${proofCutByUsername ?? "null"}.`);
    await User.updateOne({ telegramId }, { state: "awaiting_partner_approval", proofCutByUsername: null });
    await ctx.reply("✅ Proof received successfully!\n\nYour cut buddy is checking it now 👀✨");

    stopInactivityReminders(matchId, telegramId);
    const isUser1ForApproval = isUser1;
    void startInactivityReminders(bot, matchId, partnerId, "awaiting_partner_approval", async (mid) => {
      const m = await Match.findOne({ _id: mid, status: "active" });
      if (!m) return false;
      return isUser1ForApproval ? !m.user1ProofApprovedByPartner : !m.user2ProofApprovedByPartner;
    });

    const approveButtons = Markup.inlineKeyboard([
      Markup.button.callback("✅ Approve Proof", `approve_proof:${matchId}:${telegramId}`),
      Markup.button.callback("❌ Reject Proof", `reject_proof:${matchId}:${telegramId}`),
    ]);

    const proofAccountLine = proofCutByUsername
      ? `\n\nCut done using TikTok account:\n@${proofCutByUsername}`
      : "";

    await bot.telegram.sendDocument(partnerId, proofFileId, {
      caption: `📸 Your cut buddy just sent their proof!${proofAccountLine}\n\nTake a quick look below and make sure everything's valid 👀✨`,
      parse_mode: "Markdown",
      ...approveButtons,
    });
    console.log(`[PROOF_SENT_TO_PARTNER_DOC] telegramId=${telegramId} image doc proof forwarded to partnerId=${partnerId} for matchId=${matchId}.`);

    const proofTimerKey = `proof:${matchId}:${telegramId}`;
    if (proofTimers.has(proofTimerKey)) clearTimeout(proofTimers.get(proofTimerKey)!);
    const proofTimer = setTimeout(async () => {
      proofTimers.delete(proofTimerKey);
      await handleProofTimeout(bot, matchId, telegramId, partnerId);
    }, NO_RESPONSE_TIMEOUT_MS);
    proofTimers.set(proofTimerKey, proofTimer);
    console.log(`[NO_RESPONSE_TIMEOUT_STARTED] matchId=${matchId} proofOwnerId=${telegramId} inactivePartnerId=${partnerId} — 10-min timer started (doc proof).`);
  });

  // ── Video handler: reject videos clearly — only screenshots are accepted ──
  bot.on(message("video"), async (ctx) => {
    const telegramId = ctx.from.id;
    console.log(`[MSG] video from telegramId=${telegramId}`);

    const sus = await checkSuspension(telegramId);
    if (sus.suspended) { await ctx.reply(sus.message); return; }

    const user = await User.findOne({ telegramId });
    if (!user || user.tiktokUsername === "__pending__") {
      await ctx.reply("Kau belum register lagi. Taip /start dulu k!");
      return;
    }

    if (user.state === "awaiting_proof") {
      console.log(`[VIDEO_AS_PROOF_REJECTED] telegramId=${telegramId} — video sent instead of proof screenshot`);
      await ctx.reply("⚠️ Sila hantar screenshot bukti cut, bukan video.");
    } else {
      await ctx.reply("❌ Video tidak diterima. Sila hantar screenshot sebagai bukti jika perlu.");
    }
  });

  // FIX 2: Sticker / voice / animation handlers — guide unregistered users to register
  bot.on(message("sticker"), async (ctx) => {
    const telegramId = ctx.from.id;
    console.log(`[MSG] sticker from telegramId=${telegramId}`);
    const user = await User.findOne({ telegramId });
    if (!user || user.tiktokUsername === "__pending__") {
      await ctx.reply("👋 Please send your TikTok profile link to register first.\n\nExample:\nhttps://www.tiktok.com/@username");
    }
  });

  bot.on(message("voice"), async (ctx) => {
    const telegramId = ctx.from.id;
    console.log(`[MSG] voice from telegramId=${telegramId}`);
    const user = await User.findOne({ telegramId });
    if (!user || user.tiktokUsername === "__pending__") {
      await ctx.reply("👋 Please send your TikTok profile link to register first.\n\nExample:\nhttps://www.tiktok.com/@username");
    }
  });

  bot.on(message("animation"), async (ctx) => {
    const telegramId = ctx.from.id;
    console.log(`[MSG] animation from telegramId=${telegramId}`);
    const user = await User.findOne({ telegramId });
    if (!user || user.tiktokUsername === "__pending__") {
      await ctx.reply("👋 Please send your TikTok profile link to register first.\n\nExample:\nhttps://www.tiktok.com/@username");
    }
  });

  bot.on(message("text"), async (ctx) => {
    const telegramId = ctx.from.id;
    const text = ctx.message.text.trim();
    console.log(`[MSG] text from telegramId=${telegramId}: ${text.slice(0, 80)}`);

    // Admin broadcast intercept — must run before any user logic
    if (adminBroadcastPending.has(telegramId)) {
      if (text.startsWith("/cancel")) {
        adminBroadcastPending.delete(telegramId);
        await ctx.reply("❌ Broadcast cancelled.");
        return;
      }
      if (text.startsWith("/")) return; // ignore other commands while awaiting
      adminBroadcastPending.delete(telegramId);
      await executeBroadcast(bot, ctx.chat.id, telegramId, text);
      return;
    }

    if (text.startsWith("/")) return;

    const sus = await checkSuspension(telegramId);
    if (sus.suspended) {
      if (sus.reason === "banned") { console.log(`[BANNED_USER_BLOCKED_ACTION] telegramId=${telegramId} action=text`); }
      else { console.log(`[COOLDOWN_USER_BLOCKED_ACTION] telegramId=${telegramId} action=text`); }
      await ctx.reply(sus.message); return;
    }

    await checkAndApplyDailyReset(bot, telegramId);

    const user = await User.findOne({ telegramId });

    if (!user || user.tiktokUsername === "__pending__") {
      if (user?.state === "awaiting_tiktok_profile") {
        console.log(`[TIKTOK] Received profile link from telegramId=${telegramId}: ${text.slice(0, 100)}`);

        // FIX 2: If stuck in awaiting_tiktok_profile for >30 min, resend the prompt as a reminder
        const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000);
        if (user.updatedAt < thirtyMinutesAgo) {
          console.log(`[REGISTRATION_STUCK_RESEND] telegramId=${telegramId} — stuck in awaiting_tiktok_profile for >30 min. Resending prompt.`);
          await User.updateOne({ telegramId }, { state: "awaiting_tiktok_profile" });
          await ctx.reply(
            "👋 Still waiting for your TikTok profile link!\n\nPlease send your TikTok username or profile link below:\n\nExamples:\n@yourusername\nhttps://www.tiktok.com/@yourusername",
          );
          await sendTutorialImage(bot, telegramId);
          return;
        }

        // Block cut/short links — they are not TikTok profile links
        if (isTikTokCutLink(text)) {
          console.log(`[CUT_LINK_BLOCKED_DURING_REGISTRATION] telegramId=${telegramId} input="${text.slice(0, 100)}"`);
          await ctx.reply(
            `Oops 😭\n\nBefore you can swap cut links, please register your TikTok profile first 👀✨\n\nSend your TikTok username or profile link below:\n\nExamples:\n@yourusername\nhttps://www.tiktok.com/@yourusername`,
          );
          return;
        }

        const rawUsername = await extractTikTokUsername(text);
        if (!rawUsername) {
          console.warn(`[INVALID_PROFILE_INPUT] telegramId=${telegramId} input="${text.slice(0, 100)}"`);
          await ctx.reply("❌ That looks like the wrong TikTok link 😵‍💫\n\nPlease follow this tutorial to copy the correct link 👇✨");
          await sendTutorialImage(bot, telegramId);
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
        console.log(`[TIKTOK_PROFILE_REGISTERED] telegramId=${telegramId} — registered TikTok username "@${username}".`);

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

      // FIX 2: If stuck in awaiting_tiktok_profile for >30 min, resend the prompt as a reminder
      const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000);
      if (user.updatedAt < thirtyMinutesAgo) {
        console.log(`[REGISTRATION_STUCK_RESEND] telegramId=${telegramId} — stuck in awaiting_tiktok_profile for >30 min. Resending prompt.`);
        await User.updateOne({ telegramId }, { state: "awaiting_tiktok_profile" });
        await ctx.reply(
          "👋 Still waiting for your TikTok profile link!\n\nPlease send your TikTok username or profile link below:\n\nExamples:\n@yourusername\nhttps://www.tiktok.com/@yourusername",
        );
        await sendTutorialImage(bot, telegramId);
        return;
      }

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

      // Block cut/short links — they are not TikTok profile links
      if (isTikTokCutLink(text)) {
        console.log(`[CUT_LINK_BLOCKED_DURING_REGISTRATION] telegramId=${telegramId} input="${text.slice(0, 100)}"`);
        await ctx.reply(
          `Oops 😭\n\nBefore you can swap cut links, please register your TikTok profile first 👀✨\n\nSend your TikTok username or profile link below:\n\nExamples:\n@yourusername\nhttps://www.tiktok.com/@yourusername`,
        );
        return;
      }

      const rawUsername = await extractTikTokUsername(text);
      if (!rawUsername) {
        console.warn(`[INVALID_PROFILE_INPUT] telegramId=${telegramId} input="${text.slice(0, 100)}"`);
        await ctx.reply("❌ That looks like the wrong TikTok link 😵‍💫\n\nPlease follow this tutorial to copy the correct link 👇✨");
        await sendTutorialImage(bot, telegramId);
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
      console.log(`[TIKTOK_PROFILE_REGISTERED] telegramId=${telegramId} — registered TikTok username "@${username}".`);
      await ctx.reply(`Welcome @${username}! ✅\n\nNow send your TikTok cut price link to start swapping 🔗✨`);
      return;
    }

    if (user.state === "awaiting_cut_link") {

      if (user.cutBalance <= 0) {
        const me = await bot.telegram.getMe();
        const refLink = `https://t.me/${me.username}?start=ref_${user.referralCode}`;
        await ctx.reply(
          `😬 Cuts kau dah habis bro!\n\n🔥 Share bot ni & dapat *+${REFERRAL_CUT_REWARD} cuts* setiap orang yang join & selesaikan swap!\n\n${refLink}`,
          { parse_mode: "Markdown" },
        );
        return;
      }

      if (isTikTokProfileLink(text)) {
        console.log(`[INVALID_PROFILE_LINK_REJECTED] telegramId=${telegramId} (@${user.tiktokUsername}) submitted profile link: "${text}"`);
        await ctx.reply(
          "❌ That looks like a TikTok profile link 😵‍💫\n\nPlease send your TikTok CUT PRICE link instead 👇✨\n\nExample:\nhttps://vt.tiktok.com/ZSxxxx/",
        );
        return;
      }

      if (!isValidCutLink(text)) {
        console.log(`[INVALID_PROFILE_LINK_REJECTED] telegramId=${telegramId} (@${user.tiktokUsername}) submitted non-cut link: "${text}"`);
        await ctx.reply(
          "❌ That looks like a TikTok profile link 😵‍💫\n\nPlease send your TikTok CUT PRICE link instead 👇✨\n\nExample:\nhttps://vt.tiktok.com/ZSxxxx/",
        );
        return;
      }

      // ── Guard 1: anti-spam cooldown (60 s) ──────────────────────────────
      const lastSubmitTs = lastCutLinkSubmittedAt.get(telegramId);
      if (lastSubmitTs && Date.now() - lastSubmitTs < CUT_LINK_SPAM_COOLDOWN_MS) {
        console.log(`[CUT_LINK_SUBMIT_COOLDOWN_BLOCKED] telegramId=${telegramId} (@${user.tiktokUsername}) — ${Math.ceil((CUT_LINK_SPAM_COOLDOWN_MS - (Date.now() - lastSubmitTs)) / 1000)}s remaining`);
        await ctx.reply("Slow down bestie 😭\n\nYou can submit another cut link in a few seconds.");
        return;
      }

      // ── Guard 2: in-memory submit lock (prevents concurrent duplicate) ──
      if (cutLinkSubmitLocks.has(telegramId)) {
        console.log(`[DUPLICATE_SUBMIT_BLOCKED] telegramId=${telegramId} (@${user.tiktokUsername}) — submit lock already held`);
        await ctx.reply("⏳ You already submitted a cut link.\n\nPlease wait for a partner or finish your current swap first 👀✨");
        return;
      }

      // ── Guard 3: already queued / in match / has pending link ───────────
      if (user.isWaiting || user.activeMatchId || user.pendingLink) {
        console.log(`[DUPLICATE_SUBMIT_BLOCKED] telegramId=${telegramId} (@${user.tiktokUsername}) — busy: isWaiting=${user.isWaiting} activeMatchId=${user.activeMatchId ?? "null"} hasPendingLink=${!!user.pendingLink}`);
        await ctx.reply("⏳ You already have an active cut request.\n\nPlease wait for a partner or finish your current swap first 👀✨");
        return;
      }

      // Acquire submit lock + record submission timestamp
      cutLinkSubmitLocks.add(telegramId);
      lastCutLinkSubmittedAt.set(telegramId, Date.now());
      console.log(`[CUT_LINK_SUBMIT_LOCK_ACQUIRED] telegramId=${telegramId} (@${user.tiktokUsername})`);

      try {
        // Re-read from DB inside the lock to catch any race conditions
        const freshUser = await User.findOne({ telegramId }).select("state isWaiting activeMatchId pendingLink tiktokUsername");
        if (freshUser && (freshUser.isWaiting || freshUser.activeMatchId || freshUser.pendingLink)) {
          console.log(`[STALE_SUBMIT_STATE_CLEANED] telegramId=${telegramId} — race condition caught inside lock: isWaiting=${freshUser.isWaiting} activeMatchId=${freshUser.activeMatchId ?? "null"} hasPendingLink=${!!freshUser.pendingLink}`);
          await ctx.reply("⏳ You already have an active cut request.\n\nPlease wait for a partner or finish your current swap first 👀✨");
          return;
        }

        console.log(`[VALID_CUT_LINK_ACCEPTED] telegramId=${telegramId} (@${user.tiktokUsername}) submitted valid cut link: "${text}"`);

        const activeMatch = await Match.findOne({
          $or: [{ user1Id: telegramId }, { user2Id: telegramId }],
          status: { $in: ["active", "pending_ready"] },
        });

        if (activeMatch) {
          console.log(`[ACTIVE_MATCH_BLOCKED_NEW_LINK] telegramId=${telegramId} (@${user.tiktokUsername}) tried to submit new link while match ${activeMatch._id} is still ${activeMatch.status}.`);
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

        // Customer broadcast — idempotent: same user+link only broadcasts once per 60s window
        const broadcastKey = `${telegramId}:${text}`;
        const lastBroadcastTs = broadcastedSubmissions.get(broadcastKey);
        if (lastBroadcastTs && Date.now() - lastBroadcastTs < CUT_LINK_SPAM_COOLDOWN_MS) {
          console.log(`[BROADCAST_ALREADY_SENT_FOR_SUBMISSION] telegramId=${telegramId} (@${user.tiktokUsername}) — skipping duplicate broadcast for same link`);
        } else {
          broadcastedSubmissions.set(broadcastKey, Date.now());
          if (broadcastedSubmissions.size > 500) {
            broadcastedSubmissions.delete(broadcastedSubmissions.keys().next().value!);
          }
          console.log(`[CUSTOMER_BROADCAST_TRIGGERED_AFTER_CUT_LINK] telegramId=${telegramId} (@${user.tiktokUsername}) link="${text}"`);
          try {
            await broadcastCutLinkNotification(bot, user.tiktokUsername, telegramId, "cut_link_submit", text);
          } catch (err) {
            console.error(`[CUSTOMER_BROADCAST_FAILED] telegramId=${telegramId} (@${user.tiktokUsername}): ${(err as Error).message}`);
          }
        }

        // Try atomic match first — if no partner, enter queue
        const immediatelyMatched = await tryMatchAtomic(bot, telegramId, text);
        if (!immediatelyMatched) {
          // No partner available — enter queue
          await addToQueue(bot, telegramId, text);
        }

        return;
      } finally {
        cutLinkSubmitLocks.delete(telegramId);
        console.log(`[CUT_LINK_SUBMIT_LOCK_RELEASED] telegramId=${telegramId} (@${user.tiktokUsername})`);
      }
    }

    if (user.state === "inqueue") {
      if (isAnyTikTokLink(text)) {
        await ctx.reply("⚠️ Kau sudah dalam queue. Link TikTok tidak diterima sekarang.\n\nTunggu je ya, sedang mencari partner 🔒✨");
      } else {
        await ctx.reply("Still finding your cut buddy 🔒✨\n\nHang tight for a few more seconds 👀");
      }
      return;
    }

    if (user.state === "awaiting_reject_reason") {
      const pending = pendingRejectReasons.get(telegramId);
      if (!pending) {
        await User.updateOne({ telegramId }, { state: "awaiting_partner_approval" });
        await ctx.reply("⚠️ Something went wrong. Please try again.");
        return;
      }
      if (text.length < 5) {
        console.log(`[REJECT_REASON_INVALID] telegramId=${telegramId} — reason too short: "${text}"`);
        await ctx.reply("Please enter a proper rejection reason 😵‍💫\n\n_(Minimum 5 characters)_", { parse_mode: "Markdown" });
        return;
      }
      console.log(`[REJECT_REASON_RECEIVED] telegramId=${telegramId} matchId=${pending.matchId} reason="${text}"`);
      pendingRejectReasons.delete(telegramId);
      await finalizeRejectProof(bot, ctx.chat.id, telegramId, pending.matchId, pending.proofOwnerId, text);
      return;
    }

    if (user.state === "awaiting_proof_cut_username") {
      const rawInput = text.trim();

      if (isAnyTikTokLink(rawInput)) {
        console.log(`[PROOF_ACCOUNT_TIKTOK_LINK_REJECTED] telegramId=${telegramId} — TikTok link sent instead of username: "${rawInput}"`);
        await ctx.reply("⚠️ Sila taip username TikTok sahaja, bukan link TikTok.\n\nContoh:\n@yourusername");
        return;
      }

      const normalizedUsername = rawInput.replace(/^@/, "").toLowerCase().trim();

      if (!normalizedUsername || !/^[\w.]+$/.test(normalizedUsername)) {
        console.log(`[PROOF_ACCOUNT_INVALID] telegramId=${telegramId} — invalid username input: "${rawInput}"`);
        await ctx.reply("Oops 😭\n\nPlease send a valid TikTok username.\n\nExample:\n@username");
        return;
      }

      await User.updateOne({ telegramId }, { state: "awaiting_proof", proofCutByUsername: normalizedUsername });
      console.log(`[PROOF_ACCOUNT_CUSTOM_ENTERED] telegramId=${telegramId} — entered username: "${normalizedUsername}"`);
      console.log(`[PROOF_ACCOUNT_SAVED] telegramId=${telegramId} proofCutByUsername=@${normalizedUsername}`);

      if (user.activeMatchId) {
        const mid = user.activeMatchId.toString();
        stopInactivityReminders(mid, telegramId);
        void startInactivityReminders(bot, mid, telegramId, "awaiting_proof");
      }

      await ctx.reply("📸 Okieee now send a screenshot as proof that you've completed your partner's cut ✨");
      return;
    }

    if (user.state === "awaiting_proof_account_selection") {
      console.log(`[PROOF_FLOW_COMMAND_BLOCKED] telegramId=${telegramId} — text blocked during awaiting_proof_account_selection`);
      const registeredUsername = user.tiktokUsername ?? "unknown";
      await ctx.reply(
        `Hii 👀✨\n\nWhich TikTok account did you use to cut your partner's link?\n\nExample:\n@username`,
        Markup.inlineKeyboard([
          [Markup.button.callback(`✅ Use registered account (@${registeredUsername})`, "proof_use_registered")],
          [Markup.button.callback("✍️ Enter another username", "proof_enter_other")],
          [Markup.button.callback("❌ Cancel", "proof_cancel_account_selection")],
        ]),
      );
      console.log(`[PROOF_ACCOUNT_SELECTION_RESENT] telegramId=${telegramId} — resent via text block`);
      return;
    }

    if (user.state === "pending_ready") {
      if (isAnyTikTokLink(text)) {
        await ctx.reply("⚠️ Link TikTok tidak diterima sekarang.\n\nSila tekan ✅ Ready To Cut atau ❌ Cancel Match menggunakan butang di atas.");
      } else {
        await ctx.reply("👉 Please press ✅ Ready To Cut or ❌ Cancel Match using the buttons above.");
      }
      return;
    }

    if (user.state === "in_match") {
      if (isAnyTikTokLink(text)) {
        console.log(`[TIKTOK_LINK_DURING_MATCH_REJECTED] telegramId=${telegramId} — TikTok link sent while in_match: "${text.slice(0, 100)}"`);
        await ctx.reply("⚠️ Link TikTok tidak diterima sebagai bukti.\n\nSila tekan butang *✅ Done Cut* apabila anda selesai cut link partner, kemudian hantar screenshot.", { parse_mode: "Markdown" });
      } else {
        await ctx.reply("Sila tekan butang *✅ Done Cut* apabila anda selesai cut link partner.", { parse_mode: "Markdown" });
      }
      return;
    }

    if (user.state === "awaiting_proof") {
      if (isAnyTikTokLink(text)) {
        console.log(`[TIKTOK_LINK_AS_PROOF_REJECTED] telegramId=${telegramId} — TikTok link sent instead of proof screenshot: "${text.slice(0, 100)}"`);
        await ctx.reply("⚠️ Sila hantar screenshot bukti cut, bukan link TikTok.");
      } else {
        await ctx.reply("Sila hantar *screenshot* sebagai bukti anda telah cut link partner. 📸", { parse_mode: "Markdown" });
      }
      return;
    }

    if (user.state === "awaiting_partner_approval") {
      if (isAnyTikTokLink(text)) {
        await ctx.reply("⚠️ Bukti anda sudah dihantar. Sila tunggu partner anda semak dan approve dahulu.\n\nLink TikTok tidak diterima.");
      } else {
        await ctx.reply("⏳ Bukti anda sudah dihantar. Sila tunggu partner anda semak dan approve terlebih dahulu.");
      }
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
      { state: "awaiting_proof_account_selection" },
    );
    if (!updated) {
      console.log(`[DUPLICATE_CALLBACK_BLOCKED] done_cut — telegramId=${telegramId} — not in_match state.`);
      await ctx.reply("⚠️ Action already processed.");
      return;
    }

    console.log(`[PROOF_ACCOUNT_SELECTION_STARTED] telegramId=${telegramId}`);

    const matchIdForReminder = updated.activeMatchId?.toString();
    if (matchIdForReminder) {
      stopInactivityReminders(matchIdForReminder, telegramId);
      void startInactivityReminders(bot, matchIdForReminder, telegramId, "awaiting_proof_account_selection");
    }

    const user = await User.findOne({ telegramId });
    const registeredUsername = user?.tiktokUsername ?? "unknown";

    await ctx.reply(
      `Hii 👀✨\n\nWhich TikTok account did you use to cut your partner's link?\n\nExample:\n@username`,
      Markup.inlineKeyboard([
        [Markup.button.callback(`✅ Use registered account (@${registeredUsername})`, "proof_use_registered")],
        [Markup.button.callback("✍️ Enter another username", "proof_enter_other")],
        [Markup.button.callback("❌ Cancel", "proof_cancel_account_selection")],
      ]),
    );
  });

  bot.action("proof_use_registered", async (ctx) => {
    await ctx.answerCbQuery();
    const telegramId = ctx.from!.id;

    try { await ctx.editMessageReplyMarkup({ inline_keyboard: [] }); } catch { /* already edited */ }

    const user = await User.findOne({ telegramId });
    if (!user || user.state !== "awaiting_proof_account_selection") {
      await ctx.reply("⚠️ Action already processed.");
      return;
    }

    const registeredUsername = user.tiktokUsername;
    await User.updateOne({ telegramId }, { state: "awaiting_proof", proofCutByUsername: registeredUsername });
    console.log(`[PROOF_ACCOUNT_REGISTERED_SELECTED] telegramId=${telegramId} — using registered @${registeredUsername}`);
    console.log(`[PROOF_ACCOUNT_SAVED] telegramId=${telegramId} proofCutByUsername=@${registeredUsername}`);

    if (user.activeMatchId) {
      const mid = user.activeMatchId.toString();
      stopInactivityReminders(mid, telegramId);
      void startInactivityReminders(bot, mid, telegramId, "awaiting_proof");
    }

    await ctx.reply("📸 Okieee now send a screenshot as proof that you've completed your partner's cut ✨");
  });

  bot.action("proof_enter_other", async (ctx) => {
    await ctx.answerCbQuery();
    const telegramId = ctx.from!.id;

    try { await ctx.editMessageReplyMarkup({ inline_keyboard: [] }); } catch { /* already edited */ }

    const user = await User.findOne({ telegramId });
    if (!user || user.state !== "awaiting_proof_account_selection") {
      await ctx.reply("⚠️ Action already processed.");
      return;
    }

    await User.updateOne({ telegramId }, { state: "awaiting_proof_cut_username" });

    if (user.activeMatchId) {
      const mid = user.activeMatchId.toString();
      stopInactivityReminders(mid, telegramId);
      void startInactivityReminders(bot, mid, telegramId, "awaiting_proof_cut_username");
    }

    await ctx.reply("✍️ Please type the TikTok username you used to cut your partner's link 👇\n\nExample:\n@username");
  });

  bot.action("proof_cancel_account_selection", async (ctx) => {
    await ctx.answerCbQuery();
    const telegramId = ctx.from!.id;

    try { await ctx.editMessageReplyMarkup({ inline_keyboard: [] }); } catch { /* already edited */ }

    const user = await User.findOne({ telegramId });
    if (!user || user.state !== "awaiting_proof_account_selection") {
      await ctx.reply("⚠️ Action already processed.");
      return;
    }

    await User.updateOne({ telegramId }, { state: "in_match" });

    if (user.activeMatchId) {
      const mid = user.activeMatchId.toString();
      stopInactivityReminders(mid, telegramId);
      void startInactivityReminders(bot, mid, telegramId, "in_match");
    }

    await ctx.reply("❌ Cancelled. You can press ✅ Done Cut again when you're ready.");
  });

  // ─── Ready To Cut callback ─────────────────────────────────────────────────
  bot.action(/^ready_to_cut:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const telegramId = ctx.from!.id;
    const matchId = ctx.match[1];

    try {
      await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
    } catch { /* already edited */ }

    const user = await User.findOne({ telegramId });
    if (!user || user.state !== "pending_ready") {
      console.log(`[DUPLICATE_CALLBACK_BLOCKED] ready_to_cut — telegramId=${telegramId} matchId=${matchId} — not in pending_ready state.`);
      await ctx.reply("⚠️ Action already processed.");
      return;
    }

    const match = await Match.findOne({ _id: matchId, status: "pending_ready" });
    if (!match) {
      console.log(`[STALE_READY_BUTTON_BLOCKED] ready_to_cut — telegramId=${telegramId} matchId=${matchId} — match no longer pending_ready.`);
      await ctx.reply("⚠️ This match is no longer active.");
      return;
    }

    if (match.user1Id !== telegramId && match.user2Id !== telegramId) {
      console.log(`[INVALID_CALLBACK_BLOCKED] ready_to_cut — telegramId=${telegramId} not a participant in matchId=${matchId}.`);
      await ctx.reply("⚠️ You are not part of this match.");
      return;
    }

    const isUser1 = match.user1Id === telegramId;
    const partnerId = isUser1 ? match.user2Id : match.user1Id;
    const readyField = isUser1 ? "user1ReadyToCut" : "user2ReadyToCut";
    const readyAtField = isUser1 ? "user1ReadyAt" : "user2ReadyAt";
    const partnerReadyField = isUser1 ? "user2ReadyToCut" : "user1ReadyToCut";

    // Prevent duplicate ready click
    if (match[readyField as keyof typeof match] === true) {
      console.log(`[DUPLICATE_READY_BLOCKED] ready_to_cut — telegramId=${telegramId} matchId=${matchId} — already marked ready.`);
      await ctx.reply("✅ You're already marked as ready! Waiting for your partner...");
      return;
    }

    // Atomically mark this user as ready
    const updatedMatch = await Match.findOneAndUpdate(
      { _id: matchId, status: "pending_ready", [readyField]: false },
      { $set: { [readyField]: true, [readyAtField]: new Date() } },
      { new: true },
    );

    if (!updatedMatch) {
      console.log(`[READY_RACE_CONDITION_HANDLED] ready_to_cut — telegramId=${telegramId} matchId=${matchId} — race condition or already set.`);
      await ctx.reply("⚠️ Action already processed.");
      return;
    }

    console.log(`[USER_READY_TO_CUT] telegramId=${telegramId} matchId=${matchId} isUser1=${isUser1}`);

    const bothReady = updatedMatch[partnerReadyField as keyof typeof updatedMatch] === true;

    if (!bothReady) {
      // Only this user is ready — wait for partner
      await ctx.reply("✅ You're ready! Waiting for your cut buddy to confirm...\n\n_(You'll get the link as soon as they're ready too 👀✨)_", { parse_mode: "Markdown" });
      return;
    }

    // Both users are ready — reveal links and start active match
    const cancelReadyTimer = readyTimers.get(matchId);
    if (cancelReadyTimer) { clearTimeout(cancelReadyTimer); readyTimers.delete(matchId); }

    stopInactivityReminders(matchId, match.user1Id);
    stopInactivityReminders(matchId, match.user2Id);

    const now = new Date();
    const expiresAt = new Date(now.getTime() + 10 * 60 * 1000);

    await Match.updateOne(
      { _id: matchId },
      { $set: { status: "active", linkRevealed: true, linkRevealedAt: now, expiresAt } },
    );

    await Promise.all([
      User.updateOne({ telegramId: match.user1Id }, { state: "in_match" }),
      User.updateOne({ telegramId: match.user2Id }, { state: "in_match" }),
    ]);

    console.log(`[BOTH_USERS_READY_LINKS_REVEALED] matchId=${matchId} — both ready, match activated, links revealed.`);

    const [u1, u2] = await Promise.all([
      User.findOne({ telegramId: match.user1Id }).select("tiktokUsername"),
      User.findOne({ telegramId: match.user2Id }).select("tiktokUsername"),
    ]);

    const matchButtons = Markup.inlineKeyboard([
      Markup.button.callback("✅ Done Cut", "done_cut"),
      Markup.button.callback("❌ Cancel Match (24h cooldown)", "cancel_match"),
    ]);

    await Promise.all([
      bot.telegram.sendMessage(
        match.user1Id,
        `🎉 Both users are ready!\n\nYour partner:\n@${u2?.tiktokUsername}\n\nTheir cut link:\n${match.link2}\n\nNow complete the cut and press ✅ Done Cut.`,
        { ...matchButtons },
      ),
      bot.telegram.sendMessage(
        match.user2Id,
        `🎉 Both users are ready!\n\nYour partner:\n@${u1?.tiktokUsername}\n\nTheir cut link:\n${match.link1}\n\nNow complete the cut and press ✅ Done Cut.`,
        { ...matchButtons },
      ),
    ]);

    // Start 10-minute expiry timer and inactivity reminders
    console.log(`[MATCH_EXPIRY_TIMER_10M_STARTED] matchId=${matchId} — 10-minute expiry timer started after link reveal.`);
    const expiryTimer = setTimeout(async () => {
      console.log(`[MATCH_EXPIRY_TIMER_10M_TRIGGERED] matchId=${matchId} — 10-minute window elapsed, triggering expiry.`);
      await handleMatchExpiry(bot, matchId, match.user1Id, match.user2Id);
    }, 10 * 60 * 1000);
    matchTimers.set(matchId, expiryTimer);

    void startInactivityReminders(bot, matchId, match.user1Id, "in_match");
    void startInactivityReminders(bot, matchId, match.user2Id, "in_match");
  });

  // ─── Cancel Ready callback (before link reveal — no punishment) ─────────────
  bot.action(/^cancel_ready:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const telegramId = ctx.from!.id;
    const matchId = ctx.match[1];

    try {
      await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
    } catch { /* already edited */ }

    const user = await User.findOne({ telegramId });
    if (!user || user.state !== "pending_ready") {
      console.log(`[DUPLICATE_CALLBACK_BLOCKED] cancel_ready — telegramId=${telegramId} matchId=${matchId} — not in pending_ready state.`);
      await ctx.reply("⚠️ Action already processed.");
      return;
    }

    // Atomically cancel the pending_ready match — links were never revealed
    const match = await Match.findOneAndUpdate(
      { _id: matchId, status: "pending_ready" },
      { status: "cancelled" },
      { new: false },
    );

    if (!match) {
      console.log(`[DUPLICATE_CALLBACK_BLOCKED] cancel_ready — telegramId=${telegramId} matchId=${matchId} — no pending_ready match found.`);
      await ctx.reply("⚠️ Action already processed.");
      return;
    }

    const partnerId = match.user1Id === telegramId ? match.user2Id : match.user1Id;
    const isUser1 = match.user1Id === telegramId;
    const partnerAlreadyReady = isUser1 ? match.user2ReadyToCut : match.user1ReadyToCut;

    // Cancel the ready timeout timer
    const cancelReadyTimer = readyTimers.get(matchId);
    if (cancelReadyTimer) { clearTimeout(cancelReadyTimer); readyTimers.delete(matchId); }

    stopInactivityReminders(matchId, telegramId);
    stopInactivityReminders(matchId, partnerId);

    console.log(`[PRE_CUT_MATCH_CANCELLED_NO_PUNISHMENT] telegramId=${telegramId} matchId=${matchId} — cancelled before link reveal. No punishment.`);

    // Reset canceller — no cooldown, no punishment
    await Queue.deleteOne({ telegramId });
    await User.updateOne(
      { telegramId },
      { state: "awaiting_cut_link", isWaiting: false, queuedAt: null, pendingLink: null, activeMatchId: null },
    );
    console.log(`[MATCH_STATE_FULLY_CLEARED] telegramId=${telegramId} path=pre_cut_cancel_no_punishment`);

    await ctx.reply(`❌ Match cancelled. No cooldown applied.`);

    // Handle partner
    const partner = await User.findOne({ telegramId: partnerId });
    if (partner) {
      await Queue.deleteOne({ telegramId: partnerId });

      if (partnerAlreadyReady) {
        // Partner had already pressed Ready — auto-requeue them to find a new match
        console.log(`[READY_USER_AUTO_REQUEUED_AFTER_PARTNER_CANCEL] telegramId=${partnerId} — partner cancelled before link reveal, requeuing ready user.`);

        const partnerLink = partner.pendingLink ?? (match.user1Id === partnerId ? match.link1 : match.link2);
        if (partnerLink) {
          await User.updateOne(
            { telegramId: partnerId },
            { state: "awaiting_cut_link", isWaiting: false, queuedAt: null, activeMatchId: null },
          );

          try {
            await bot.telegram.sendMessage(
              partnerId,
              `❌ Partner cancelled before starting. Searching again...`,
            );
          } catch { /* partner may have blocked bot */ }

          // Re-insert into queue so they get a new partner (through normal flow)
          await addToQueue(bot, partnerId, partnerLink);
        } else {
          await User.updateOne(
            { telegramId: partnerId },
            { state: "awaiting_cut_link", isWaiting: false, queuedAt: null, pendingLink: null, activeMatchId: null },
          );
          console.log(`[MATCH_STATE_FULLY_CLEARED] telegramId=${partnerId} path=pre_cut_cancel_partner_no_link`);
          try {
            await bot.telegram.sendMessage(
              partnerId,
              `❌ Partner cancelled before starting. Submit a new cut link to search again.`,
            );
          } catch { /* partner may have blocked bot */ }
        }
      } else {
        // Partner had not pressed Ready yet — just reset them, no auto-requeue
        await User.updateOne(
          { telegramId: partnerId },
          { state: "awaiting_cut_link", isWaiting: false, queuedAt: null, pendingLink: null, activeMatchId: null },
        );
        console.log(`[MATCH_STATE_FULLY_CLEARED] telegramId=${partnerId} path=pre_cut_cancel_partner_not_ready`);
        try {
          await bot.telegram.sendMessage(
            partnerId,
            `❌ Partner cancelled before starting. No cooldown applied — submit a new cut link whenever you're ready.`,
          );
        } catch { /* partner may have blocked bot */ }
      }
    }

    // Admin notification — pre-cut cancellation, no punishment
    const cancelU1Status = match.user1Id === telegramId ? "⚠️ Cancelled Before Link Reveal" : (partnerAlreadyReady ? "✅ Was Ready To Cut" : "⏳ Had Not Pressed Ready");
    const cancelU2Status = match.user2Id === telegramId ? "⚠️ Cancelled Before Link Reveal" : (partnerAlreadyReady ? "✅ Was Ready To Cut" : "⏳ Had Not Pressed Ready");
    await notifyAdminMatchCancelled(
      bot, match.user1Id, match.user2Id,
      `Pre-cut cancellation — user cancelled before links were revealed.`,
      matchId,
      {
        responsibleId: telegramId,
        user1Status: cancelU1Status,
        user2Status: cancelU2Status,
        systemActions: [
          "Match cancelled",
          "No punishment applied",
          "Links were not revealed",
          partnerAlreadyReady ? "Ready partner auto-requeued to find new match" : "Partner reset to awaiting_cut_link",
        ],
      },
    );
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

    stopInactivityReminders(timerId, telegramId);
    stopInactivityReminders(timerId, partnerId);

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
        await requeueUser(bot, partnerId, partner.pendingLink);
      } else {
        await User.updateOne({ telegramId: partnerId }, { state: "awaiting_cut_link", isWaiting: false, queuedAt: null, pendingLink: null, activeMatchId: null, proofCutByUsername: null });
        console.log(`[PARTNER_NO_LINK] telegramId=${partnerId} has no pendingLink — set to awaiting_cut_link.`);
        console.log(`[MATCH_STATE_FULLY_CLEARED] telegramId=${partnerId} path=manual_cancel_partner`);
      }
    }

    // Admin notification — manual match cancellation
    // partner.state captured before reset — reflects their actual state at time of cancel
    const cancelPartnerStatus = matchStateToStatus(partner?.state);
    const cancelU1Status = match.user1Id === telegramId ? "⚠️ Manually Cancelled Match" : cancelPartnerStatus;
    const cancelU2Status = match.user2Id === telegramId ? "⚠️ Manually Cancelled Match" : cancelPartnerStatus;
    await notifyAdminMatchCancelled(
      bot, match.user1Id, match.user2Id,
      `Manual cancel by user — user pressed Cancel Match button.`,
      match._id.toString(),
      {
        responsibleId: telegramId,
        user1Status: cancelU1Status,
        user2Status: cancelU2Status,
        systemActions: [
          "Match cancelled",
          "24h cooldown applied to cancelling user",
          partner?.pendingLink ? "Partner re-queued with previous link" : "Partner reset to awaiting cut link",
        ],
      },
    );
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
    stopInactivityReminders(matchId, telegramId);
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

    // Enter two-step flow: ask for reason before finalising rejection
    pendingRejectReasons.set(telegramId, { matchId, proofOwnerId });
    await User.updateOne({ telegramId }, { state: "awaiting_reject_reason" });
    stopInactivityReminders(matchId, telegramId);
    console.log(`[REJECT_REASON_REQUESTED] telegramId=${telegramId} matchId=${matchId} proofOwnerId=${proofOwnerId}`);

    await ctx.reply(
      "Why are you rejecting this proof? 👀\n\nPlease type a short reason below ✍️\n\nExamples:\n• Wrong screenshot\n• Didn't cut yet\n• Fake proof\n• Username not matching\n• Screenshot unclear",
    );
  });

  async function finalizeRejectProof(
    bot: Telegraf,
    rejecterChatId: number,
    telegramId: number,
    matchId: string,
    proofOwnerId: number,
    rejectReason: string,
  ): Promise<void> {
    // Atomic cancel: only succeeds if match is still active — blocks duplicate rejection
    const match = await Match.findOneAndUpdate(
      { _id: matchId, status: "active" },
      { status: "cancelled" },
      { new: false },
    );
    if (!match) {
      console.log(`[DUPLICATE_CALLBACK_BLOCKED] finalizeRejectProof — telegramId=${telegramId} matchId=${matchId} — already cancelled.`);
      await bot.telegram.sendMessage(rejecterChatId, "⚠️ This match was already resolved.");
      return;
    }

    const timerId = match._id.toString();
    const existingTimer = matchTimers.get(timerId);
    if (existingTimer) { clearTimeout(existingTimer); matchTimers.delete(timerId); }
    const ptKey = `proof:${timerId}:${proofOwnerId}`;
    const existingProofTimer = proofTimers.get(ptKey);
    if (existingProofTimer) { clearTimeout(existingProofTimer); proofTimers.delete(ptKey); }
    const rKey = `proof_reminder:${timerId}:${proofOwnerId}`;
    const existingReminder = proofReminderTimers.get(rKey);
    if (existingReminder) { clearTimeout(existingReminder); proofReminderTimers.delete(rKey); }
    stopInactivityReminders(timerId, proofOwnerId);
    stopInactivityReminders(timerId, telegramId);

    // Apply 24h cooldown to the proof owner
    const cooldownUntil = new Date(Date.now() + COOLDOWN_MS);
    await User.updateOne(
      { telegramId: proofOwnerId },
      { state: "idle", isWaiting: false, queuedAt: null, pendingLink: null, cancelCooldownUntil: cooldownUntil, activeMatchId: null, proofCutByUsername: null },
    );
    await Queue.deleteOne({ telegramId: proofOwnerId });
    console.log(`[MATCH_STATE_FULLY_CLEARED] telegramId=${proofOwnerId} path=proof_rejected_owner`);

    console.log(`[PROOF_REJECTED_WITH_REASON] telegramId=${telegramId} rejected proof of telegramId=${proofOwnerId} for matchId=${matchId} reason="${rejectReason}".`);
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
      } else if (newWeeklyCount >= WEEKLY_REJECT_THRESHOLD && !owner?.isFlagged) {
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

    // Notify proof owner — rejection + reason + cooldown
    try {
      await bot.telegram.sendMessage(
        proofOwnerId,
        `❌ Your proof was rejected by your cut buddy 😵‍💫\n\nReason:\n"${rejectReason}"\n\n⚠️ Strike applied:\n• 1st → 24h ban 🚫\n• 2nd → 24h ban 🚫\n• 3rd → permanent ban 💀`,
      );
    } catch { /* user may have blocked bot */ }

    // Notify rejecter — match cancelled
    await bot.telegram.sendMessage(rejecterChatId, "✅ *Match dibatalkan.*\nTerima kasih kerana membantu menjaga sistem CutSquad.", { parse_mode: "Markdown" });

    // Admin notification — proof rejected with reason
    try {
      const [rejectedUser, rejectorUser] = await Promise.all([
        User.findOne({ telegramId: proofOwnerId }).select("telegramUsername tiktokUsername"),
        User.findOne({ telegramId }).select("telegramUsername tiktokUsername"),
      ]);
      const mytime = new Date().toLocaleString("en-MY", {
        timeZone: "Asia/Kuala_Lumpur",
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit",
        hour12: false,
      });
      const adminMsg =
        `❌ PROOF REJECTED!\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `Rejected User:\n` +
        `• Telegram: @${rejectedUser?.telegramUsername || "N/A"}\n` +
        `• TikTok: @${rejectedUser?.tiktokUsername || "N/A"}\n` +
        `• ID: ${proofOwnerId}\n\n` +
        `Rejected By:\n` +
        `• Telegram: @${rejectorUser?.telegramUsername || "N/A"}\n` +
        `• TikTok: @${rejectorUser?.tiktokUsername || "N/A"}\n` +
        `• ID: ${telegramId}\n\n` +
        `Reason:\n${rejectReason}\n\n` +
        `• Action: 24h cooldown applied\n` +
        `• Time: ${mytime} MYT\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `Proof was rejected by partner. User has been restricted for 24 hours 🚫`;
      for (const adminId of getAdminIds()) {
        try {
          await bot.telegram.sendMessage(adminId, adminMsg);
          console.log(`[ADMIN_PROOF_REJECTED_NOTIFIED] matchId=${matchId} proofOwner=${proofOwnerId} rejector=${telegramId} reason="${rejectReason}" notified adminId=${adminId}`);
        } catch (err) {
          console.error(`[ADMIN_MATCH_RESULT_NOTIFY_FAILED] matchId=${matchId} proof-rejected adminId=${adminId}: ${(err as Error).message}`);
        }
      }
    } catch (err) {
      console.error(`[ADMIN_MATCH_RESULT_NOTIFY_FAILED] matchId=${matchId} proof-rejected fetch error: ${(err as Error).message}`);
    }

    // Re-queue the innocent rejecter with original FIFO priority
    const rejecter = await User.findOne({ telegramId }).select("pendingLink");
    const rejecterLink = rejecter?.pendingLink ?? (match.user1Id === telegramId ? match.link1 : match.link2);
    if (rejecterLink) {
      await requeueUser(bot, telegramId, rejecterLink);
    } else {
      await User.updateOne({ telegramId }, { state: "awaiting_cut_link", isWaiting: false, queuedAt: null, pendingLink: null, activeMatchId: null, proofCutByUsername: null });
      console.log(`[MATCH_STATE_FULLY_CLEARED] telegramId=${telegramId} path=proof_rejected_rejecter_fallback`);
    }
  }

  bot.action("cut_more", async (ctx) => {
    await ctx.answerCbQuery();
    const telegramId = ctx.from!.id;

    const sus = await checkSuspension(telegramId);
    if (sus.suspended) {
      if (sus.reason === "banned") { console.log(`[BANNED_USER_BLOCKED_ACTION] telegramId=${telegramId} action=cut_more`); }
      else { console.log(`[COOLDOWN_USER_BLOCKED_ACTION] telegramId=${telegramId} action=cut_more`); }
      await ctx.reply(sus.message); return;
    }

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
