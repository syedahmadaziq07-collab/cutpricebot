import mongoose, { type Document } from "mongoose";

export interface IMatch extends Document {
  user1Id: number;
  user2Id: number;
  link1: string;
  link2: string;
  status: "active" | "completed" | "expired";
  user1Confirmed: boolean;
  user2Confirmed: boolean;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const matchSchema = new mongoose.Schema<IMatch>(
  {
    user1Id: { type: Number, required: true },
    user2Id: { type: Number, required: true },
    link1: { type: String, default: "" },
    link2: { type: String, default: "" },
    status: {
      type: String,
      enum: ["active", "completed", "expired"],
      default: "active",
    },
    user1Confirmed: { type: Boolean, default: false },
    user2Confirmed: { type: Boolean, default: false },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true },
);

export const Match = mongoose.model<IMatch>("Match", matchSchema);
