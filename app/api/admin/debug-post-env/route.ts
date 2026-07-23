import { NextResponse } from "next/server";

export async function POST() {
  return NextResponse.json({
    hasBawsAccessKeyId: !!process.env.BAWS_ACCESS_KEY_ID,
    bawsAccessKeyIdLen: process.env.BAWS_ACCESS_KEY_ID?.length ?? 0,
    hasBawsSecretAccessKey: !!process.env.BAWS_SECRET_ACCESS_KEY,
    bawsSecretAccessKeyLen: process.env.BAWS_SECRET_ACCESS_KEY?.length ?? 0,
    region: process.env.AWS_REGION || process.env.BAWS_REGION || "unset",
  });
}
