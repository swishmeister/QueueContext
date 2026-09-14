import type { NextConfig } from 'next';

const collectorPort = process.env.QUEUE_CONTEXT_COLLECTOR_PORT || '8766';

const nextConfig: NextConfig = {
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: `http://127.0.0.1:${collectorPort}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
