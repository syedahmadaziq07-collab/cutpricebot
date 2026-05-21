import { Telegraf, Markup } from "telegraf";
import { message } from "telegraf/filters";
import { User } from "./models/user";
import { Match } from "./models/match";
import { MatchHistory } from "./models/matchHistory";
import { Referral } from "./models/referral";
import { logger } from "../lib/logger";

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
  return /(?:https?:\/\/)?(?:www\.)?(tiktok\.com|vm\.tiktok\.com|vt\.tiktok\.com)\//i.test(
    url,
  );
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
    $and: [
      {
        $or: [
          { suspendedUntil: null },
          { suspendedUntil: { $lte: now } },
        ],
      },
      {
        $or: [
          { cancelCooldownUntil: null },
          { cancelCooldownUntil: { $lte: now } },
        ],
      },
      {
        $or: [
          { lastNotifiedAt: null },
          { lastNotifiedAt: { $lte: tenMinutesAgo } },
        ],
      },
    ],
  });

  console.log(
    `[QUEUE] @${newUserTikTok} joined queue. Notifying ${eligibleUsers.length} eligible user(s).`,
  );

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
      await User.updateOne(
        { telegramId: u.telegramId },
        { lastNotifiedAt: new Date() },
      );
      sentCount++;
      console.log(`[NOTIFY] Sent notification to telegramId=${u.telegramId} (@${u.tiktokUsername})`);
    } catch (err) {
      console.error(
        `[NOTIFY] Failed to notify telegramId=${u.telegramId}: ${(err as Error).message}`,
      );
    }
  }

  console.log(
    `[NOTIFY] Notifications sent: ${sentCount}/${eligibleUsers.length}`,
  );
}

async function checkSuspension(
  telegramId: number,
): Promise<{ suspended: boolean; message: string }> {
  const user = await User.findOne({ telegramId });
  if (!user) return { suspended: false, message: "" };
  if (user.isBanned)
    return {
      suspended: true,
      message: "🚫 Kau dah kena permanent ban. Game over bro.",
    };
  if (user.suspendedUntil && user.suspendedUntil > new Date()) {
    const remaining = Math.ceil(
      (user.suspendedUntil.getTime() - Date.now()) / (1000 * 60 * 60),
    );
    return {
      suspended: true,
      message: `⏳ Kau still kena suspend. Tunggu lagi ${remaining} jam k.`,
    };
  }
  return { suspended: false, message: "" };
}

