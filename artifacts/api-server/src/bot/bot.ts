import { Telegraf, Markup } from "telegraf";
import { message } from "telegraf/filters";
import { User } from "./models/user";
import { Match } from "./models/match";
import { Referral } from "./models/referral";
import { logger } from "../lib/logger";

const matchTimers = new Map<string, ReturnType<typeof setTimeout>>();

function generateReferralCode(): string {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function extractTikTokUsername(input: string): string | null {
  const trimmed = input.trim();

  if (trimmed.startsWith("@")) return trimmed.slice(1);

  // Matches with or without protocol and www, strips query params
  // e.g. https://www.tiktok.com/@user, tiktok.com/@user, www.tiktok.com/@user?r=1
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

  const eligibleUsers = await User.find({
    telegramId: { $ne: newUserTelegramId },
    tiktokUsername: { $nin: ["__pending__", ""] },
    isBanned: false,
    $and: [
      {
        $or: [
          { suspendedUntil: null },
          { suspendedUntil: { $lte: new Date() } },
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
    if (!user || user.state !== "in_match") continue;
    await User.updateOne(
      { telegramId: uid },
      { state: "awaiting_cut_link", pendingLink: null },
    );
    await bot.telegram.sendMessage(uid, expireMsg);
  }

  matchTimers.delete(matchId);
}

async function tryMatch(bot: Telegraf, telegramId: number): Promise<void> {
  const currentUser = await User.findOne({ telegramId });
  if (!currentUser || currentUser.state !== "in_queue") return;

  const excludeIds = [telegramId];
  if (currentUser.lastMatchPartnerId)
    excludeIds.push(currentUser.lastMatchPartnerId);

  const partner = await User.findOne({
    telegramId: { $nin: excludeIds },
    state: "in_queue",
    isBanned: false,
    $or: [{ suspendedUntil: null }, { suspendedUntil: { $lte: new Date() } }],
  });

  if (!partner) return;

  const expiresAt = new Date(Date.now() + 4 * 60 * 1000);
  const match = await Match.create({
    user1Id: telegramId,
    user2Id: partner.telegramId,
    link1: currentUser.pendingLink ?? "",
    link2: partner.pendingLink ?? "",
    expiresAt,
  });

  await User.updateOne(
    { telegramId },
    { state: "in_match", lastMatchPartnerId: partner.telegramId },
  );
  await User.updateOne(
    { telegramId: partner.telegramId },
    { state: "in_match", lastMatchPartnerId: telegramId },
  );

  const matchId = (match._id as { toString(): string }).toString();

  const msgForUser = `🎯 *Partner jumpa!*\n\nLink dia 👇\n${partner.pendingLink}\n\n1️⃣ Tap link tu kat TikTok\n2️⃣ Screenshot bukti kau dah cut\n3️⃣ Hantar screenshot sini\n\n⏰ *4 minit je tau!*`;
  const msgForPartner = `🎯 *Partner jumpa!*\n\nLink dia 👇\n${currentUser.pendingLink}\n\n1️⃣ Tap link tu kat TikTok\n2️⃣ Screenshot bukti kau dah cut\n3️⃣ Hantar screenshot sini\n\n⏰ *4 minit je tau!*`;

  await bot.telegram.sendMessage(telegramId, msgForUser, {
    parse_mode: "Markdown",
  });
  await bot.telegram.sendMessage(partner.telegramId, msgForPartner, {
    parse_mode: "Markdown",
  });

  const timer = setTimeout(async () => {
    await handleMatchExpiry(bot, matchId, telegramId, partner.telegramId);
  }, 4 * 60 * 1000);

  matchTimers.set(matchId, timer);
}

async function confirmSwap(
  bot: Telegraf,
  telegramId: number,
): Promise<void> {
  const user = await User.findOne({ telegramId });
  if (!user || user.state !== "in_match") return;

  const match = await Match.findOne({
    $or: [{ user1Id: telegramId }, { user2Id: telegramId }],
    status: "active",
  });

  if (!match) {
    await bot.telegram.sendMessage(
      telegramId,
      "Hmm takde match active la. Cuba /start balik k.",
    );
    return;
  }

  const isUser1 = match.user1Id === telegramId;
  const partnerId = isUser1 ? match.user2Id : match.user1Id;

  if (isUser1) {
    await Match.updateOne({ _id: match._id }, { user1Confirmed: true });
  } else {
    await Match.updateOne({ _id: match._id }, { user2Confirmed: true });
  }

  const updatedMatch = await Match.findById(match._id);
  if (!updatedMatch) return;

  const newBalance = Math.max(0, user.cutBalance - 1);
  await User.updateOne(
    { telegramId },
    { state: "awaiting_cut_link", cutBalance: newBalance, pendingLink: null },
  );

  if (newBalance === 0) {
    const refLink = `https://t.me/${(await bot.telegram.getMe()).username}?start=ref_${user.referralCode}`;
    await bot.telegram.sendMessage(
      telegramId,
      `✅ *Swap done!* Cut babi tinggal: *0/16* 😮\n\nKau dah habis semua cuts!\n\n🔥 Nak lagi? Share bot ni & dapat *+3 cuts* setiap orang yang join!\n\n${refLink}`,
      { parse_mode: "Markdown" },
    );
  } else {
    await bot.telegram.sendMessage(
      telegramId,
      `✅ *Swap done!* Cut baki: *${newBalance}/16* 🎉`,
      {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([
          Markup.button.callback("🔁 Cut More!", "cut_more"),
        ]),
      },
    );
  }

  if (updatedMatch.user1Confirmed && updatedMatch.user2Confirmed) {
    const timerId = match._id.toString();
    const existingTimer = matchTimers.get(timerId);
    if (existingTimer) {
      clearTimeout(existingTimer);
      matchTimers.delete(timerId);
    }
    await Match.updateOne({ _id: match._id }, { status: "completed" });
  }

  const partner = await User.findOne({ telegramId: partnerId });
  if (partner && partner.state === "in_match") {
    await bot.telegram.sendMessage(
      partnerId,
      "📸 Partner dah hantar proof! Tunggu turn kau — hantar screenshot jugak k.",
    );
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

    if (existingUser && existingUser.tiktokUsername) {
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

    if (user.state !== "in_match") {
      await ctx.reply(
        "Screenshot untuk apa ni? 😅 Kau takde match active laa. Submit link dulu!",
      );
      return;
    }

    await ctx.reply("🔍 Checking proof kau...");

    await confirmSwap(bot, telegramId);
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

      await User.updateOne(
        { telegramId },
        { state: "in_queue", pendingLink: text },
      );

      console.log(`[QUEUE] telegramId=${telegramId} (@${user.tiktokUsername}) joined the queue.`);

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
        "Hantar *screenshot* sebagai proof kau dah swap k! 📸",
        { parse_mode: "Markdown" },
      );
      return;
    }

    await ctx.reply(
      "Taip /start untuk mula atau /status untuk check progress kau!",
    );
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
