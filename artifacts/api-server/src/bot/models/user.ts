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
  cancelCooldownUntil: Date | null;
  state: string;
  pendingLink: string | null;
  lastNotifiedAt: Date | null;
  queuedAt: Date | null;
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
    cutBalance: { type: Number, default: 16 },
    strikes: { type: Number, default: 0 },
    suspendedUntil: { type: Date, default: null },
    isBanned: { type: Boolean, default: false },
    lastMatchPartnerId: { type: Number, default: null },
    isWaiting: { type: Boolean, default: false },
    cancelCooldownUntil: { type: Date, default: null },
    state: { type: String, default: "idle" },
    pendingLink: { type: String, default: null },
    lastNotifiedAt: { type: Date, default: null },
    queuedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

export const User = mongoose.model<IUser>("User", userSchema);
