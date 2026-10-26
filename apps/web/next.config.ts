import "./load-root-env";
import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

const nextConfig: NextConfig = {
  output: "standalone",
  async redirects() {
    return [
      { source: "/roadmap/mail", destination: "/solutions/mail", permanent: false },
      { source: "/roadmap/members", destination: "/solutions/asso", permanent: false },
      { source: "/roadmap/:path*", destination: "/#solutions", permanent: false },
    ];
  },
};

export default withNextIntl(nextConfig);
