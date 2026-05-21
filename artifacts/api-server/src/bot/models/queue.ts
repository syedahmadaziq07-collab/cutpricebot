import mongoose, { type Document } from "mongoose";

export interface IQueue extends Document {
  telegramId: number;
  pendingLink: string;
  createdAt: Date;
}

const queueSchema = new mongoose.Schema<IQueue>({
  telegramId: { type: Number, required: true, unique: true },
  pendingLink: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
});

export const Queue = mongoose.model<IQueue>("Queue", queueSchema);
