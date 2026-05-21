import mongoose, { type Document } from "mongoose";

export interface IMatch extends Document {
  user1Id: number;
  user2Id: number;
  link1: string;
  link2: string;
  status: "active" | "completed" | "expired" | "cancelled";
  user1Confirmed: boolean;
  user2Confirmed: boolean;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;

  user1ProofSubmitted: boolean;
  user1ProofApprovedByPartner: boolean;
  user1ProofMessageId: string | null;
  user1ProofSubmittedAt: Date | null;

  user2ProofSubmitted: boolean;
  user2ProofApprovedByPartner: boolean;
  user2ProofMessageId: string | null;
  user2ProofSubmittedAt: Date | null;
}

const matchSchema = new mongoose.Schema<IMatch>(
  {
    user1Id: { type: Number, required: true },
    user2Id: { type: Number, required: true },
    link1: { type: String, default: "" },
    link2: { type: String, default: "" },
    status: {
      type: String,
      enum: ["active", "completed", "expired", "cancelled"],
      default: "active",
    },
    user1Confirmed: { type: Boolean, default: false },
    user2Confirmed: { type: Boolean, default: false },
    expiresAt: { type: Date, required: true },

    user1ProofSubmitted: { type: Boolean, default: false },
    user1ProofApprovedByPartner: { type: Boolean, default: false },
    user1ProofMessageId: { type: String, default: null },
    user1ProofSubmittedAt: { type: Date, default: null },

    user2ProofSubmitted: { type: Boolean, default: false },
    user2ProofApprovedByPartner: { type: Boolean, default: false },
    user2ProofMessageId: { type: String, default: null },
    user2ProofSubmittedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

export const Match = mongoose.model<IMatch>("Match", matchSchema);
