/**
 * PM2 Ecosystem — ClawBot Monorepo
 *
 * Uso:
 *   pm2 start ecosystem.config.cjs          # levanta todos
 *   pm2 start ecosystem.config.cjs --only orion
 *   pm2 start ecosystem.config.cjs --only prometheus-scheduler
 *   pm2 restart all
 *   pm2 save
 */

module.exports = {
  apps: [
    // ── Orion: CRM Frontend ──────────────────────────────────────────────────
    {
      name:          'orion',
      cwd:           './apps/orion',
      script:        'npm',
      args:          'start',
      interpreter:   'none',
      watch:         false,
      restart_delay: 3000,
      max_restarts:  10,
      env: {
        NODE_ENV: 'production',
        PORT:     3000,
      },
    },

    // ── Prometheus Scheduler: orquestador anti-ban ───────────────────────────
    {
      name:          'prometheus-scheduler',
      cwd:           './apps/prometheus',
      script:        'scheduler.js',
      interpreter:   'node',
      watch:         false,
      restart_delay: 10000,   // espera 10s antes de reiniciar si crashea
      max_restarts:  5,        // si crashea 5x en < 15min, para
      min_uptime:    '15m',    // considera estable si vive 15 min
      env: {
        NODE_ENV:  'production',
        DRY_RUN:   'false',
        LIVE_SEND: 'true',
      },
    },
  ],
};
