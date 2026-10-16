// ESLint 9 flat config — The Balance
import nextConfig from "eslint-config-next";

const nextConfigs = Array.isArray(nextConfig) ? nextConfig : [nextConfig];

const config = [
  {
    ignores: [
      ".next/**",
      "node_modules/**",
      "coverage/**",
      "prisma/migrations/**",
    ],
  },
  // eslint-config-next exports an array of config objects (flat config native).
  ...nextConfigs,
  {
    rules: {
      // Allow <img> in 00-01 (no next/image yet); revisit in 00-08.
      "@next/next/no-img-element": "off",
      // Console logs allowed in dev/test; pino is the prod logger.
      "no-console": ["warn", { allow: ["warn", "error"] }],
    },
  },
];

export default config;
