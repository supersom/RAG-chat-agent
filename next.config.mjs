/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverComponentsExternalPackages: ["@aws-sdk/client-bedrock-agent-runtime", "better-sqlite3"],
  },
  webpack: (config, { isServer }) => {
    if (isServer) {
      config.externals.push({
        "@aws-sdk/client-bedrock-agent-runtime":
          "commonjs @aws-sdk/client-bedrock-agent-runtime",
        "better-sqlite3": "commonjs better-sqlite3",
      });
    }
    return config;
  },
};

export default nextConfig;
