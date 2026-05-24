import mongoose, { type Document } from "mongoose";

export interface IQueue extends Document {
  telegramId: number;
  telegramUsername: string;
  telegramName: string;
  tiktokUsername: string;
  pendingLink: string;
  status: "waiting" | "matched" | "cancelled";
  createdAt: Date;
  updatedAt: Date;
}

const queueSchema = new mongoose.Schema<IQueue>({
  telegramId: { type: Number, required: true, unique: true },
  telegramUsername: { type: String, default: "" },
  telegramName: { type: String, default: "" },
  tiktokUsername: { type: String, default: "" },
  pendingLink: { type: String, required: true },
  status: {
    type: String,
    enum: ["waiting", "matched", "cancelled"],
    default: "waiting",
    index: true,
  },
  createdAt: { type: Date, default: Date.now, index: true },
  updatedAt: { type: Date, default: Date.now },
});

export const Queue = mongoose.model<IQueue>("Queue", queueSchema);
