import mongoose, { type Document } from "mongoose";

export interface IMatch extends Document {
  user1Id: number;
  user2Id: number;
  link1: string;
  link2: string;
  status: "pending_ready" | "active" | "completed" | "expired" | "cancelled";
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

  user1ProofCutByUsername: string | null;
  user2ProofCutByUsername: string | null;

  user1ReadyToCut: boolean;
  user2ReadyToCut: boolean;
  user1ReadyAt: Date | null;
  user2ReadyAt: Date | null;
  linkRevealed: boolean;
  linkRevealedAt: Date | null;
  readyTimeoutAt: Date | null;
}

const matchSchema = new mongoose.Schema<IMatch>(
  {
    user1Id: { type: Number, required: true },
    user2Id: { type: Number, required: true },
    link1: { type: String, default: "" },
    link2: { type: String, default: "" },
    status: {
      type: String,
      enum: ["pending_ready", "active", "completed", "expired", "cancelled"],
      default: "pending_ready",
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

    user1ProofCutByUsername: { type: String, default: null },
    user2ProofCutByUsername: { type: String, default: null },

    user1ReadyToCut: { type: Boolean, default: false },
    user2ReadyToCut: { type: Boolean, default: false },
    user1ReadyAt: { type: Date, default: null },
    user2ReadyAt: { type: Date, default: null },
    linkRevealed: { type: Boolean, default: false },
    linkRevealedAt: { type: Date, default: null },
    readyTimeoutAt: { type: Date, default: null },
  },
  { timestamps: true },
);

export const Match = mongoose.model<IMatch>("Match", matchSchema);