async function issueStrike(bot: Telegraf, telegramId: number): Promise<void> {
  const user = await User.findOne({ telegramId });
  if (!user) return;

  const newStrikes = user.strikes + 1;

  if (newStrikes >= 3) {
    await User.updateOne(
      { telegramId },
      { strikes: newStrikes, isBanned: true, state: "idle", pendingLink: null },
    );
    await bot.telegram.sendMessage(
      telegramId,
      "🚫 Strike 3! Kau dah kena *permanent ban*.\nPunca: screenshot tak valid / proof tak cukup.\n\nTa-ta! 👋",
      { parse_mode: "Markdown" },
    );
  } else {
    const suspendedUntil = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await User.updateOne(
      { telegramId },
      {
        strikes: newStrikes,
        suspendedUntil,
        state: "idle",
        pendingLink: null,
      },
    );
    const msgs = [
      `⚠️ Strike ${newStrikes}/3!\nScreenshot tak valid. Kau kena *suspend 24 jam*.\n\nJangan repeat k! 😤`,
      `⚠️ Strike ${newStrikes}/3!\nProof tak lepas semak. 24 jam suspend dimulakan.\n\nLast warning ni! 😡`,
    ];
    await bot.telegram.sendMessage(
      telegramId,
      msgs[newStrikes - 1] || msgs[0]!,
      { parse_mode: "Markdown" },
    );
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

  const expireMsg =
    "⏰ 4 minit dah habis! Partner tak respond.\n\nSubmit link baru untuk rematch k 👇";

  for (const uid of [user1Id, user2Id]) {
    const user = await User.findOne({ telegramId: uid });
    if (!user) continue;
    const activeStates = ["in_match", "awaiting_proof", "awaiting_partner_approval"];
    if (!activeStates.includes(user.state)) continue;
    await User.updateOne(
      { telegramId: uid },
      { state: "awaiting_cut_link", pendingLink: null, isWaiting: false, queuedAt: null },
    );
    console.log(`[QUEUE_REMOVE] telegramId=${uid} removed from queue (match expired).`);
    console.log(`[WAITING_CLEARED] isWaiting=false, queuedAt=null set for telegramId=${uid} (expiry).`);
    await bot.telegram.sendMessage(uid, expireMsg);
  }

  matchTimers.delete(matchId);
}

const COOLDOWN_MS = 24 * 60 * 60 * 1000;

async function hasCooldown(userIdA: number, userIdB: number): Promise<boolean> {
  const since = new Date(Date.now() - COOLDOWN_MS);
  const existing = await MatchHistory.findOne({
    $or: [
      { userIdA, userIdB },
      { userIdA: userIdB, userIdB: userIdA },
    ],
    matchedAt: { $gte: since },
  });
  return existing !== null;
}

async function tryMatch(bot: Telegraf, telegramId: number): Promise<void> {
  const currentUser = await User.findOne({ telegramId });
  if (!currentUser || currentUser.state !== "in_queue") return;

  const candidates = await User.find({
    telegramId: { $ne: telegramId },
    state: "in_queue",
    isBanned: false,
    $or: [{ suspendedUntil: null }, { suspendedUntil: { $lte: new Date() } }],
  }).sort({ queuedAt: 1 });

  if (candidates.length === 0) {
    console.log(
      `[MATCH] No candidates in queue for @${currentUser.tiktokUsername} (telegramId=${telegramId}).`,
    );
    return;
  }

  let partner = null;
  for (const candidate of candidates) {
    const onCooldown = await hasCooldown(telegramId, candidate.telegramId);
    if (onCooldown) {
      console.log(
        `[COOLDOWN] Pair skipped — @${currentUser.tiktokUsername} & @${candidate.tiktokUsername} matched within last 24h. Cooldown active.`,
      );
      continue;
    }
    partner = candidate;
    break;
  }

  if (!partner) {
    console.log(
      `[MATCH] No eligible partner for @${currentUser.tiktokUsername} — all candidates on 24h cooldown.`,
    );
    return;
  }

  console.log(
    `[MATCH] Match created: @${currentUser.tiktokUsername} (telegramId=${telegramId}) <-> @${partner.tiktokUsername} (telegramId=${partner.telegramId})`,
  );

  const now = new Date();
  const expiresAt = new Date(Date.now() + 4 * 60 * 1000);

  const [match] = await Promise.all([
    Match.create({
      user1Id: telegramId,
      user2Id: partner.telegramId,
      link1: currentUser.pendingLink ?? "",
      link2: partner.pendingLink ?? "",
      expiresAt,
    }),
    MatchHistory.create({
      userIdA: telegramId,
      userIdB: partner.telegramId,
      matchedAt: now,
    }),
  ]);

  await Promise.all([
    User.updateOne(
      { telegramId },
      { state: "in_match", lastMatchPartnerId: partner.telegramId, isWaiting: false, queuedAt: null },
    ),
    User.updateOne(
      { telegramId: partner.telegramId },
      { state: "in_match", lastMatchPartnerId: telegramId, isWaiting: false, queuedAt: null },
    ),
  ]);

  console.log(`[QUEUE_REMOVE] telegramId=${telegramId} (@${currentUser.tiktokUsername}) removed from queue.`);
  console.log(`[QUEUE_REMOVE] telegramId=${partner.telegramId} (@${partner.tiktokUsername}) removed from queue.`);
  console.log(`[WAITING_CLEARED] isWaiting=false, queuedAt=null set for telegramId=${telegramId}.`);
  console.log(`[WAITING_CLEARED] isWaiting=false, queuedAt=null set for telegramId=${partner.telegramId}.`);
  console.log(`[MATCH_SUCCESS] @${currentUser.tiktokUsername} <-> @${partner.tiktokUsername} matched successfully.`);

  const matchId = (match._id as { toString(): string }).toString();

  const matchButtons = Markup.inlineKeyboard([
    Markup.button.callback("✅ Done Cut", "done_cut"),
    Markup.button.callback("❌ Cancel Match (24h cooldown)", "cancel_match"),
  ]);

  const msgForCurrentUser =
    `✅ *Partner dijumpai!*\n\n` +
    `Partner anda:\n@${partner.tiktokUsername}\n\n` +
    `Link cut partner:\n${partner.pendingLink}\n\n` +
    `Sila cut link partner anda dahulu 🤝`;

  const msgForPartner =
    `✅ *Partner dijumpai!*\n\n` +
    `Partner anda:\n@${currentUser.tiktokUsername}\n\n` +
    `Link cut partner:\n${currentUser.pendingLink}\n\n` +
    `Sila cut link partner anda dahulu 🤝`;

  await Promise.all([
    bot.telegram.sendMessage(telegramId, msgForCurrentUser, { parse_mode: "Markdown", ...matchButtons }),
    bot.telegram.sendMessage(partner.telegramId, msgForPartner, { parse_mode: "Markdown", ...matchButtons }),
  ]);

  const timer = setTimeout(async () => {
    await handleMatchExpiry(bot, matchId, telegramId, partner!.telegramId);
  }, 4 * 60 * 1000);

  matchTimers.set(matchId, timer);
}

async function checkAndCompleteMatch(
  bot: Telegraf,
  matchId: string,
): Promise<void> {
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
    await User.updateOne(
      { telegramId: uid },
      {
        state: "awaiting_cut_link",
        cutBalance: newBalance,
        pendingLink: null,
        queuedAt: null,
        isWaiting: false,
      },
    );

    if (newBalance === 0) {
      const me = await bot.telegram.getMe();
      const refLink = `https://t.me/${me.username}?start=ref_${user.referralCode}`;
      await bot.telegram.sendMessage(
        uid,
        `🎉 *Swap selesai!*\n\nTerima kasih kerana menggunakan CutSquad 🤝\n\nCut baki: *0/16* 😮\n\nKau dah habis semua cuts!\n\n🔥 Nak lagi? Share bot ni & dapat *+3 cuts* setiap orang yang join!\n\n${refLink}`,
        { parse_mode: "Markdown" },
      );
    } else {
      await bot.telegram.sendMessage(
        uid,
        `🎉 *Swap selesai!*\n\nTerima kasih kerana menggunakan CutSquad 🤝\n\nCut baki: *${newBalance}/16*`,
        {
          parse_mode: "Markdown",
          ...Markup.inlineKeyboard([Markup.button.callback("🔁 Cut Lagi!", "cut_more")]),
        },
      );
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
      if (sus.suspended) {
        await ctx.reply(sus.message);
        return;
      }
      await ctx.reply(
        `Eh, kau dah register la @${existingUser.tiktokUsername}! 👋\n\nCut baki: *${existingUser.cutBalance}/16*\n\nHantar TikTok cut price link untuk mula! 🔗`,
        { parse_mode: "Markdown" },
      );
      await User.updateOne({ telegramId }, { state: "awaiting_cut_link" });
      return;
    }

    let referralCode: string | null = null;
    if (payload && payload.startsWith("ref_")) {
      referralCode = payload.slice(4);
    }

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

    if (referralCode) {
      await ctx.reply(
        "👋 Weh selamat datang ke *CutSquad*!\n\nBot ni untuk swap TikTok cut price links — kau cut gue, gue cut kau! 🔁\n\nFirst, hantar link profile TikTok kau 👇\n_(contoh: https://www.tiktok.com/@username)_",
        { parse_mode: "Markdown" },
      );
    } else {
      await ctx.reply(
        "👋 Weh selamat datang ke *CutSquad*!\n\nBot ni untuk swap TikTok cut price links — kau cut gue, gue cut kau! 🔁\n\nHantar link profile TikTok kau 👇\n_(contoh: https://www.tiktok.com/@username)_",
        { parse_mode: "Markdown" },
      );
    }
  });

  bot.command("balance", async (ctx) => {
    const user = await User.findOne({ telegramId: ctx.from.id });
    if (!user || user.tiktokUsername === "__pending__") {
      await ctx.reply("Kau belum register lagi. Taip /start dulu k!");
      return;
    }
    await ctx.reply(
      `💰 *Balance kau:*\n\nCut baki: *${user.cutBalance}/16*\nStrike: ${user.strikes}/3\n\nReferral link kau:\n👇`,
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
      `🔥 *Referral link kau:*\n\n${refLink}\n\nShare ni — setiap kawan yang join = *+3 cuts* untuk kau!`,
      { parse_mode: "Markdown" },
    );
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
      in_queue: "🔍 Cari partner...",
      in_match: "🤝 In match",
      awaiting_proof: "📸 Menunggu bukti",
      awaiting_partner_approval: "⏳ Menunggu kelulusan partner",
    };
    await ctx.reply(
      `📊 *Status kau:*\n\nTikTok: @${user.tiktokUsername}\nCut baki: ${user.cutBalance}/16\nStrikes: ${user.strikes}/3\nStatus: ${statusMap[user.state] ?? user.state}`,
      { parse_mode: "Markdown" },
    );
  });

  bot.on(message("photo"), async (ctx) => {
    const telegramId = ctx.from.id;
    console.log(`[MSG] photo from telegramId=${telegramId}`);

    const sus = await checkSuspension(telegramId);
    if (sus.suspended) {
      await ctx.reply(sus.message);
      return;
    }

    const user = await User.findOne({ telegramId });
    if (!user || user.tiktokUsername === "__pending__") {
      await ctx.reply("Kau belum register lagi. Taip /start dulu k!");
      return;
    }

    if (user.state === "in_match") {
      await ctx.reply(
        "Sila tekan butang *✅ Done Cut* dahulu sebelum menghantar bukti ya.",
        { parse_mode: "Markdown" },
      );
      return;
    }

    if (user.state === "awaiting_partner_approval") {
      await ctx.reply(
        "⏳ Bukti anda sudah dihantar. Sila tunggu partner anda semak dan approve terlebih dahulu.",
      );
      return;
    }

    if (user.state !== "awaiting_proof") {
      await ctx.reply(
        "Tiada match aktif. Hantar link TikTok anda dahulu untuk mula.",
      );
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
      await ctx.reply(
        "⏳ Bukti anda sudah dihantar. Sila tunggu partner anda semak dan approve terlebih dahulu.",
      );
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
      await Match.updateOne(
        { _id: match._id },
        {
          user1ProofSubmitted: true,
          user1ProofMessageId: proofMessageId,
          user1ProofSubmittedAt: now,
          user1Confirmed: true,
        },
      );
    } else {
      await Match.updateOne(
        { _id: match._id },
        {
          user2ProofSubmitted: true,
          user2ProofMessageId: proofMessageId,
          user2ProofSubmittedAt: now,
          user2Confirmed: true,
        },
      );
    }

    console.log(`[PROOF_SUBMITTED] telegramId=${telegramId} submitted proof for matchId=${matchId}.`);

    await User.updateOne({ telegramId }, { state: "awaiting_partner_approval" });

    await ctx.reply(
      "✅ Bukti anda telah dihantar.\nTunggu partner anda semak dan approve bukti tersebut.",
    );

    const approveButtons = Markup.inlineKeyboard([
      Markup.button.callback("✅ Approve Proof", `approve_proof:${matchId}:${telegramId}`),
      Markup.button.callback("❌ Reject Proof", `reject_proof:${matchId}:${telegramId}`),
    ]);

    await bot.telegram.sendPhoto(
      partnerId,
      proofFileId,
      {
        caption:
          `📸 *Partner anda telah menghantar bukti cut.*\n\nSila semak bukti di bawah sebelum approve.`,
        parse_mode: "Markdown",
        ...approveButtons,
      },
    );
  });

  bot.on(message("text"), async (ctx) => {
    const telegramId = ctx.from.id;
    const text = ctx.message.text.trim();
    console.log(`[MSG] text from telegramId=${telegramId}: ${text.slice(0, 80)}`);

    if (text.startsWith("/")) return;

    const sus = await checkSuspension(telegramId);
    if (sus.suspended) {
      await ctx.reply(sus.message);
      return;
    }

    const user = await User.findOne({ telegramId });

    if (!user || user.tiktokUsername === "__pending__") {
      if (user?.state === "awaiting_tiktok_profile") {
        console.log(`[TIKTOK] Received profile link from telegramId=${telegramId}: ${text.slice(0, 100)}`);
        const username = extractTikTokUsername(text);
        if (!username) {
          console.warn(`[TIKTOK] Username extraction failed for telegramId=${telegramId}, input="${text.slice(0, 100)}"`);
          await ctx.reply(
            "Hmm link tu tak valid la 😕\nHantar betul2 k — contoh:\nhttps://www.tiktok.com/@username",
          );
          return;
        }

        const referralDoc = await User.findOne({ telegramId });
        const pendingRef = (referralDoc as any)?.pendingReferralCode ?? null;

        await User.updateOne(
          { telegramId },
          {
            tiktokUsername: username,
            tiktokProfileLink: text,
            telegramUsername: ctx.from.username ?? "",
            state: "awaiting_cut_link",
          },
        );

        if (pendingRef) {
          const referrer = await User.findOne({ referralCode: pendingRef });
          if (referrer && referrer.telegramId !== telegramId) {
            await User.updateOne(
              { telegramId },
              { referredBy: pendingRef },
            );
            await User.updateOne(
              { telegramId: referrer.telegramId },
              { $inc: { cutBalance: 3 } },
            );
            await Referral.create({
              referralCode: pendingRef,
              referrerId: referrer.telegramId,
              referredId: telegramId,
            });
            await bot.telegram.sendMessage(
              referrer.telegramId,
              `🎉 Kawan kau baru je join guna link kau!\n\n*+3 cuts* dah masuk balance kau! 🔥`,
              { parse_mode: "Markdown" },
            );
          }
        }

        const me = await bot.telegram.getMe();
        const refLink = `https://t.me/${me.username}?start=ref_${(await User.findOne({ telegramId }))!.referralCode}`;

        await ctx.reply(
          `Welcome @${username}! ✅\n\nKau dapat *16 cuts* untuk start!\n\nReferral link kau:\n${refLink}\n\nSekarang hantar TikTok cut price link kau 👇`,
          { parse_mode: "Markdown" },
        );
      } else {
        await ctx.reply(
          "Taip /start dulu la bro untuk register! 👋",
        );
      }
      return;
    }

    if (user.state === "awaiting_tiktok_profile") {
      console.log(`[TIKTOK] Received profile link from telegramId=${telegramId}: ${text.slice(0, 100)}`);
      const username = extractTikTokUsername(text);
      if (!username) {
        console.warn(`[TIKTOK] Username extraction failed for telegramId=${telegramId}, input="${text.slice(0, 100)}"`);
        await ctx.reply(
          "Link tu pelik sikit 😕\nHantar link profile TikTok betul k — contoh:\nhttps://www.tiktok.com/@username",
        );
        return;
      }

      await User.updateOne(
        { telegramId },
        {
          tiktokUsername: username,
          tiktokProfileLink: text,
          state: "awaiting_cut_link",
        },
      );
      await ctx.reply(`Welcome @${username}! ✅\n\nSekarang hantar TikTok cut price link kau 👇`);
      return;
    }

    if (user.state === "awaiting_cut_link") {
      if (user.cancelCooldownUntil && user.cancelCooldownUntil > new Date()) {
        const remaining = Math.ceil(
          (user.cancelCooldownUntil.getTime() - Date.now()) / (1000 * 60 * 60),
        );
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
          `😬 Cuts kau dah habis bro!\n\n🔥 Share bot ni & dapat *+3 cuts* setiap orang yang join!\n\n${refLink}`,
          { parse_mode: "Markdown" },
        );
        return;
      }

      if (!isValidTikTokLink(text)) {
        await ctx.reply(
          "Link ni takde life la 💀 Try lain k!\n_(Kena link TikTok yang valid)_",
          { parse_mode: "Markdown" },
        );
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

      const now = new Date();
      await User.updateOne(
        { telegramId },
        { state: "in_queue", pendingLink: text, isWaiting: true, queuedAt: now },
      );

      console.log(`[QUEUE] telegramId=${telegramId} (@${user.tiktokUsername}) joined the queue at ${now.toISOString()}. isWaiting=true`);

      await ctx.reply(
        "Secured! 🔒 Finding ur partner…\n\n_(Kau dalam queue — bot tengah cari match sekarang)_",
        { parse_mode: "Markdown" },
      );

      await notifyQueueUsers(bot, user.tiktokUsername, telegramId);
      await tryMatch(bot, telegramId);
      return;
    }

    if (user.state === "in_queue") {
      await ctx.reply(
        "Relax bro! 😅 Tengah cari partner kau. Tunggu sekejap k…",
      );
      return;
    }

    if (user.state === "in_match") {
      await ctx.reply(
        "Sila tekan butang *✅ Done Cut* apabila anda selesai cut link partner.",
        { parse_mode: "Markdown" },
      );
      return;
    }

    if (user.state === "awaiting_proof") {
      await ctx.reply(
        "Sila hantar *screenshot* sebagai bukti anda telah cut link partner. 📸",
        { parse_mode: "Markdown" },
      );
      return;
    }

    if (user.state === "awaiting_partner_approval") {
      await ctx.reply(
        "⏳ Bukti anda sudah dihantar. Sila tunggu partner anda semak dan approve terlebih dahulu.",
      );
      return;
    }

    await ctx.reply(
      "Taip /start untuk mula atau /status untuk semak status anda.",
    );
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
    await ctx.reply(
      "📸 Sila hantar *screenshot* sebagai bukti anda telah cut link partner.",
      { parse_mode: "Markdown" },
    );
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

    if (!match) {
      await ctx.reply("Tiada match aktif.");
      return;
    }

    const partnerId = match.user1Id === telegramId ? match.user2Id : match.user1Id;
    const partner = await User.findOne({ telegramId: partnerId });

    await Match.updateOne({ _id: match._id }, { status: "cancelled" });

    const timerId = match._id.toString();
    const existingTimer = matchTimers.get(timerId);
    if (existingTimer) {
      clearTimeout(existingTimer);
      matchTimers.delete(timerId);
    }

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

    if (partner) {
      const partnerHasLink = !!partner.pendingLink;
      const now = new Date();

      await User.updateOne(
        { telegramId: partnerId },
        partnerHasLink
          ? { state: "in_queue", isWaiting: true, queuedAt: now }
          : { state: "awaiting_cut_link", isWaiting: false, queuedAt: null },
      );

      await bot.telegram.sendMessage(
        partnerId,
        "⚠️ *Partner anda telah membatalkan match.*\n\nSistem sedang mencari partner baru untuk anda 🤝",
        { parse_mode: "Markdown" },
      );

      console.log(`[PARTNER_REQUEUED] telegramId=${partnerId} (@${partner.tiktokUsername ?? "unknown"}) requeued after cancel.`);

      if (partnerHasLink) {
        await tryMatch(bot, partnerId);
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
    if (!match || match.status !== "active") {
      await ctx.reply("Match ini tidak lagi aktif.");
      return;
    }

    const isApproverUser1 = match.user1Id === telegramId;
    const isApproverUser2 = match.user2Id === telegramId;

    if (!isApproverUser1 && !isApproverUser2) {
      await ctx.reply("Anda bukan sebahagian daripada match ini.");
      return;
    }

    const isProofOwnerUser1 = match.user1Id === proofOwnerId;

    if (isProofOwnerUser1) {
      if (match.user1ProofApprovedByPartner) {
        await ctx.reply("Bukti ini sudah diapprove sebelum ini.");
        return;
      }
      await Match.updateOne({ _id: matchId }, { user1ProofApprovedByPartner: true });
    } else {
      if (match.user2ProofApprovedByPartner) {
        await ctx.reply("Bukti ini sudah diapprove sebelum ini.");
        return;
      }
      await Match.updateOne({ _id: matchId }, { user2ProofApprovedByPartner: true });
    }

    console.log(`[PROOF_APPROVED] telegramId=${telegramId} approved proof of telegramId=${proofOwnerId} for matchId=${matchId}.`);

    await bot.telegram.sendMessage(
      proofOwnerId,
      "✅ Bukti anda telah diapprove oleh partner.",
    );

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
    if (!match || match.status !== "active") {
      await ctx.reply("Match ini tidak lagi aktif.");
      return;
    }

    const isApproverUser1 = match.user1Id === telegramId;
    const isApproverUser2 = match.user2Id === telegramId;

    if (!isApproverUser1 && !isApproverUser2) {
      await ctx.reply("Anda bukan sebahagian daripada match ini.");
      return;
    }

    const isProofOwnerUser1 = match.user1Id === proofOwnerId;

    if (isProofOwnerUser1) {
      await Match.updateOne(
        { _id: matchId },
        {
          user1ProofSubmitted: false,
          user1ProofMessageId: null,
          user1ProofSubmittedAt: null,
          user1Confirmed: false,
        },
      );
    } else {
      await Match.updateOne(
        { _id: matchId },
        {
          user2ProofSubmitted: false,
          user2ProofMessageId: null,
          user2ProofSubmittedAt: null,
          user2Confirmed: false,
        },
      );
    }

    console.log(`[PROOF_REJECTED] telegramId=${telegramId} rejected proof of telegramId=${proofOwnerId} for matchId=${matchId}.`);

    await User.updateOne({ telegramId: proofOwnerId }, { state: "awaiting_proof" });

    await bot.telegram.sendMessage(
      proofOwnerId,
      "⚠️ Bukti anda ditolak oleh partner.\n\nSila hantar screenshot yang jelas.",
    );

    await ctx.reply("✅ Anda telah menolak bukti partner. Mereka akan menghantar semula.");
  });

  bot.action("cut_more", async (ctx) => {
    await ctx.answerCbQuery();
    const telegramId = ctx.from!.id;

    const sus = await checkSuspension(telegramId);
    if (sus.suspended) {
      await ctx.reply(sus.message);
      return;
    }

    const user = await User.findOne({ telegramId });
    if (!user) return;

    if (user.cutBalance <= 0) {
      const me = await bot.telegram.getMe();
      const refLink = `https://t.me/${me.username}?start=ref_${user.referralCode}`;
      await ctx.reply(
        `😬 Cuts kau dah habis bro!\n\n🔥 *Nak lagi? Share bot ni & dapat +3 cuts setiap orang yang join!*\n\n${refLink}`,
        { parse_mode: "Markdown" },
      );
      return;
    }

    await User.updateOne({ telegramId }, { state: "awaiting_cut_link" });
    await ctx.reply(
      `🔁 Jom cut lagi!\n\nCut baki: *${user.cutBalance}/16*\n\nHantar TikTok cut price link baru kau 👇`,
      { parse_mode: "Markdown" },
    );
  });

  bot.catch((err) => {
    logger.error({ err }, "Bot error");
  });

  return bot;
}
