import { config as loadDotenv } from "dotenv";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { NextConfig } from "next";

for (const file of [
  resolve(process.cwd(), ".env.local"),
  resolve(process.cwd(), ".env"),
  resolve(process.cwd(), "../.env"),
]) {
  if (existsSync(file)) {
    loadDotenv({ path: file, override: false, quiet: true });
  }
}

const nextConfig: NextConfig = {
  reactStrictMode: true,
};

export default nextConfig;
