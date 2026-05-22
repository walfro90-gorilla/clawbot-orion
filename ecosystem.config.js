// PM2 ecosystem — Orion + Prometheus + Extension Bridge
// FASE 2.1: añadido extension-bridge para WebSocket entre Chrome Extension y server.

module.exports = {
  apps: [
    {
      name:        'xvfb',
      script:      '/usr/bin/Xvfb',
      args:        ':99 -screen 0 1280x800x24 -ac +extension RANDR -nolisten tcp -dpi 96',
      autorestart: true,
      max_restarts: 10,
      interpreter: 'none',
    },
    {
      name:        'cookie-server',
      cwd:         '/root/clawbot/apps/prometheus',
      script:      'cookie-server.js',
      interpreter: 'node',
      autorestart: true,
      env: { NODE_ENV: 'production', DISPLAY: ':99' },
    },
    {
      name:        'prometheus-scheduler',
      cwd:         '/root/clawbot/apps/prometheus',
      script:      'scheduler.js',
      interpreter: 'node',
      autorestart: true,
      env: { NODE_ENV: 'production', DISPLAY: ':99' },
    },
    {
      name:        'extension-bridge',
      cwd:         '/root/clawbot/apps/prometheus',
      script:      'extension-bridge.js',
      interpreter: 'node',
      autorestart: true,
      max_restarts: 10,
      env: { NODE_ENV: 'production' },
    },
    {
      name:        'orion',
      cwd:         '/root/clawbot/apps/orion',
      script:      'npm',
      args:        'start',
      interpreter: 'none',
      autorestart: true,
      env: { NODE_ENV: 'production', DISPLAY: ':99' },
    },
  ],
};
