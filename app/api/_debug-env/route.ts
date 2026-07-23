export async function GET() {
  return Response.json({
    hasBawsAccessKeyId: !!process.env.BAWS_ACCESS_KEY_ID,
    bawsAccessKeyIdLen: (process.env.BAWS_ACCESS_KEY_ID || "").length,
    hasBawsSecretAccessKey: !!process.env.BAWS_SECRET_ACCESS_KEY,
    bawsSecretAccessKeyLen: (process.env.BAWS_SECRET_ACCESS_KEY || "").length,
    hasDynamoTable: !!process.env.DYNAMODB_TENANTS_TABLE,
    dynamoTableValue: process.env.DYNAMODB_TENANTS_TABLE || null,
    hasAuthSecret: !!process.env.AUTH_SECRET,
    nodeEnv: process.env.NODE_ENV,
    awsRegionRaw: process.env.AWS_REGION || null,
    bawsRegionRaw: process.env.BAWS_REGION || null,
  });
}
