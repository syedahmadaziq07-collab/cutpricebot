import mongoose, { type Document } from "mongoose";

export interface IReferral extends Document {
  referralCode: string;
  referrerId: number;
  referredId: number;
  rewardGranted: boolean;
  rewardGrantedAt: Date | null;
  createdAt: Date;
}

const referralSchema = new mongoose.Schema<IReferral>(
  {
    referralCode: { type: String, required: true },
    referrerId: { type: Number, required: true },
    referredId: { type: Number, required: true },
    rewardGranted: { type: Boolean, default: false },
    rewardGrantedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

export const Referral = mongoose.model<IReferral>("Referral", referralSchema);
