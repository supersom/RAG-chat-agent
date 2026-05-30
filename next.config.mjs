/** @type {import('next').NextConfig} */
const nextConfig = {
  env: {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
    BAWS_ACCESS_KEY_ID: process.env.BAWS_ACCESS_KEY_ID,
    BAWS_SECRET_ACCESS_KEY: process.env.BAWS_SECRET_ACCESS_KEY,
    COMPANY_NAME: process.env.COMPANY_NAME,
  },
  experimental: {
    serverComponentsExternalPackages: ["@aws-sdk/client-bedrock-agent-runtime"],
  },
  webpack: (config, { isServer }) => {
    if (isServer) {
      config.externals.push({
        "@aws-sdk/client-bedrock-agent-runtime":
          "commonjs @aws-sdk/client-bedrock-agent-runtime",
      });
    }
    return config;
  },
};

export default nextConfig;
