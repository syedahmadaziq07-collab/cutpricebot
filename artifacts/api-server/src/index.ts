import app from "./app";
import { logger } from "./lib/logger";
import { connectDB } from "./bot/db";
import { createBot } from "./bot/bot";

const rawPort = process.env["PORT"];
const port = rawPort ? Number(rawPort) : null;

if (port !== null && (Number.isNaN(port) || port <= 0)) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

async function main() {
  await connectDB();

  const bot = createBot();
  console.log("Clearing any existing Telegram webhook...");
  await bot.telegram.deleteWebhook({ drop_pending_updates: false });
  console.log("Webhook cleared. Starting polling...");
  await bot.launch();
  console.log("Bot is running with polling 🟢");
  logger.info("CutSquad bot launched ✅");

  process.once("SIGINT", () => bot.stop("SIGINT"));
  process.once("SIGTERM", () => bot.stop("SIGTERM"));

  if (port !== null) {
    app.listen(port, (err) => {
      if (err) {
        logger.error({ err }, "Error listening on port");
        process.exit(1);
      }
      logger.info({ port }, "Server listening");
    });
  } else {
    logger.info("No PORT set — HTTP server not started");
  }
}

main().catch((err) => {
  logger.error({ err }, "Fatal startup error");
  process.exit(1);
});
