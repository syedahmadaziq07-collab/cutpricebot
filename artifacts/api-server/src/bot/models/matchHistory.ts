import mongoose, { type Document } from "mongoose";

export interface IMatchHistory extends Document {
  userIdA: number;
  userIdB: number;
  pairKey: string;
  matchedAt: Date;
}

const matchHistorySchema = new mongoose.Schema<IMatchHistory>({
  userIdA: { type: Number, required: true },
  userIdB: { type: Number, required: true },
  pairKey: { type: String, required: true },
  matchedAt: { type: Date, required: true, default: Date.now },
});

matchHistorySchema.index({ pairKey: 1, matchedAt: -1 });
matchHistorySchema.index({ userIdA: 1, userIdB: 1, matchedAt: -1 });
matchHistorySchema.index({ userIdB: 1, userIdA: 1, matchedAt: -1 });

export const MatchHistory = mongoose.model<IMatchHistory>(
  "MatchHistory",
  matchHistorySchema,
);
