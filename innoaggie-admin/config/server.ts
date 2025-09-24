export default ({ env }) => ({
  host: env('HOST', '0.0.0.0'),
  port: env.int('PORT', 1337),

  // This is the public-facing URL that Strapi will use when generating links
  // (reset password emails, admin calls back, etc.)
  url: env('PUBLIC_URL', 'https://innoaggie.com'),

  // Important when running behind Nginx/Traefik/ELB — makes Strapi honor
  // X-Forwarded-* headers and not think it's always http://localhost:1337
  proxy: true,

  app: {
    keys: env.array('APP_KEYS'),
  },
});