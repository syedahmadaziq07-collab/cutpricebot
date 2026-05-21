import mongoose, { type Document } from "mongoose";

export interface IUser extends Document {
  telegramId: number;
  telegramUsername: string;
  tiktokUsername: string;
  tiktokProfileLink: string;
  referralCode: string;
  referredBy: string | null;
  cutBalance: number;
  strikes: number;
  suspendedUntil: Date | null;
  isBanned: boolean;
  lastMatchPartnerId: number | null;
  isWaiting: boolean;
  activeMatchId: string | null;
  cancelCooldownUntil: Date | null;
  state: string;
  pendingLink: string | null;
  lastNotifiedAt: Date | null;
  queuedAt: Date | null;
  originalQueuedAt: Date | null;
  lastDailyReset: Date | null;
  dailyReferralCutsToday: number;
  dailyReferralResetAt: Date | null;
  firstSwapCompleted: boolean;
  totalRejectCount: number;
  totalApprovedCount: number;
  lastRejectAt: Date | null;
  cooldownCount: number;
  isFlagged: boolean;
  weeklyRejectWindowStart: Date | null;
  weeklyRejectWindowCount: number;
  noResponseStrikeCount: number;
  noResponseStrikeWindowStart: Date | null;
  tiktokUsernameLocked: boolean;
  tiktokLockedAt: Date | null;
  usernameConflictReset: boolean;
  lastResetNotifiedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const userSchema = new mongoose.Schema<IUser>(
  {
    telegramId: { type: Number, required: true, unique: true },
    telegramUsername: { type: String, default: "" },
    tiktokUsername: { type: String, required: true },
    tiktokProfileLink: { type: String, default: "" },
    referralCode: { type: String, required: true, unique: true },
    referredBy: { type: String, default: null },
    cutBalance: { type: Number, default: 7 },
    strikes: { type: Number, default: 0 },
    suspendedUntil: { type: Date, default: null },
    isBanned: { type: Boolean, default: false },
    lastMatchPartnerId: { type: Number, default: null },
    isWaiting: { type: Boolean, default: false },
    activeMatchId: { type: String, default: null },
    cancelCooldownUntil: { type: Date, default: null },
    state: { type: String, default: "idle" },
    pendingLink: { type: String, default: null },
    lastNotifiedAt: { type: Date, default: null },
    queuedAt: { type: Date, default: null },
    originalQueuedAt: { type: Date, default: null },
    lastDailyReset: { type: Date, default: null },
    dailyReferralCutsToday: { type: Number, default: 0 },
    dailyReferralResetAt: { type: Date, default: null },
    firstSwapCompleted: { type: Boolean, default: false },
    totalRejectCount: { type: Number, default: 0 },
    totalApprovedCount: { type: Number, default: 0 },
    lastRejectAt: { type: Date, default: null },
    cooldownCount: { type: Number, default: 0 },
    isFlagged: { type: Boolean, default: false },
    weeklyRejectWindowStart: { type: Date, default: null },
    weeklyRejectWindowCount: { type: Number, default: 0 },
    noResponseStrikeCount: { type: Number, default: 0 },
    noResponseStrikeWindowStart: { type: Date, default: null },
    tiktokUsernameLocked: { type: Boolean, default: false },
    tiktokLockedAt: { type: Date, default: null },
    usernameConflictReset: { type: Boolean, default: false },
    lastResetNotifiedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

userSchema.index({ state: 1 });
userSchema.index({ isWaiting: 1 });
userSchema.index({ queuedAt: 1 });
userSchema.index({ activeMatchId: 1 });
userSchema.index({ state: 1, isWaiting: 1, activeMatchId: 1, queuedAt: 1 });

export const User = mongoose.model<IUser>("User", userSchema);
